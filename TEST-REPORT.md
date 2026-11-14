# Stage 4.2 verification — 13 November 2026

Non-AI local repair + Clone release, built from locked Stage 4.1. The Stage 4.1 folder/archive are unchanged. No model weights, AI runtime, server/API or production deployment added.

## New Chromium checks — PASS

- Clone source picking adds zero edits; stroke copies expected source texture pixels, not a uniform fill. Draft leaves the page unchanged. Session Undo/Redo restore the overlay; Preview/Compare toggle result/before; Apply matches preview; outer Undo restores the exact previous page.
- Local repair executes in a bounded worker crop (112×112 in final fixture run, not the 800×1000 page). The test spot is lightened/repaired, adjacent writing is retained, and every pixel outside the visible draft mask stays exactly unchanged.
- Cancel keeps the page unchanged. Cancel during deliberately delayed preview unloads the worker; reopening a new session is protected from stale results.
- Simulated processing failure retains selections and page; retry succeeds. Apply/save/reload preserves the flattened repaired pixels.
- Oversized public repair API inputs rejected. A 2000×1600 page with a >1024-pixel repair stroke fails before any worker request. Five large valid-per-stroke selections exceed the 4 MiB aggregate mask budget and are rejected before processing. Images unchanged.
- Simulated worker-loading failure uses the small-crop existing-engine fallback and discloses it. >512-pixel fallback crop refused; no full-page synchronous inpainting.
- Mobile 390×844 controls fit, document remains visible and the Apply/Cancel footer is visible. Screenshot inspected. Existing-page offline preview/Cancel succeeds; page pixels remain unchanged.

## New WebKit checks — PASS with noted test adaptation

Playwright WebKit 26.0 on Linux, not physical iPhone Safari:
- Clone pick/copy/preview/compare/Undo/Redo/Apply/outer Undo; bounded repair, adjacent writing and strict outside-mask invariance; delayed Cancel/reopen; failure/retry; save/reload; mobile layout; offline existing-page repair preview/Cancel all pass.
- Automated WebKit pointer coordinates are quantized differently at the displayed scale, so its Clone source test checks source selection and copied texture range rather than assuming an exact nominal click pixel. Preview→Apply equality is still exact. Chromium verifies the exact expected source pixel.
- An initial WebKit test found six changed pixels outside the full-canvas draft mask from translated-canvas rasterization differences. Added exact draft-footprint intersection and a 4 MiB mask budget; rerun outside-mask changes: **zero**.
- Cold worker loading offline returned `Load failed` in this harness. Added the disclosed <=512-pixel existing-engine fallback; the offline preview test then passed. This does not establish all iOS/offline navigation behavior. A synchronous fallback cannot be interrupted mid-OpenCV call; larger fallback crops are refused.

## Existing regression suites — PASS in Chromium

- Boot/import/crop/invalid geometry/rotation/Undo; save/reopen/reload; reorder/delete; PDF/PNG/JPEG export; offline reload; mobile width.
- Manual palette/brush, pure-white Manual rectangles, shaded and solid/picked-paper modes; cover persistence; session Undo/Redo/Clear/Cancel; zoom/Pan/Fit; main Undo.
- Emulated touch pinch without stray ink, manual gray pen, local repair now explicitly exercises `FilterProcessor.repairImage` rather than the old full-page `VisionEngine.applyAIErase` spy. The initial old-spy assertion was intentionally updated for the new worker path; no product failure was hidden.
- All 13 filter recipes/UI thumbnails/strength/compare/Cancel/full-resolution Apply/settings persistence; neutral Original, strict binary and legacy Soft/versions 1/2 checks.
- Edge-to-edge mixed page geometry, optional A4, true 1-bit binary PDF path; normal Export quality unchanged.
- Entire Share suite: presets/custom/actual size/cancel/reopen/latest settings/retry/native API mocks/fresh gesture/byte-identical download fallback/database hash unchanged/offline preparation/mobile footer.
- Stage 4.1 memory controls: default retains unsaved page/DB/Undo; optional discard confirmation; worker restart x3; active-editor guard; offline memory release and restart.

## Real upgrade — PASS

Served accepted Stage 4.1 at a fixed origin; saved a legacy Soft B&W fixture and installed its service worker. Replaced all updated files, including the new repair core, with 4.2. Triggered waiting update and explicitly accepted. Stage 4.2 title, identical saved-page pixels/settings, preview Cancel restoration, offline reload and Share preparation passed in Chromium. Database/store/schema unchanged.

## Delivery verification

App JavaScript syntax, all required asset paths, service-worker precache, ZIP integrity, unchanged pinned vendor libraries, unchanged vision/filter recipe/PDF codec, and locked Stage 4.1 archive/workspace contents checked. Complete vendor folder and license files are included.

`tests/`, `research/` and Markdown documents are optional for operation. Tests use port 8092, Node.js/Playwright and installed browser binaries; upgrade test also assumes the development fixture paths/port 8088. No test dependencies are required to deploy the app.

## Remaining limits

No physical iPhone 14 Safari/Chrome/native share/touch testing, actual peak-memory measurement, guaranteed time bound, universal repair quality or dependency security audit. Large batches can still exhaust memory. No AI, OCR, handwriting detection, secure-redaction certification or recovery of hidden original pixels. Clone can copy unwanted source content or show seams; source sampling clips at image edges. Inspect exports and back up important scans before upgrading.
