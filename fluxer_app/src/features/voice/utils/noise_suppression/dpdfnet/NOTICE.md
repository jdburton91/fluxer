# DPDFNet licenses

The model in this directory is a third-party asset added by JD's fork (jdburton91/fluxer). The
app build emits it as a content-hashed asset. It is distributed under the Apache License 2.0; the
license text is in `LICENSE-APACHE`.

| File | Source | Changes |
| --- | --- | --- |
| `dpdfnet2_48khz_hr.onnx` | DPDFNet-2 48 kHz streaming model by Ceva, from the Hugging Face repository `Ceva-IP/DPDFNet`, as downloaded by the `dpdfnet` Python package 0.6.0 | Unmodified. SHA-256 `7f0575a5cec0ba4ffd8f8bd657e06d007e4ccdd955d76faab922b9d3291dc14b`. |
| `Dpdfnet2StateInit.ts` | The model's `state_size`, `erb_norm_init` and `spec_norm_init` metadata | Copied into TypeScript. |
| `DpdfnetFrameProcessor.ts` | Written for the fork after `StreamEnhancer` in the `dpdfnet` Python package 0.6.0 (Apache-2.0) | Causal STFT, Vorbis window and strength blend reimplemented in TypeScript. |

Paper: "DPDFNet" by Ceva (arXiv 2512.16420). No license notice here grants rights to third-party
trademarks or brand names.
