// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {VOICE_TRACK_MAX_TOTAL_GAIN} from '@app/features/voice/utils/VoiceVolumeUtils';

const logger = new Logger('VoiceSharedAudioContext');

type AudioContextConstructor = typeof AudioContext;

const MASTER_SOFT_CLIP_KNEE = 0.8;
const MASTER_SOFT_CLIP_CURVE_POINTS = 8192;

interface VoiceOutputRoute {
	output: AudioNode;
	hardwareDestination: AudioNode;
	destination: MediaStreamAudioDestinationNode | null;
	element: HTMLAudioElement | null;
	operation: Promise<void>;
}

const voiceOutputRoutes = new WeakMap<AudioContext, VoiceOutputRoute>();

function supportsVoiceOutputElementRouting(): boolean {
	if (typeof HTMLMediaElement === 'undefined' || !('setSinkId' in HTMLMediaElement.prototype)) return false;
	if (typeof navigator === 'undefined') return false;
	const firefoxVersion = Number(/Firefox\/(\d+)/.exec(navigator.userAgent)?.[1]);
	return firefoxVersion >= (/Macintosh|Mac OS X/.test(navigator.userAgent) ? 145 : 123);
}

export function supportsVoiceOutputDeviceSelection(): boolean {
	return (
		(typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype) ||
		supportsVoiceOutputElementRouting()
	);
}

export function canRouteVoiceAudioContextOutput(context: AudioContext): boolean {
	return voiceOutputRoutes.has(context) && supportsVoiceOutputElementRouting();
}

export function setVoiceAudioContextOutput(context: AudioContext, sinkId: string): Promise<void> {
	const route = voiceOutputRoutes.get(context);
	if (!route || !supportsVoiceOutputElementRouting()) return Promise.resolve();
	route.operation = route.operation
		.catch(() => {})
		.then(async () => {
			if (context.state === 'closed') return;
			if (!sinkId) {
				if (!route.destination) return;
				route.output.disconnect(route.destination);
				route.output.connect(route.hardwareDestination);
				route.element?.pause();
				if (route.element) route.element.srcObject = null;
				route.destination.stream.getTracks().forEach((track) => track.stop());
				route.destination = null;
				route.element = null;
				return;
			}
			if (route.element) {
				await route.element.setSinkId(sinkId);
				return;
			}
			const destination = context.createMediaStreamDestination();
			const element = new Audio();
			element.autoplay = true;
			element.srcObject = destination.stream;
			try {
				await element.setSinkId(sinkId);
				await element.play();
				if (voiceOutputRoutes.get(context) !== route) throw new Error('Voice playback context closed');
				route.output.disconnect(route.hardwareDestination);
				route.output.connect(destination);
				route.destination = destination;
				route.element = element;
			} catch (error) {
				element.pause();
				element.srcObject = null;
				destination.stream.getTracks().forEach((track) => track.stop());
				throw error;
			}
		});
	return route.operation;
}

function softClipSample(x: number): number {
	const magnitude = Math.abs(x);
	if (magnitude <= MASTER_SOFT_CLIP_KNEE) return x;
	const over = (magnitude - MASTER_SOFT_CLIP_KNEE) / (1 - MASTER_SOFT_CLIP_KNEE);
	const shaped = MASTER_SOFT_CLIP_KNEE + (1 - MASTER_SOFT_CLIP_KNEE) * Math.tanh(over);
	return x < 0 ? -shaped : shaped;
}

function createVoiceSoftClipCurve(): Float32Array<ArrayBuffer> {
	const curve = new Float32Array(new ArrayBuffer(MASTER_SOFT_CLIP_CURVE_POINTS * Float32Array.BYTES_PER_ELEMENT));
	for (let i = 0; i < MASTER_SOFT_CLIP_CURVE_POINTS; i++) {
		const normalized = (i / (MASTER_SOFT_CLIP_CURVE_POINTS - 1)) * 2 - 1;
		curve[i] = softClipSample(normalized * VOICE_TRACK_MAX_TOTAL_GAIN);
	}
	return curve;
}

export function createVoiceSoftClipNode(context: BaseAudioContext): {input: GainNode; output: WaveShaperNode} | null {
	if (typeof context.createGain !== 'function' || typeof context.createWaveShaper !== 'function') return null;
	const input = context.createGain();
	input.gain.value = 1 / VOICE_TRACK_MAX_TOTAL_GAIN;
	const output = context.createWaveShaper();
	output.curve = createVoiceSoftClipCurve();
	output.oversample = 'none';
	input.connect(output);
	return {input, output};
}

function installMasterSoftClip(context: AudioContext): void {
	const hardwareDestination = context.destination;
	if (!hardwareDestination) return;
	const softClip = createVoiceSoftClipNode(context);
	if (!softClip) return;
	try {
		softClip.output.connect(hardwareDestination);
		Object.defineProperty(context, 'destination', {
			configurable: true,
			get: () => softClip.input,
		});
		const route: VoiceOutputRoute = {
			output: softClip.output,
			hardwareDestination,
			destination: null,
			element: null,
			operation: Promise.resolve(),
		};
		voiceOutputRoutes.set(context, route);
		context.addEventListener('statechange', () => {
			if (context.state !== 'closed') return;
			route.element?.pause();
			if (route.element) route.element.srcObject = null;
			route.destination?.stream.getTracks().forEach((track) => track.stop());
			route.element = null;
			route.destination = null;
			voiceOutputRoutes.delete(context);
		});
	} catch (error) {
		logger.warn('Failed to install master soft clip on shared voice AudioContext', {error});
	}
}

