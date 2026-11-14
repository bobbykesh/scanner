# Browser AI repair research — 13 November 2026

## Decision for this release

**Do not bundle a model into Stage 4.1 yet.** Ship the local-tool and memory improvements now. MI-GAN is the first candidate to investigate for Stage 4.2; a quantized LaMa export is a secondary candidate. Neither is approved for reliable document repair or low-memory iPhone 14 use.

No model/runtime is installed, prefetched or executed by the scanner. No document was uploaded during research. The benchmark used a synthetic generated paper-colored image, served locally to a separate research page. Model weights were downloaded from the author's repository for the experiment, not included in the release.

## Candidate 1: MI-GAN pipeline

Primary project: https://github.com/Picsart-AI-Research/MI-GAN

The official README links the author-hosted ONNX pipeline. The official code and weight license files are MIT; preserve notices if redistributed:
- https://github.com/Picsart-AI-Research/MI-GAN/blob/main/LICENSE
- https://github.com/Picsart-AI-Research/MI-GAN/blob/main/LICENSE-WEIGHTS
- https://huggingface.co/andraniksargsyan/migan

Artifact inspected and downloaded:
- Repository revision: `406830d0fa60666da0071c342ad2fbc8f30c5c64`
- File: `migan_pipeline_v2.onnx`
- Size: **28,079,181 bytes** (about 26.78 MiB)
- SHA-256: `6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b`
- Pinned URL: https://huggingface.co/andraniksargsyan/migan/resolve/406830d0fa60666da0071c342ad2fbc8f30c5c64/migan_pipeline_v2.onnx

The official pipeline accepts a uint8 RGB image and a uint8 mask, with **255 meaning keep and 0 meaning remove**. It includes cropping/resizing and postprocessing. Its mask convention is opposite to the LaMa export below—an integration must not interchange them. Model inference is internally based on a 512-pixel model; accepting a 256-pixel input does not imply a 256-pixel internal network.

### Experiment actually performed

ONNX Runtime Web **1.31.1**, WASM execution provider, **one thread**, separate Worker; self-hosted JS/WASM/model on localhost. No cross-origin isolation or WebGPU was needed in this experiment. Only one session/job was run at a time, with explicit tensor/session disposal and worker termination.

Synthetic input: 256×256 cream background RGB **232,223,201**, with a small dark rectangle and a removal mask. This is a feasibility check, not a document-quality benchmark.

| Desktop engine in this sandbox | Session creation | Inference | Result |
| --- | ---: | ---: | --- |
| Chromium | ~881 ms | ~1,925 ms | Executed successfully |
| Playwright WebKit 26.0 | ~2,459 ms | ~1,982 ms | Executed successfully |

Output: uint8 `[1,3,256,256]`, named `result`. The center of the repaired area was RGB **128,118,106**, substantially darker than the original cream paper. Therefore this fixture **does not pass a paper-background matching quality gate**. Successful inference is not enough to approve the feature. Runtime asset download is additional to the model (the tested WASM alone is roughly 15 MB).

Peak process/GPU/WASM memory was not measured; `performance.memory` was unavailable in the worker. Timings are sandbox desktop observations, **not predictions for iPhone 14**. These tests are not real Safari/Chrome on iOS. Evidence is in `research/ai-desktop-result.json` and `research/ai-webkit-result.json`; the benchmark worker is included for inspection, not as a ready-to-run application feature.

## Candidate 2: weight-quantized LaMa

- Base export: https://huggingface.co/Carve/LaMa-ONNX
- Candidate: https://huggingface.co/othytenk/lama-int4-int8
- File: `lama_int4_int8_r4.onnx`
- Repository API reported **36,931,151 bytes**.
- Repository LFS SHA-256: `4e3b78a253eb4abf21896811c928ffa91214b916e5d6ced24cecdd7999b4aaa1`
- Model card and attached license identify Apache-2.0; an actual release must pin a revision, verify downloaded bytes and include full license/attribution notices.

The model card describes fixed 512×512 inputs and weight quantization, but says the runtime folds quantized weights back to FP32 using a session option. **A ~37 MB download is not a ~37 MB RAM budget.** The unquantized source export is **208,044,816 bytes**. Neither LaMa artifact was executed in this research. Model-card browser/performance claims are the publisher's claims, not our verified iPhone results.

## GitHub hosting implications

Official documentation checked:
- https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github
- https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-git-large-file-storage

GitHub's browser uploader permits files up to **25 MiB**, ordinary Git blocks files over **100 MiB**, and published Pages sites have a **1 GB** maximum with a **100 GB/month soft bandwidth limit**. Both smaller candidates exceed the browser uploader's per-file limit, even though they fit the ordinary Git limit. This matters if deployment is done entirely from a phone.

A later phone-friendly package could use verified, modest-sized model parts with a manifest and reconstruct the bytes on demand. That needs explicit memory testing: joining parts can create extra copies. Alternatively use Git to upload the intact artifact. Git LFS is not a drop-in solution for model delivery through Pages. Do not put a heavy model in the service worker's initial `cache.addAll`; it would make every app update expensive and potentially block installation.

## Stage 4.2 acceptance gates

1. Improve or choose a model that passes real paper/text/shadow fixtures without inventing content near the mask; do not silently substitute AI for local covers.
2. Verify license and exact artifact, pin versions/checksums, bundle runtime licenses.
3. Require an explicit Enable/Download action showing full download size. No model on initial app load.
4. Process a bounded crop around the selection, use one job at a time, and composite **only selected pixels** back into the original working-resolution image.
5. Run in a dedicated worker; support cancellation by terminating it and unload via Memory controls. Preserve existing local tools and saved data on all failures.
6. Test loading, inference, repeated jobs, cancellation, memory release and recovery on a **physical iPhone 14 in both Safari and Chrome**. Browser feature detection, not name sniffing; never promise identical performance.
7. Test model caching/removal separately from document storage. A Clear downloaded model control must never clear IndexedDB documents or all site data.
8. Inspect real results before Apply, preserve Undo/Cancel, and never claim secure redaction, original-background recovery or guaranteed invisible repair.

ONNX Runtime deployment reference: https://onnxruntime.ai/docs/tutorials/web/deploy.html

**Bottom line:** browser inference is technically feasible in the desktop experiments. Quality, memory safety and iPhone performance are still open. Stage 4.1 is deliberately model-free while those are resolved.
