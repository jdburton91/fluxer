// SPDX-License-Identifier: AGPL-3.0-or-later

import {Logger} from '@app/features/platform/utils/AppLogger';
import {makePersistent} from '@app/features/platform/utils/MobXPersistence';
import {initializeStore} from '@app/features/platform/utils/StoreInitialization';
import {makeSyncedField} from '@app/features/user/state/SyncedField';
import {getStreamKey} from '@app/features/voice/components/StreamKeys';
import {getEffectiveAudioState} from '@app/features/voice/engine/VoiceEffectiveAudioState';
import {isScreenShareAudioPublicationLike, VoiceTrackKind} from '@app/features/voice/engine/VoiceTrackSource';
import {getRemoteVoicePlaybackBoost} from '@app/features/voice/state/RemoteVoicePlaybackBoost';
import StreamAudioPrefs from '@app/features/voice/state/StreamAudioPrefs';
import VoiceSettings from '@app/features/voice/state/VoiceSettings';
import {
	clampVoiceTrackTotalGain,
	clampVoiceVolumePercent,
	composeVoiceVolumeGain,
	recalibrateStoredVoiceVolumes,
} from '@app/features/voice/utils/VoiceVolumeUtils';
import {ParticipantVolumeSettingsSchema} from '@fluxer/schema/src/gen/fluxer/user/preferences/v1/preferences_pb';
import type {RemoteAudioTrack, RemoteParticipant, Room} from 'livekit-client';
import {makeAutoObservable} from 'mobx';

const logger = new Logger('ParticipantVolume');
const isRemoteAudioTrack = (track: unknown): track is RemoteAudioTrack =>
	track != null &&
	typeof track === 'object' &&
	'kind' in track &&
	(track as {kind?: unknown}).kind === VoiceTrackKind.Audio;
const idUser = (identity: string): string | null => {
	const m = identity.match(/^user_(\d+)(?:_(.+))?$/);
	return m ? m[1] : null;
};
const idConnection = (identity: string): string | null => {
	const match = identity.match(/^user_(\d+)_(.+)$/);
	return match ? match[2] : null;
};

interface VoiceConnectionContextAccess {
	guildId?: string | null;
	channelId?: string | null;
	connectionId?: string | null;
}

// Fork patch (jdburton91/fluxer): per-person volumes and local mutes also live in the account's
// synced preferences, so an update, a reinstall or another device keeps them. The device copy
// stays as before. Volumes go over the wire as whole percentages.
const PARTICIPANT_VOLUME_SYNC_DEBOUNCE_MS = 1000;

function volumesToWire(volumes: Record<string, number>): Record<string, number> {
	const wire: Record<string, number> = {};
	for (const [userId, volume] of Object.entries(volumes)) {
		if (!Number.isFinite(volume)) continue;
		wire[userId] = Math.round(clampVoiceVolumePercent(volume));
	}
	return wire;
}

function volumesFromWire(volumes: Record<string, number>): Record<string, number> {
	const local: Record<string, number> = {};
	for (const [userId, volume] of Object.entries(volumes)) {
		local[userId] = clampVoiceVolumePercent(volume);
	}
	return local;
}

function getVoiceConnectionContext(): VoiceConnectionContextAccess {
	try {
		const mediaEngine =
			(
				window as typeof window & {
					_mediaEngineFacade?: VoiceConnectionContextAccess;
					_mediaEngine?: VoiceConnectionContextAccess;
				}
			)._mediaEngineFacade ??
			(window as typeof window & {_mediaEngine?: VoiceConnectionContextAccess})._mediaEngine ??
			null;
		return {
			guildId: mediaEngine?.guildId ?? null,
			channelId: mediaEngine?.channelId ?? null,
			connectionId: mediaEngine?.connectionId ?? null,
		};
	} catch (error) {
		logger.error('Failed to read voice connection context from media engine', {error});
		return {guildId: null, channelId: null, connectionId: null};
	}
}

class ParticipantVolume {
	volumes: Record<string, number> = {};
	localMutes: Record<string, boolean> = {};
	outputVolumeRecalibratedV1 = false;
	connectionVolumesByLocalConnectionId: Record<string, Record<string, number>> = {};
	private listeners = new Set<() => void>();

	constructor() {
		makeAutoObservable<this, 'listeners' | 'notifyListeners'>(
			this,
			{
				listeners: false,
				getVolume: false,
				isLocalMuted: false,
				getConnectionVolume: false,
				notifyListeners: false,
			},
			{autoBind: true},
		);
		initializeStore(this, () => this.initPersistence());
	}

	private async initPersistence(): Promise<void> {
		await makePersistent(this, 'ParticipantVolume', ['volumes', 'localMutes', 'outputVolumeRecalibratedV1']);
		this.applyOutputVolumeRecalibration();
		// Fork patch: start syncing only after the device copy has loaded, so a late local load
		// cannot overwrite what the account already holds. A value set on another device wins
		// for that person; people set only here are kept and pushed to the account.
		await makeSyncedField(this, {
			field: 'jdParticipantVolumes',
			schema: ParticipantVolumeSettingsSchema,
			persist: ['volumes', 'localMutes'],
			debounceMs: PARTICIPANT_VOLUME_SYNC_DEBOUNCE_MS,
			toMessage: (store) => ({
				volumes: volumesToWire(store.volumes),
				localMutes: {...store.localMutes},
			}),
			applyMessage: (store, message) => {
				store.volumes = volumesFromWire(message.volumes);
				store.localMutes = {...message.localMutes};
			},
			mergeRemote: (local, incoming) => ({
				volumes: {...local.volumes, ...incoming.volumes},
				localMutes: {...local.localMutes, ...incoming.localMutes},
			}),
		});
	}

