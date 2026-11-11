// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Streaming DSP around the DPDFNet ONNX model (fork patch, jdburton91/fluxer).
 *
 * The model takes one STFT frame (481 complex bins of a 960-sample Vorbis-windowed frame at
 * 48 kHz) plus a flat state vector, and returns the enhanced frame and the next state. This
 * class does the rest: the causal STFT with 50% overlap, the inverse STFT with overlap-add, and
 * the strength blend, in which the enhanced signal is mixed with the input delayed to line up
 * with it. It mirrors `StreamEnhancer` in the `dpdfnet` Python package (0.6.0).
 *
 * It has no browser dependencies, so it runs in the worker and in tests.
 */

export const DPDFNET_SAMPLE_RATE = 48_000;
export const DPDFNET_WINDOW_LENGTH = 960;
export const DPDFNET_HOP_LENGTH = 480;
export const DPDFNET_FREQ_BINS = DPDFNET_WINDOW_LENGTH / 2 + 1;

/**
 * Samples between an input sample entering processHop and the same sample leaving it (50 ms):
 * one hop from the overlap-add plus the model's four-frame lookahead, the same four frames the
 * reference implementation aligns its attenuation limit to. Measured with a gliding harmonic
 * tone; the dry signal in the strength blend is delayed by this much.
 */
export const DPDFNET_LATENCY_SAMPLES = 5 * DPDFNET_HOP_LENGTH;

export interface DpdfnetStateInit {
	readonly stateSize: number;
	readonly erbNormInit: ReadonlyArray<number>;
	readonly specNormInit: ReadonlyArray<number>;
}

export interface DpdfnetModelOutput {
	readonly spec: Float32Array;
	readonly state: Float32Array;
}

/** Runs one model step: spec is [1, 1, 481, 2] (real, imaginary interleaved), state is flat. */
export type DpdfnetModelStep = (spec: Float32Array, state: Float32Array) => Promise<DpdfnetModelOutput>;

export function buildDpdfnetInitialState(init: DpdfnetStateInit): Float32Array {
	const state = new Float32Array(init.stateSize);
	state.set(init.erbNormInit, 0);
	state.set(init.specNormInit, init.erbNormInit.length);
	return state;
}

function vorbisWindow(length: number): Float32Array {
	const half = length / 2;
	const window = new Float32Array(length);
	for (let n = 0; n < length; n++) {
		const s = Math.sin((0.5 * Math.PI * (n + 0.5)) / half);
		window[n] = Math.sin(0.5 * Math.PI * s * s);
	}
	return window;
}

function factorise(n: number): Array<number> {
	const factors: Array<number> = [];
	let rest = n;
	for (const radix of [4, 2, 3, 5]) {
		while (rest % radix === 0) {
			factors.push(radix);
			rest /= radix;
		}
	}
	if (rest !== 1) throw new Error(`FFT size ${n} has a prime factor above 5`);
	return factors;
}

/** Forward complex FFT for sizes made of 2, 3 and 5 (recursive mixed-radix decimation in time). */
class MixedRadixFft {
	private readonly cos: Float64Array;
	private readonly sin: Float64Array;
	private readonly factors: Array<number>;
	private readonly scratchRe: Float64Array;
	private readonly scratchIm: Float64Array;
	readonly size: number;

	constructor(size: number) {
		this.size = size;
		this.factors = factorise(size);
		this.cos = new Float64Array(size);
		this.sin = new Float64Array(size);
		for (let k = 0; k < size; k++) {
			this.cos[k] = Math.cos((2 * Math.PI * k) / size);
			this.sin[k] = -Math.sin((2 * Math.PI * k) / size);
		}
		this.scratchRe = new Float64Array(size);
		this.scratchIm = new Float64Array(size);
	}

	/** outRe/outIm receive the transform of inRe/inIm. The inputs are not changed. */
	transform(inRe: Float64Array, inIm: Float64Array, outRe: Float64Array, outIm: Float64Array): void {
		this.step(inRe, inIm, 0, 1, this.size, outRe, outIm, 0, 0);
	}

	private step(
		inRe: Float64Array,
		inIm: Float64Array,
		inOffset: number,
		stride: number,
		n: number,
		outRe: Float64Array,
		outIm: Float64Array,
		outOffset: number,
		level: number,
	): void {
		if (n === 1) {
			outRe[outOffset] = inRe[inOffset];
			outIm[outOffset] = inIm[inOffset];
			return;
		}
		const radix = this.factors[level];
		const m = n / radix;
		for (let q = 0; q < radix; q++) {
			this.step(inRe, inIm, inOffset + q * stride, stride * radix, m, outRe, outIm, outOffset + q * m, level + 1);
		}
		const tableStep = this.size / n;
		const tempRe = this.scratchRe;
		const tempIm = this.scratchIm;
		for (let k = 0; k < m; k++) {
			for (let j = 0; j < radix; j++) {
				const index = k + j * m;
				let sumRe = 0;
				let sumIm = 0;
				for (let q = 0; q < radix; q++) {
					const twiddle = ((q * index) % n) * tableStep;
					const wRe = this.cos[twiddle];
					const wIm = this.sin[twiddle];
					const xRe = outRe[outOffset + q * m + k];
					const xIm = outIm[outOffset + q * m + k];
					sumRe += xRe * wRe - xIm * wIm;
					sumIm += xRe * wIm + xIm * wRe;
				}
				tempRe[index] = sumRe;
				tempIm[index] = sumIm;
			}
		}
		for (let i = 0; i < n; i++) {
			outRe[outOffset + i] = tempRe[i];
			outIm[outOffset + i] = tempIm[i];
		}
	}
}