const RESUME_GESTURE_EVENTS = ['pointerdown', 'keydown'] as const;

type SinkableAudioContextOptions = AudioContextOptions & {
	sinkId?: string;
};

let sharedAudioContext: AudioContext | null = null;
let outputDeviceChangeGeneration = 0;
let deviceChangeTrackingInstalled = false;
const contextCreatedAtGeneration = new WeakMap<AudioContext, number>();

function ensureDeviceChangeTracking(): void {
	if (deviceChangeTrackingInstalled) return;
	if (typeof navigator === 'undefined' || !navigator.mediaDevices?.addEventListener) return;
	deviceChangeTrackingInstalled = true;
	navigator.mediaDevices.addEventListener('devicechange', () => {
		outputDeviceChangeGeneration += 1;
	});
}

export function supportsNativeAudioContextSetSinkId(): boolean {
	return typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
}

export function isSharedVoiceAudioContext(context: AudioContext | null | undefined): boolean {
	return context !== null && context !== undefined && context === sharedAudioContext;
}

export function isSharedVoiceAudioContextStale(context: AudioContext): boolean {
	return (contextCreatedAtGeneration.get(context) ?? -1) !== outputDeviceChangeGeneration;
}

export function closeVoiceAudioContext(context: AudioContext | null | undefined): void {
	if (!context || context.state === 'closed') return;
	void context.close().catch((error) => {
		logger.debug('Failed to close previous shared voice AudioContext', {error});
	});
}

export function resolveAudioContextConstructor(): AudioContextConstructor | null {
	if (typeof window === 'undefined') return null;
	const ctor =
		window.AudioContext ||
		(window as typeof window & {webkitAudioContext?: AudioContextConstructor}).webkitAudioContext;
	return ctor ?? null;
}

export function createVoiceAudioContext(options: SinkableAudioContextOptions): AudioContext | null {
	const ctor = resolveAudioContextConstructor();
	if (!ctor) return null;
	try {
		return new ctor(options);
	} catch (error) {
		logger.warn('Failed to construct voice AudioContext', {options, error});
		return null;
	}
}

function isAudioContextPausedState(state: AudioContextState): boolean {
	return state === 'suspended' || (state as string) === 'interrupted';
}

function installPersistentResume(context: AudioContext): void {
	const tryResume = (): void => {
		if (!isAudioContextPausedState(context.state)) return;
		void context.resume().catch((error) => {
			logger.debug('Failed to resume shared voice AudioContext', {error});
		});
	};
	const syncGestureListeners = (): void => {
		if (typeof window === 'undefined') return;
		const shouldArm = isAudioContextPausedState(context.state);
		for (const eventType of RESUME_GESTURE_EVENTS) {
			if (shouldArm) window.addEventListener(eventType, tryResume, {capture: true});
			else window.removeEventListener(eventType, tryResume, {capture: true});
		}
	};
	context.addEventListener('statechange', () => {
		syncGestureListeners();
		if (isAudioContextPausedState(context.state)) {
			tryResume();
		}
	});
	syncGestureListeners();
	if (isAudioContextPausedState(context.state)) {
		tryResume();
	}
}

function initializeSharedVoiceAudioContext(context: AudioContext): AudioContext {
	assert.notEqual(context.state, 'closed', 'shared voice AudioContext must not start closed');
	installMasterSoftClip(context);
	contextCreatedAtGeneration.set(context, outputDeviceChangeGeneration);
	installPersistentResume(context);
	return context;
}

export interface RecreatedSharedVoiceAudioContext {
	context: AudioContext;
	previous: AudioContext | null;
	sinkIdAppliedByConstructor: boolean;
}

export function recreateSharedVoiceAudioContext(
	options: {sinkId?: string} = {},
): RecreatedSharedVoiceAudioContext | null {
	ensureDeviceChangeTracking();
	const previous = sharedAudioContext && sharedAudioContext.state !== 'closed' ? sharedAudioContext : null;
	const requestedSinkId = options.sinkId;
	let next: AudioContext | null = null;
	let sinkIdAppliedByConstructor = false;
	if (requestedSinkId && supportsNativeAudioContextSetSinkId()) {
		next = createVoiceAudioContext({latencyHint: 'interactive', sinkId: requestedSinkId});
		if (next) {
			sinkIdAppliedByConstructor = true;
		}
	}
	if (!next) {
		next = createVoiceAudioContext({latencyHint: 'interactive'});
		sinkIdAppliedByConstructor = !requestedSinkId;
	}
	if (!next) return null;
	sharedAudioContext = initializeSharedVoiceAudioContext(next);
	return {
		context: sharedAudioContext,
		previous,
		sinkIdAppliedByConstructor,
	};
}

export function getSharedVoiceAudioContext(): AudioContext | null {
	ensureDeviceChangeTracking();
	if (sharedAudioContext && sharedAudioContext.state !== 'closed') {
		return sharedAudioContext;
	}
	const created = createVoiceAudioContext({latencyHint: 'interactive'});
	if (!created) return null;
	sharedAudioContext = initializeSharedVoiceAudioContext(created);
	return sharedAudioContext;
}
