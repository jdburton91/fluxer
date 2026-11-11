// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Messages between the page and the DPDFNet worker (fork patch, jdburton91/fluxer).
 *
 * The audio itself does not pass through the page: `start` hands the worker one end of a
 * MessageChannel whose other end belongs to the AudioWorklet. On that channel the worklet sends
 * 480-sample Float32Array hops, and the worker answers each with an enhanced hop or with
 * `{type: 'error', message}`.
 */

export type DpdfnetWorkerCommand =
	| {readonly type: 'start'; readonly port: MessagePort; readonly attenLimDb: number}
	| {readonly type: 'set-atten-lim'; readonly attenLimDb: number}
	| {readonly type: 'stop'};

export type DpdfnetWorkerEvent = {readonly type: 'ready'} | {readonly type: 'error'; readonly message: string};

export function isDpdfnetWorkerEvent(value: unknown): value is DpdfnetWorkerEvent {
	if (!value || typeof value !== 'object') return false;
	const record = value as Record<string, unknown>;
	if (record.type === 'ready') return true;
	return record.type === 'error' && typeof record.message === 'string';
}
