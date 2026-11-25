// SPDX-License-Identifier: AGPL-3.0-or-later

import {isPendingMigratedDeviceId} from '@app/features/app/domain_migration/DomainMigrationDeviceRemap';
import {resetCallAudioContext} from '@app/features/notification/utils/SoundUtils';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {
	canRouteVoiceAudioContextOutput,
	closeVoiceAudioContext,
	isSharedVoiceAudioContext,
	isSharedVoiceAudioContextStale,
	recreateSharedVoiceAudioContext,
	setVoiceAudioContextOutput,
	supportsNativeAudioContextSetSinkId,
} from '@app/features/voice/engine/VoiceSharedAudioContext';
import {VoiceTrackKind} from '@app/features/voice/engine/VoiceTrackSource';
import VoiceSettings from '@app/features/voice/state/VoiceSettings';
import {getVoiceAudioDeviceMetadata, voiceDeviceManager} from '@app/features/voice/utils/VoiceDeviceManager';
import type {RemoteAudioTrack, Room} from 'livekit-client';

const logger = new Logger('VoiceOutputDeviceSync');
const DEVICE_CHANGE_DEBOUNCE_MS = 300;
const SET_SINK_ID_TIMEOUT_MS = 2500;

interface SinkableAudioContext extends AudioContext {
	sinkId?:
		| string
		| {
				type: 'none';
		  };
	setSinkId?: (
		sinkId:
			| string
			| {
					type: 'none';
			  },
	) => Promise<void>;
}

type SinkableMediaElement = HTMLMediaElement & {
	setSinkId?: (sinkId: string) => Promise<void>;
};

type AudioContextSwappableRoom = Room & {
	setAudioContext?: (audioContext: AudioContext, outputDeviceId?: string) => Promise<void>;
};

function normalizeSinkIdForBrowserApi(deviceId: string): string {
	return deviceId === 'default' ? '' : deviceId;
}

function isDeviceMissingError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (error.name === 'NotFoundError') return true;
	return /not\s+found/i.test(error.message);
}

function isSinkableAudioContext(value: unknown): value is SinkableAudioContext {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as {setSinkId?: unknown};
	return candidate.setSinkId === undefined || typeof candidate.setSinkId === 'function';
}

function getRoomAudioContext(room: Room): SinkableAudioContext | null {
	const audioContext: unknown = Reflect.get(room, 'audioContext');
	return isSinkableAudioContext(audioContext) ? audioContext : null;
}

function isRoomWebAudioMixEnabled(room: Room): boolean {
	const options: unknown = Reflect.get(room, 'options');
	if (typeof options !== 'object' || options === null) return false;
	return Boolean((options as {webAudioMix?: unknown}).webAudioMix);
}

function supportsMediaElementSetSinkId(): boolean {
	if (typeof HTMLMediaElement === 'undefined') return false;
	return 'setSinkId' in HTMLMediaElement.prototype;
}

function canRoomSwitchAudioOutput(room: Room): boolean {
	if (!isRoomWebAudioMixEnabled(room)) return supportsMediaElementSetSinkId();
	const audioContext = getRoomAudioContext(room);
	if (!audioContext) return true;
	return typeof audioContext.setSinkId === 'function' || canRouteVoiceAudioContextOutput(audioContext);
}

function resolveLiveKitSwitchDeviceId(room: Room, deviceId: string): string {
	if (isRoomWebAudioMixEnabled(room)) return deviceId;
	return normalizeSinkIdForBrowserApi(deviceId);
}

function isSinkableMediaElement(value: unknown): value is SinkableMediaElement {
	if (typeof HTMLMediaElement === 'undefined') return false;
	return value instanceof HTMLMediaElement;
}

function getAttachedElements(track: RemoteAudioTrack | undefined): ReadonlyArray<SinkableMediaElement> {
	if (!track) return [];
	const attachedElements: unknown = Reflect.get(track, 'attachedElements');
	if (!Array.isArray(attachedElements)) return [];
	return attachedElements.filter(isSinkableMediaElement);
}

