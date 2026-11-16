# KeshScan Studio — test report

_Current release: branding and repository cleanup (no functional or UI change)._



Run: 16 Nov 2026 · headless Chromium · Playwright
Command pattern: `PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers node <suite>`

## Stage 6.1 addition

`test-move.js` — **7 pass / 0 fail**: dialog lists every position, current
position is marked, confirming splices the page to the chosen index, cancel
leaves the order untouched, and the page count is preserved. Reorder is
persisted through the existing `persist()` path.

## Regression suites (all green)

| Suite | Result |
| --- | --- |
| `test-stage5.js` | **26 pass / 0 fail** — dock, sheets, collapsible sections, objects, persistence, export |
| `test-text-sig.js` | **59 pass / 0 fail** — text object lifecycle, signature draw/upload/reuse, crop popup, filters, erase, rotate, export |
| `test-full.js` | **4 / 4** — drag-drop PDF import, erase + local repair on a PDF page, save + export, free memory then import again |
| `test-pdf-scanner.js` | **9 / 9** — boot, image pipeline, 1-page and 3-page PDF import, re-crop, compress/share, corrupt PDF, offline reload, mobile viewport |

Stability: `test-text-sig.js` was run three times; one run reported a headless
"Target crashed" (browser process, not an app error) and passed cleanly when
re-run alone, which matches the Stage 5 behaviour for back-to-back suites.

## UX audit (`ux-audit.js`, 390×844)

| Check | Before | After |
| --- | --- | --- |
| Interactive controls under 44px — Erase sheet | 6 of 16 | **0 of 13** |
| Interactive controls under 44px — Text sheet | 11 of 14 | **0 of 14** |
| Interactive controls under 44px — Filters | 3 of 17 | **0 of 16** |
| Content hidden by scrolling — Text sheet | 437px visible / 516px content (**15%**) | **0%** |
| Content hidden by scrolling — Erase sheet | 0% but last section clipped by footer | **0%, footer clears content** |
| Content hidden by scrolling — Filters | 0% | **0%** |
| Crop corner handle hit area | 26×26 | **44×44** |
| Crop magnifier | absent | **present** (132px, follows the dragged corner) |
| Text contrast, dock "Add to Doc" | 4.47:1 (fail) | **passes** (commit button is filled indigo/white text) |
| Accessible names | 0 unnamed | **0 unnamed** |
| Visible focus ring | present | **present**, first tab stops now Back → More → dock |
| 200% text zoom | no clipping, no horizontal scroll | **unchanged, no clipping** |
| Reduced motion rules | 1 | **2** (sheets and scroll behaviour) |

## Geometry guarantee (unchanged from Stage 5)

Crop / Filters / Erase / Text / Signature all keep the document bounding box
`{"w":390,"h":520}` before, during and after opening the panel — no editor
resizes the page.

## Notes

- One assertion was widened: the erase section header copy changed from
  "Repair & clone" to "Patch area & copy texture", so `test-full.js` now matches
  `/Repair|Patch/i`. The control exercised is identical.
- The desktop filter sheet is now an inspector panel; the same dialog and the
  same confirm/cancel ids are used, so no test path changed.

---

# Stage 5 — full-size editor, tool dock and editable objects — 16 November 2026

Layout and data-model release on top of Stage 4.3. No new dependency; IndexedDB schema extended with an optional per-page `annotations` array (older pages load with an empty list).

## New Stage 5 checks — PASS (Chromium, 26-check suite, mobile 390×844)

- **Document keeps its size in every editor.** Measured `#canvas-final` before and while Filters, Erase, Text and Signature are open: identical bounding box in all four modes (390×520 at 390×844 viewport, full-bleed width), and unchanged after closing. Previously the page shrank by the panel height in each mode.
- **Filters tap-again.** Adjustments start collapsed; tapping the already-selected filter tile expands them (strength control becomes visible); tapping again collapses.
- **Sheet collapse.** The grab handle collapses the sheet to a 44-px strip with only the handle showing, and restores it on the second tap.
- **Text becomes an object.** Apply closed the panel and rendered the text on the overlay layer; `canvas-final` pixel checksum was **byte-identical before and after**, proving the page pixels are untouched (non-destructive).
- **Tap to select.** Tapping the placed text showed the selection badge and reported the correct type ("Text"); dragging moved the object (measured painted-region top shifted up) and it stayed selected.
- **Persistence.** After **Add to Doc** and reopening the page from the gallery, the annotations were restored and re-rendered on the overlay.
- **Signatures are objects too.** Applying a signature rendered it on the overlay, and tapping it selected it with type "Signature".
- **Delete + Undo.** Delete removed the selected object; **Undo** restored the painted content.
- **Export.** Export produced a PDF with the annotations composed into the page pixels.
- No uncaught page errors or console errors during the session.

## Stage 4.3 checks (retained, updated for the object model) — PASS

- Text sampling, auto-fit, drag/resize/target-box, apply-as-object, Undo, and Cancel leaving the page untouched: **59 checks pass, three consecutive runs**.
- Signature drawpad, ink retinting, size/darkness/angle, upload → B&W → crop popup → background removal → placement, in-session reuse across pages, and regression on Filters/Erase/Rotate/Save/gallery/Export: all pass in the same 59-check suite.

## Regression — PASS

- Existing PDF/offline suite: **9/9** end-to-end checks (import, crop, filter, multi-page PDF, re-crop, Compress & Share, corrupt-PDF handling, service worker offline import, mobile layout).
- Additional suite: **4/4** (drag-and-drop PDF, local repair preview + apply via the new collapsible section, save + export, free memory then another import).

