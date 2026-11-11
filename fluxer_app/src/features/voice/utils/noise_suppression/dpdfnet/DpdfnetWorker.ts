// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * DPDFNet noise suppression worker (fork patch, jdburton91/fluxer).
 *
 * The model is too heavy to run on the audio thread, so the AudioWorklet
 * (dpdfnetProcessor.worklet.js) sends this worker 480-sample hops over a MessagePort and plays
 * back the enhanced hops it returns. The worker loads onnxruntime-web's single-threaded wasm
 * build, which Fluxer already ships for camera effects.
 */

import {resolveWorkerAssetUrl} from '@app/features/platform/utils/WorkerAssetUrl';
import {DPDFNET2_48KHZ_STATE_INIT} from '@app/features/voice/utils/noise_suppression/dpdfnet/Dpdfnet2StateInit';
import {
	buildDpdfnetInitialState,
	DPDFNET_FREQ_BINS,
	DPDFNET_HOP_LENGTH,
	DpdfnetFrameProcessor,
	type DpdfnetModelStep,
} from '@app/features/voice/utils/noise_suppression/dpdfnet/DpdfnetFrameProcessor';
import type {
	DpdfnetWorkerCommand,
	DpdfnetWorkerEvent,
} from '@app/features/voice/utils/noise_suppression/dpdfnet/DpdfnetWorkerProtocol';
import modelUrl from '@app/features/voice/utils/noise_suppression/dpdfnet/dpdfnet2_48khz_hr.onnx';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm';

type DpdfnetWorkerScope = DedicatedWorkerGlobalScope & {close(): void};

const scope = self as unknown as DpdfnetWorkerScope;
// onnxruntime-web resolves its own files against the bundler's base URL, which a worker has to set
// itself (as WebCameraEffectWorker does); without it the session fails with "Invalid URL".
__webpack_base_uri__ = scope.location.href;
const MODEL_MAX_BYTES = 16 * 1024 * 1024;
/** Hops waiting for the model beyond this are dropped, so a slow device falls behind by at most 60 ms. */
const MAX_PENDING_HOPS = 6;

let processor: DpdfnetFrameProcessor | null = null;
let audioPort: MessagePort | null = null;
let attenLimDb = 100;
let failed = false;
const pending: Array<Float32Array> = [];
let draining = false;

function post(event: DpdfnetWorkerEvent): void {
	scope.postMessage(event);
}

function fail(message: string): void {
	if (failed) return;
	failed = true;
	pending.length = 0;
	audioPort?.postMessage({type: 'error', message});
	post({type: 'error', message});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function loadModel(): Promise<Uint8Array> {
	const response = await fetch(resolveWorkerAssetUrl(modelUrl), {
		credentials: 'omit',
		redirect: 'error',
		referrerPolicy: 'no-referrer',
	});
	if (!response.ok) throw new Error(`DPDFNet model request failed with status ${response.status}`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength === 0 || bytes.byteLength > MODEL_MAX_BYTES) {
		throw new Error(`DPDFNet model has an unexpected size of ${bytes.byteLength} bytes`);
	}
	return bytes;
}

async function createModelStep(): Promise<DpdfnetModelStep> {
	const [ort, modelBytes] = await Promise.all([import('onnxruntime-web/wasm'), loadModel()]);
	ort.env.wasm.wasmPaths = {wasm: resolveWorkerAssetUrl(ortWasmUrl)};
	ort.env.wasm.proxy = false;
	ort.env.wasm.numThreads = 1;
	ort.env.logLevel = 'error';
	const session = await ort.InferenceSession.create(modelBytes, {
		executionProviders: ['wasm'],
		graphOptimizationLevel: 'all',
	});
	const specShape = [1, 1, DPDFNET_FREQ_BINS, 2];
	return async (spec, state) => {
		const outputs = await session.run({
			spec: new ort.Tensor('float32', spec, specShape),
			state_in: new ort.Tensor('float32', state, [state.length]),
		});
		const specOut = outputs.spec_e?.data;
		const stateOut = outputs.state_out?.data;
		if (!(specOut instanceof Float32Array) || !(stateOut instanceof Float32Array)) {
			throw new Error('DPDFNet returned no spec_e or state_out tensor');
		}
		return {spec: specOut, state: stateOut};
	};
}

async function drain(): Promise<void> {
	if (draining) return;
	draining = true;
	try {
		while (pending.length > 0 && processor != null && !failed) {
			const hop = pending.shift();
			if (hop == null) break;
			const output = await processor.processHop(hop);
			audioPort?.postMessage(output, [output.buffer]);
		}
	} catch (error) {
		fail(`DPDFNet failed while running: ${errorMessage(error)}`);
	} finally {
		draining = false;
	}
}

function onAudioMessage(event: MessageEvent): void {
	const hop = event.data;
	if (!(hop instanceof Float32Array) || hop.length !== DPDFNET_HOP_LENGTH || failed) return;
	pending.push(hop);
	if (pending.length > MAX_PENDING_HOPS) pending.splice(0, pending.length - MAX_PENDING_HOPS);
	void drain();
}

async function start(port: MessagePort, initialAttenLimDb: number): Promise<void> {
	audioPort = port;
	attenLimDb = initialAttenLimDb;
	port.onmessage = onAudioMessage;
	try {
		const step = await createModelStep();
		processor = new DpdfnetFrameProcessor(step, buildDpdfnetInitialState(DPDFNET2_48KHZ_STATE_INIT));
		processor.setAttenLimDb(attenLimDb);
		// Warm the session up so the first real hops do not arrive late.
		for (let i = 0; i < 4; i++) await processor.processHop(new Float32Array(DPDFNET_HOP_LENGTH));
		processor.reset();
		port.start();
		post({type: 'ready'});
	} catch (error) {
		fail(`DPDFNet could not start: ${errorMessage(error)}`);
	}
}

scope.addEventListener('message', (event: Event) => {
	const command = (event as MessageEvent<DpdfnetWorkerCommand>).data;
	switch (command.type) {
		case 'start':
			void start(command.port, command.attenLimDb);
			return;
		case 'set-atten-lim':
			attenLimDb = command.attenLimDb;
			processor?.setAttenLimDb(attenLimDb);
			return;
		case 'stop':
			failed = true;
			pending.length = 0;
			audioPort?.close();
			scope.close();
			return;
	}
});