function getOutputDeviceTopologySignature(devices: ReadonlyArray<MediaDeviceInfo>): string {
	return devices
		.map((device) => {
			const metadata = getVoiceAudioDeviceMetadata(device);
			return `${device.deviceId}\0${metadata?.role ?? ''}\0${metadata?.endpointLabel ?? device.label}`;
		})
		.join('\n');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function resolveAvailableOutputDeviceId(deviceId: string, onFallbackToDefault?: () => void): Promise<string> {
	if (deviceId === 'default') {
		return deviceId;
	}
	let state = await voiceDeviceManager.ensureDevices({requestPermissions: false});
	const currentDeviceId = VoiceSettings.getOutputDeviceId();
	if (currentDeviceId !== deviceId) {
		return currentDeviceId;
	}
	if (state.outputDevices.length === 0) {
		return deviceId;
	}
	if (state.outputDevices.some((device) => device.deviceId === deviceId)) {
		return deviceId;
	}
	// Refresh once before assuming the device is gone so a newly plugged-in output
	// device is not discarded due to a stale cache.
	state = await voiceDeviceManager.ensureDevices({requestPermissions: false, forceRefresh: true});
	const refreshedCurrentDeviceId = VoiceSettings.getOutputDeviceId();
	if (refreshedCurrentDeviceId !== deviceId) {
		return refreshedCurrentDeviceId;
	}
	if (state.outputDevices.length === 0) {
		return deviceId;
	}
	if (state.outputDevices.some((device) => device.deviceId === deviceId)) {
		return deviceId;
	}
	if (isPendingMigratedDeviceId(deviceId)) {
		return 'default';
	}
	logger.warn('Selected audio output device no longer available; falling back to default', {deviceId});
	onFallbackToDefault?.();
	VoiceSettings.updateSettings({outputDeviceId: 'default'});
	return 'default';
}

function fallbackOutputSettingToDefault(deviceId: string, onFallbackToDefault?: () => void): void {
	if (
		deviceId !== 'default' &&
		VoiceSettings.getOutputDeviceId() === deviceId &&
		!isPendingMigratedDeviceId(deviceId)
	) {
		onFallbackToDefault?.();
		VoiceSettings.updateSettings({outputDeviceId: 'default'});
	}
}

async function applySinkToAudioContext(
	audioContext: SinkableAudioContext,
	deviceId: string,
	sinkId: string,
	onFallbackToDefault?: () => void,
): Promise<string> {
	const applySink = (targetSinkId: string) =>
		audioContext.setSinkId
			? withTimeout(audioContext.setSinkId(targetSinkId), SET_SINK_ID_TIMEOUT_MS, 'AudioContext.setSinkId')
			: setVoiceAudioContextOutput(audioContext, targetSinkId);
	try {
		await applySink(sinkId);
		return sinkId;
	} catch (error) {
		if (isDeviceMissingError(error)) {
			logger.warn('Web Audio mixer sink no longer available', {deviceId});
			if (deviceId !== 'default') {
				fallbackOutputSettingToDefault(deviceId, onFallbackToDefault);
				try {
					await applySink('');
					return '';
				} catch (fallbackError) {
					logger.warn('Failed to fall back Web Audio mixer sink to default', {deviceId, error: fallbackError});
				}
			}
			return sinkId;
		}
		throw error;
	}
}

function ensureAttachedAudioElementsPlaying(room: Room): void {
	room.remoteParticipants.forEach((participant) => {
		participant.audioTrackPublications.forEach((publication) => {
			if (publication.kind !== VoiceTrackKind.Audio) return;
			const track = publication.track as RemoteAudioTrack | undefined;
			for (const element of getAttachedElements(track)) {
				if (element.paused) {
					void element.play().catch((error) => {
						logger.debug('Failed to resume muted audio element after output switch', {error});
					});
				}
			}
		});
	});
}

async function applyOutputDeviceToAttachedElements(room: Room, deviceId: string): Promise<void> {
	const sinkId = normalizeSinkIdForBrowserApi(deviceId);
	const operations: Array<Promise<void>> = [];
	room.remoteParticipants.forEach((participant) => {
		participant.audioTrackPublications.forEach((publication) => {
			if (publication.kind !== VoiceTrackKind.Audio) return;
			const track = publication.track as RemoteAudioTrack | undefined;
			if (track?.kind === VoiceTrackKind.Audio && typeof track.setSinkId === 'function') {
				operations.push(track.setSinkId(sinkId));
				return;
			}
			for (const element of getAttachedElements(track)) {
				if (typeof element.setSinkId === 'function') {
					operations.push(element.setSinkId(sinkId));
				}
			}
		});
	});
	const results = await Promise.allSettled(operations);
	for (const result of results) {
		if (result.status !== 'rejected') continue;
		if (isDeviceMissingError(result.reason)) {
			logger.warn('Audio element sink no longer available', {deviceId});
			continue;
		}
		logger.warn('Failed to apply audio output device to attached audio element', {deviceId, error: result.reason});
	}
}

// Fork patch (jdburton91/fluxer): on Windows/Chromium, hot-switching an existing
// AudioContext across Bluetooth or WASAPI device changes can leave it permanently
// silent even after changing outputs in settings or rejoining a channel. Recreate the
// shared AudioContext directly on the target sink and hot-swap it into the active room.
async function applyOutputDeviceToSharedWebAudioRoom(
	room: AudioContextSwappableRoom,
	deviceId: string,
	options: {recreateContext: boolean; isDisposed: () => boolean; onFallbackToDefault: () => void},
): Promise<void> {
	const currentContext = getRoomAudioContext(room);
	if (!currentContext || !isSharedVoiceAudioContext(currentContext) || typeof room.setAudioContext !== 'function') {
		return;
	}
	const sinkId = normalizeSinkIdForBrowserApi(deviceId);
	const nativeSink = supportsNativeAudioContextSetSinkId();
	const currentSinkId = typeof currentContext.sinkId === 'string' ? currentContext.sinkId : '';
	const needsRecreate =
		options.recreateContext ||
		isSharedVoiceAudioContextStale(currentContext) ||
		currentContext.state !== 'running' ||
		(nativeSink && currentSinkId !== sinkId);

	if (!needsRecreate) {
		if (!nativeSink) {
			await applySinkToAudioContext(currentContext, deviceId, sinkId, options.onFallbackToDefault);
		}
		ensureAttachedAudioElementsPlaying(room);
		return;
	}

	const recreated = recreateSharedVoiceAudioContext({sinkId});
	if (!recreated) {
		logger.warn('Failed to recreate shared voice AudioContext; falling back to in-place setSinkId', {deviceId});
		await applySinkToAudioContext(currentContext, deviceId, sinkId, options.onFallbackToDefault);
		ensureAttachedAudioElementsPlaying(room);
		return;
	}

	const nextContext = recreated.context as SinkableAudioContext;
	let appliedSinkId = sinkId;
	if (!nativeSink) {
		appliedSinkId = await applySinkToAudioContext(nextContext, deviceId, sinkId, options.onFallbackToDefault);
	} else if (
		!recreated.sinkIdAppliedByConstructor ||
		(typeof nextContext.sinkId === 'string' && nextContext.sinkId !== sinkId)
	) {
		try {
			appliedSinkId = await applySinkToAudioContext(nextContext, deviceId, sinkId, options.onFallbackToDefault);
		} catch (error) {
			logger.warn('Failed to apply sinkId to recreated AudioContext; continuing with default sink', {
				deviceId,
				error,
			});
			appliedSinkId = '';
		}
	}

	if (appliedSinkId !== '' && nativeSink) {
		const handleContextError = (): void => {
			nextContext.removeEventListener('error', handleContextError);
			if (nextContext.state === 'closed') return;
			logger.warn('AudioContext reported a hardware sink error; falling back to default output', {deviceId});
			fallbackOutputSettingToDefault(deviceId);
			void nextContext.setSinkId?.('').catch((fallbackError) => {
				logger.warn('Failed to fall back errored AudioContext to default sink', {error: fallbackError});
			});
		};
		nextContext.addEventListener('error', handleContextError, {once: true});
	}

	if (options.isDisposed()) {
		closeVoiceAudioContext(recreated.previous);
		return;
	}

	try {
		await room.setAudioContext(nextContext, appliedSinkId);
		ensureAttachedAudioElementsPlaying(room);
	} finally {
		closeVoiceAudioContext(recreated.previous);
		resetCallAudioContext();
	}
}

async function applyOutputDeviceToRoom(
	room: Room,
	deviceId: string,
	options: {recreateContext: boolean; isDisposed: () => boolean; onFallbackToDefault: () => void},
): Promise<void> {
	const resolvedDeviceId = await resolveAvailableOutputDeviceId(deviceId, options.onFallbackToDefault);
	if (options.isDisposed()) return;
	if (!canRoomSwitchAudioOutput(room)) {
		logger.warn('Audio output selection is unavailable: this browser cannot move the voice playback sink', {
			deviceId: resolvedDeviceId,
			webAudioMix: isRoomWebAudioMixEnabled(room),
		});
		return;
	}
	const swappableRoom = room as AudioContextSwappableRoom;
	const roomAudioContext = getRoomAudioContext(room);
	if (
		isRoomWebAudioMixEnabled(room) &&
		roomAudioContext &&
		isSharedVoiceAudioContext(roomAudioContext) &&
		typeof swappableRoom.setAudioContext === 'function'
	) {
		try {
			await applyOutputDeviceToSharedWebAudioRoom(swappableRoom, resolvedDeviceId, options);
		} catch (error) {
			logger.warn('Failed to sync audio output device to shared Web Audio mixer', {
				deviceId: resolvedDeviceId,
				error,
			});
		}
		return;
	}
	try {
		if (!isRoomWebAudioMixEnabled(room) || roomAudioContext?.setSinkId) {
			await room.switchActiveDevice('audiooutput', resolveLiveKitSwitchDeviceId(room, resolvedDeviceId));
		}
	} catch (error) {
		logger.warn('LiveKit failed to apply audio output device', {deviceId: resolvedDeviceId, error});
	}
	if (options.isDisposed()) return;
	if (isRoomWebAudioMixEnabled(room) && roomAudioContext && !roomAudioContext.setSinkId) {
		try {
			await applySinkToAudioContext(
				roomAudioContext,
				resolvedDeviceId,
				normalizeSinkIdForBrowserApi(resolvedDeviceId),
				options.onFallbackToDefault,
			);
		} catch (error) {
			logger.warn('Failed to apply audio output device to Web Audio mixer', {deviceId: resolvedDeviceId, error});
		}
	}
	if (!isRoomWebAudioMixEnabled(room) || !roomAudioContext) {
		try {
			await applyOutputDeviceToAttachedElements(room, resolvedDeviceId);
		} catch (error) {
			logger.warn('Failed to apply audio output device to attached audio elements', {
				deviceId: resolvedDeviceId,
				error,
			});
		}
	} else {
		ensureAttachedAudioElementsPlaying(room);
	}
}

export function bindOutputDeviceSync(room: Room): () => void {
	let disposed = false;
	let inFlight = false;
	let pendingSync: {deviceId: string; recreateContext: boolean} | null = null;
	let deviceChangeTimer: ReturnType<typeof setTimeout> | null = null;
	const initial = VoiceSettings.getOutputDeviceId();
	let previousDeviceId = initial;

	const scheduleSync = (deviceId: string, recreateContext: boolean): void => {
		if (disposed || !deviceId) return;
		pendingSync = {
			deviceId,
			recreateContext: recreateContext || (pendingSync?.recreateContext ?? false),
		};
		if (inFlight) return;
		inFlight = true;
		void (async () => {
			try {
				while (!disposed && pendingSync !== null) {
					const next = pendingSync;
					pendingSync = null;
					try {
						await applyOutputDeviceToRoom(room, next.deviceId, {
							recreateContext: next.recreateContext,
							isDisposed: () => disposed,
							onFallbackToDefault: () => {
								previousDeviceId = 'default';
							},
						});
					} catch (error) {
						logger.warn('Audio output sync failed', {deviceId: next.deviceId, error});
					}
				}
			} finally {
				inFlight = false;
			}
		})();
	};

	if (initial) {
		scheduleSync(initial, false);
	}

	const unsubscribeSettings = VoiceSettings.subscribe(() => {
		const deviceId = VoiceSettings.getOutputDeviceId();
		if (!deviceId || deviceId === previousDeviceId) return;
		previousDeviceId = deviceId;
		if (deviceChangeTimer !== null) {
			clearTimeout(deviceChangeTimer);
			deviceChangeTimer = null;
		}
		scheduleSync(deviceId, true);
	});

	let hasBaselineOutputDevices = false;
	let previousOutputSignature = '';
	const unsubscribeDevices = voiceDeviceManager.subscribe((state) => {
		if (disposed) return;
		const signature = getOutputDeviceTopologySignature(state.outputDevices);
		if (!hasBaselineOutputDevices) {
			if (state.outputDevices.length > 0) {
				hasBaselineOutputDevices = true;
				previousOutputSignature = signature;
			}
			return;
		}
		if (signature === previousOutputSignature) return;
		previousOutputSignature = signature;
		if (deviceChangeTimer !== null) {
			clearTimeout(deviceChangeTimer);
		}
		deviceChangeTimer = setTimeout(() => {
			deviceChangeTimer = null;
			if (disposed) return;
			const deviceId = VoiceSettings.getOutputDeviceId();
			if (deviceId) {
				scheduleSync(deviceId, true);
			}
		}, DEVICE_CHANGE_DEBOUNCE_MS);
	});

	return () => {
		disposed = true;
		pendingSync = null;
		if (deviceChangeTimer !== null) {
			clearTimeout(deviceChangeTimer);
			deviceChangeTimer = null;
		}
		unsubscribeSettings();
		unsubscribeDevices();
	};
}