## Known trade-off

Annotations are not pixels until output, so Filters and Erase intentionally do not modify placed text or signatures. They are edited or deleted by tapping the object.

## Stage 4.3 verification (retained) — PASS

# Stage 4.3 — Smart Add Text + Add Signature verification — 16 November 2026

Local-only Add Text and Add Signature release, on top of Stage 4.2 (local PDF import, repair preview, Clone). No model weights, AI runtime, server/API, external CDN dependency or new upload path added. IndexedDB schema untouched.

## New Add Text checks — PASS (Chromium, 61-check suite)

- **Text** opens the editor panel, sets `body.text-editing`, and auto-samples the page on entry: an 8-connected-component pass over the document canvas measures cap height, median horizontal ink-run stroke width, serif cue rows and glyph-width consistency, and picked document serif + `#2f3135` on a Georgia-set fixture — the match is derived from pixels, not defaults.
- Matcher accuracy grid (11 synthetic pages, Georgia / Times / Arial / Calibri / Courier, 18–34 px, 400–700): **font family 11/11 correct**, **weight within one step on 10/11** (one 600 reported as 700). Size landed within ~10% of the CSS pixel size. Samples too small or too sparse fall back to defaults by design.
- Typing text paints the live overlay on `#canvas-mask` (non-zero alpha pixels) and enables **Apply Text** only when the field is non-blank.
- **Auto-fit to box** reduced the size when a much longer sentence was typed (no overflow), and multi-line text is supported.
- Dragging the box moved the overlay (measured min-ink-row shifted upward); corner handles resize; **Target box** and **⊕ Sample text** drag selections re-sample or re-target the fit.
- **Apply Text** changed `canvas-final` pixels, closed the panel, cleared `body.text-editing`, and enabled **Undo edit**. Undo restored the page to the exact pre-apply pixel checksum.
- **Cancel** left `canvas-final` byte-identical and reset `#canvas-mask` to 1×1.
- **Cover old text underneath** paints a `PaperMatch` paper-texture patch in the box before drawing the glyphs (same tile field used by Rectangle/Pen).

## New Add Signature checks — PASS (Chromium, 61-check suite)

- **Signature** opens the source dialog with the drawpad, Scan (Camera) and Upload paths; **Use Drawn Signature** is disabled until a stroke exists.
- Drawpad captured a pointer stroke (coalesced events, min-distance filtering), rendered ink, and **Use Drawn Signature** trimmed to ink and switched to placement with `body.sig-editing` and a live preview on the overlay canvas.
- **Scanned Black / Ballpoint Blue / Dark Charcoal** retint correctly: after choosing Ballpoint Blue the preview's mean blue channel rose by >20 over Scanned Black. **Size**, **Ink darkness** and **Angle** sliders update the preview; **Reset size** restores 100%.
- Upload path on a synthetic unevenly-lit paper "photo": B&W conversion (illumination-field subtraction + threshold) kept the ink while flattening >50% of the canvas to white; the **Crop Signature** popup opened with the box auto-fitted around the ink; the live **background removed** preview showed >50% fully transparent pixels (paper removed) with ink retained opaque; drag on a corner handle resized the crop box; the **B&W contrast** slider re-converted live; **Autofit** re-fitted; **Use This Signature** returned to placement with the panel open and the dialog closed.
- **Apply Signature** changed page pixels and enabled **Undo edit**; the signature is remembered in memory.
- **Multi-page reuse:** after saving page 1 and importing page 2, **Signature** went straight to placement — the source dialog was skipped and the saved signature preview painted on the new page, then applied successfully.
- **Draw / Scan / Upload** and **Change signature** correctly reopen the source dialog for a replacement; closing the dialog without producing a signature aborts cleanly instead of leaving the editor stranded.

## Regression checks — PASS

- Filters modal (open → select → preview → confirm), Erase tools (open → cancel), Rotate, Add to Doc, gallery (2 pages) and Export all still work after using both new tools.
- No uncaught page errors or console errors across the whole 61-check session.
- All editor entry points are mutually exclusive: Text/Signature are blocked while filters, erase, crop, rotate, back or save are active, and vice versa; `safeToReload()`, `beforeunload` and `memoryBlocked()` treat both sessions as unsaved work.

## Stage 4.2 verification (retained) — PASS

## New Local PDF Import checks — PASS

- Bundled `vendor/pdf-3.11.174.min.js` and `vendor/pdf.worker-3.11.174.min.js` load locally with zero external network calls and are precached by `sw.js`.
- Single-page PDF upload via `#file-input` and drag-and-drop opens `crop-view` with full-page default corners (`0%` to `100%`), preserves full page pixels on `Flatten & Process`, supports all Filters and Erase tools (`Pen`, `Rectangle`, `Local repair`, `Clone`), and saves to `Document Stack`.
- Multi-page PDF upload renders all pages locally with progress updates and imports them into `Document Stack` (`#gallery-view`) and IndexedDB (`ProScanDB`).
- Opening any imported PDF page from `Document Stack` allows filtering, erasing, rotating, or clicking `Crop` (`#btn-recrop`) to perspective-crop that page (with non-destructive `Cancel` back to `process-view`) and `Update Page` in place.
- `Compress & Share` (`#btn-share`) and `Export` (`#btn-export-trigger`) process combined image and PDF-imported pages without error.
- Invalid/corrupted PDF files and password-protected PDFs fail cleanly with descriptive user notices while leaving existing pages intact.
- Offline reload and offline PDF upload pass after service-worker installation.

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