export class DpdfnetFrameProcessor {
	private readonly window = vorbisWindow(DPDFNET_WINDOW_LENGTH);
	private readonly fft = new MixedRadixFft(DPDFNET_WINDOW_LENGTH);
	private readonly frame = new Float32Array(DPDFNET_WINDOW_LENGTH);
	private readonly overlap = new Float32Array(DPDFNET_WINDOW_LENGTH);
	private readonly dry = new Float32Array(DPDFNET_LATENCY_SAMPLES + DPDFNET_HOP_LENGTH);
	private readonly fftInRe = new Float64Array(DPDFNET_WINDOW_LENGTH);
	private readonly fftInIm = new Float64Array(DPDFNET_WINDOW_LENGTH);
	private readonly fftOutRe = new Float64Array(DPDFNET_WINDOW_LENGTH);
	private readonly fftOutIm = new Float64Array(DPDFNET_WINDOW_LENGTH);
	private readonly step: DpdfnetModelStep;
	private readonly initialState: Float32Array;
	private state: Float32Array;
	private dryGain = 0;

	constructor(step: DpdfnetModelStep, initialState: Float32Array) {
		this.step = step;
		this.initialState = initialState;
		this.state = initialState.slice();
	}

	reset(): void {
		this.state = this.initialState.slice();
		this.frame.fill(0);
		this.overlap.fill(0);
		this.dry.fill(0);
	}

	/**
	 * How far noise may be turned down, in dB. At 100 or more the enhanced signal is used alone;
	 * below that, the input is mixed back in at 10^(-dB/20), as DeepFilterNet's limit does.
	 */
	setAttenLimDb(attenLimDb: number): void {
		this.dryGain = !Number.isFinite(attenLimDb) || attenLimDb >= 100 ? 0 : 10 ** (-Math.max(0, attenLimDb) / 20);
	}

	/** Takes 480 new input samples and returns the 480 output samples they complete. */
	async processHop(input: Float32Array): Promise<Float32Array> {
		if (input.length !== DPDFNET_HOP_LENGTH) {
			throw new Error(`DPDFNet expects ${DPDFNET_HOP_LENGTH} samples per hop, got ${input.length}`);
		}
		const hop = DPDFNET_HOP_LENGTH;
		const length = DPDFNET_WINDOW_LENGTH;
		this.frame.copyWithin(0, hop);
		this.frame.set(input, length - hop);
		this.dry.copyWithin(0, hop);
		this.dry.set(input, this.dry.length - hop);

		for (let n = 0; n < length; n++) {
			this.fftInRe[n] = this.frame[n] * this.window[n];
			this.fftInIm[n] = 0;
		}
		this.fft.transform(this.fftInRe, this.fftInIm, this.fftOutRe, this.fftOutIm);
		const spec = new Float32Array(DPDFNET_FREQ_BINS * 2);
		for (let k = 0; k < DPDFNET_FREQ_BINS; k++) {
			spec[2 * k] = this.fftOutRe[k];
			spec[2 * k + 1] = this.fftOutIm[k];
		}

		const result = await this.step(spec, this.state);
		this.state = result.state;
		const enhanced = result.spec;

		// Inverse real FFT through the forward transform: x = conj(FFT(conj(X))) / N, with X
		// rebuilt as a full Hermitian spectrum from its 481 bins.
		for (let k = 0; k < DPDFNET_FREQ_BINS; k++) {
			this.fftInRe[k] = enhanced[2 * k];
			this.fftInIm[k] = -enhanced[2 * k + 1];
		}
		this.fftInIm[0] = 0;
		this.fftInIm[DPDFNET_FREQ_BINS - 1] = 0;
		for (let k = DPDFNET_FREQ_BINS; k < length; k++) {
			this.fftInRe[k] = this.fftInRe[length - k];
			this.fftInIm[k] = -this.fftInIm[length - k];
		}
		this.fft.transform(this.fftInRe, this.fftInIm, this.fftOutRe, this.fftOutIm);
		for (let n = 0; n < length; n++) {
			this.overlap[n] += (this.fftOutRe[n] / length) * this.window[n];
		}

		const output = new Float32Array(hop);
		const dryGain = this.dryGain;
		const wetGain = 1 - dryGain;
		for (let n = 0; n < hop; n++) {
			output[n] = wetGain * this.overlap[n] + dryGain * this.dry[n];
		}
		this.overlap.copyWithin(0, hop);
		this.overlap.fill(0, length - hop);
		return output;
	}
}
