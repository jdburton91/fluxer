// SPDX-License-Identifier: AGPL-3.0-or-later

// DPDFNet AudioWorklet processor (fork patch, jdburton91/fluxer).
//
// The model runs in DpdfnetWorker. This processor cuts the mono input into 480-sample hops,
// sends each to the worker over the MessagePort it receives in a 'connect' message, and plays
// the enhanced hops back. Playback starts once a cushion of audio has built up, so the round trip
// to the worker does not cause gaps; after a gap the cushion grows, up to MAX_CUSHION.

const PROCESSOR_NAME = 'fluxer-dpdfnet';
const RENDER_QUANTUM = 128;
const HOP = 480;
const START_CUSHION = 3 * RENDER_QUANTUM;
const MAX_CUSHION = 4 * HOP;
const RING_SIZE = 16 * HOP;

class DpdfnetProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.workerPort = null;
		this.disposed = false;
		this.failed = false;
		this.hop = new Float32Array(HOP);
		this.hopFill = 0;
		this.ring = new Float32Array(RING_SIZE);
		this.ringRead = 0;
		this.ringWrite = 0;
		this.cushion = START_CUSHION;
		this.playing = false;
		this.port.onmessage = (event) => this.handleControl(event);
	}

	handleControl(event) {
		const message = event.data;
		if (message === 'destroy' || message?.type === 'dispose') {
			this.dispose();
			return;
		}
		if (message?.type === 'connect' && event.ports.length > 0 && this.workerPort == null) {
			this.workerPort = event.ports[0];
			this.workerPort.onmessage = (workerEvent) => this.handleWorker(workerEvent.data);
			this.workerPort.start();
			this.port.postMessage({type: 'ready'});
		}
	}

	handleWorker(data) {
		if (this.disposed) return;
		if (data instanceof Float32Array) {
			this.pushOutput(data);
			return;
		}
		if (data?.type === 'error') this.fail(String(data.message ?? 'DPDFNet worker failed'));
	}

	buffered() {
		return (this.ringWrite - this.ringRead + RING_SIZE) % RING_SIZE;
	}

	pushOutput(samples) {
		if (this.buffered() + samples.length >= RING_SIZE) {
			// The output fell far behind; drop what is queued and start again from fresh audio.
			this.ringRead = this.ringWrite;
			this.playing = false;
		}
		for (let i = 0; i < samples.length; i++) {
			const value = samples[i];
			this.ring[this.ringWrite] = Number.isFinite(value) ? value : 0;
			this.ringWrite = (this.ringWrite + 1) % RING_SIZE;
		}
	}

	fail(message) {
		if (this.failed) return;
		this.failed = true;
		this.port.postMessage({type: 'error', message});
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		if (this.workerPort) {
			this.workerPort.onmessage = null;
			this.workerPort.close();
			this.workerPort = null;
		}
	}

	process(inputs, outputs) {
		if (this.disposed) return false;
		const output = outputs[0]?.[0];
		const input = inputs[0]?.[0];
		if (input && this.workerPort && !this.failed) {
			for (let i = 0; i < input.length; i++) {
				const value = input[i];
				this.hop[this.hopFill++] = Number.isFinite(value) ? value : 0;
				if (this.hopFill === HOP) {
					const hop = this.hop;
					this.workerPort.postMessage(hop, [hop.buffer]);
					this.hop = new Float32Array(HOP);
					this.hopFill = 0;
				}
			}
		}
		if (!output) return true;
		if (!this.playing && this.buffered() >= this.cushion) this.playing = true;
		if (!this.playing) {
			output.fill(0);
			return true;
		}
		const available = this.buffered();
		const count = Math.min(output.length, available);
		for (let i = 0; i < count; i++) {
			output[i] = this.ring[this.ringRead];
			this.ringRead = (this.ringRead + 1) % RING_SIZE;
		}
		if (count < output.length) {
			output.fill(0, count);
			this.playing = false;
			this.cushion = Math.min(MAX_CUSHION, this.cushion + RENDER_QUANTUM);
		}
		return true;
	}
}

registerProcessor(PROCESSOR_NAME, DpdfnetProcessor);