	private applyOutputVolumeRecalibration(): void {
		if (this.outputVolumeRecalibratedV1) {
			return;
		}
		this.volumes = recalibrateStoredVoiceVolumes(this.volumes);
		this.outputVolumeRecalibratedV1 = true;
		this.notifyListeners();
	}

	setVolume(userId: string, volume: number): void {
		const clamped = clampVoiceVolumePercent(volume);
		this.volumes = {
			...this.volumes,
			[userId]: clamped,
		};
		this.notifyListeners();
		logger.debug(`Set volume for ${userId}: ${clamped}`);
	}

	setLocalMute(userId: string, muted: boolean): void {
		this.localMutes = {
			...this.localMutes,
			[userId]: muted,
		};
		this.notifyListeners();
		logger.debug(`Set local mute for ${userId}: ${muted}`);
	}

	setConnectionVolume(connectionId: string, volume: number): void {
		const localConnectionId = getVoiceConnectionContext().connectionId;
		if (!localConnectionId || !connectionId) {
			return;
		}
		const clamped = clampVoiceVolumePercent(volume);
		const existingBucket = this.connectionVolumesByLocalConnectionId[localConnectionId] ?? {};
		this.connectionVolumesByLocalConnectionId = {
			...this.connectionVolumesByLocalConnectionId,
			[localConnectionId]: {
				...existingBucket,
				[connectionId]: clamped,
			},
		};
		this.notifyListeners();
		logger.debug(`Set connection volume for ${connectionId} from ${localConnectionId}: ${clamped}`);
	}

	getVolume(userId: string): number {
		return clampVoiceVolumePercent(this.volumes[userId] ?? 100);
	}

	getConnectionVolume(connectionId: string | null): number {
		if (!connectionId) {
			return 100;
		}
		const localConnectionId = getVoiceConnectionContext().connectionId;
		if (!localConnectionId) {
			return 100;
		}
		const bucket = this.connectionVolumesByLocalConnectionId[localConnectionId];
		return clampVoiceVolumePercent(bucket?.[connectionId] ?? 100);
	}

	isLocalMuted(userId: string): boolean {
		return this.localMutes[userId] ?? false;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private notifyListeners(): void {
		for (const listener of [...this.listeners]) {
			listener();
		}
	}

	applySettingsToRoom(room: Room | null): void {
		if (!room) return;
		room.remoteParticipants.forEach((participant) => {
			this.applySettingsToParticipant(participant);
		});
	}

	applySettingsToParticipant(participant: RemoteParticipant): void {
		const userId = idUser(participant.identity);
		if (!userId) return;
		const connectionId = idConnection(participant.identity);
		const connectionContext = getVoiceConnectionContext();
		const streamKey = connectionId
			? getStreamKey(connectionContext.guildId, connectionContext.channelId, connectionId)
			: null;
		const userVolume = this.getVolume(userId);
		const connectionVolume = this.getConnectionVolume(connectionId);
		const outputVolume = VoiceSettings.getOutputVolume();
		const locallyMuted = this.isLocalMuted(userId);
		const {effectiveDeaf} = getEffectiveAudioState();
		participant.audioTrackPublications.forEach((pub) => {
			const isScreenShareAudio = isScreenShareAudioPublicationLike(pub);
			const streamVolume = streamKey ? StreamAudioPrefs.getVolume(streamKey) : 100;
			const streamMuted = streamKey ? StreamAudioPrefs.isMuted(streamKey) : false;
			const baseVolume = isScreenShareAudio
				? composeVoiceVolumeGain(streamVolume, outputVolume)
				: composeVoiceVolumeGain(userVolume, connectionVolume, outputVolume);
			const playbackBoost = isScreenShareAudio ? 1 : getRemoteVoicePlaybackBoost(participant.identity);
			const nextVolume = clampVoiceTrackTotalGain(baseVolume * playbackBoost);
			const shouldDisable = isScreenShareAudio ? streamMuted || effectiveDeaf : locallyMuted || effectiveDeaf;
			logger.debug('Applying remote audio publication prefs', {
				participantIdentity: participant.identity,
				source: pub.source,
				trackName: pub.trackName,
				trackSid: pub.trackSid,
				isScreenShareAudio,
				streamKey,
				streamVolume,
				streamMuted,
				userVolume,
				connectionVolume,
				outputVolume,
				playbackBoost,
				nextVolume,
				locallyMuted,
				effectiveDeaf,
				shouldDisable,
			});
			const track = pub.track;
			if (isRemoteAudioTrack(track)) {
				try {
					track.setVolume(nextVolume);
				} catch (error) {
					logger.warn(`Failed to set remote track volume for participant ${userId}`, {
						error,
						trackSid: pub.trackSid,
					});
				}
			}
			try {
				if (pub.isDesired) {
					pub.setEnabled(!shouldDisable);
				}
			} catch (error) {
				logger.warn(`Failed to apply enabled state for participant ${userId}`, {
					error,
					trackSid: pub.trackSid,
				});
			}
			if (isScreenShareAudio && streamKey && StreamAudioPrefs.hasEntry(streamKey)) {
				try {
					StreamAudioPrefs.touchStream(streamKey);
				} catch (error) {
					logger.warn(`Failed to touch stream audio prefs for participant ${userId}`, {error, streamKey});
				}
			}
		});
	}
}

export default new ParticipantVolume();
