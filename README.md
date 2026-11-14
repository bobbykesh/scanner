# ProScan Studio — Complete Stage 4.2

Full replacement files for the existing scanner. This release adds **bounded non-AI repair previews and a Clone tool**, while preserving edge-to-edge PDFs, worker filters, manual editing, saved-page compatibility and Compress & Share. No build step, API key or backend is required.

## New in 4.2 — non-AI repair preview and Clone

Built as a separate release from the locked, accepted Stage 4.1. The original Stage 4.1 folder and ZIP are not modified. This release adds no AI model, server, paid API, account, or document uploads.

### Local repair: preview before committing

1. Open **Erase tools → Local repair**. Brush size remains available; palette colors do not affect repair.
2. Paint a small cyan selection. The **Clone source & result preview** section opens automatically.
3. Tap **Preview result**. The cyan mask is replaced by a flattened result preview in the existing overlay canvas; the underlying page is still unchanged.
4. Use **Show before / Show result** to compare the whole draft batch against the page at editor entry. Apply commits the result; Cancel discards the whole session.
5. Drawing/Undo/Redo/Clear or selecting another tool exits result-preview mode back to editable draft selections. Apply can also process a draft directly without a separate Preview tap, retaining the prior workflow.

Repair runs conventional OpenCV Telea inpainting on **one crop per stroke**, in drawing order with any covers/clones. It only composites selected pixels back. It does not blur or regenerate the whole page. Small defects work best; large areas, folds, texture and nearby writing can still smear. Inspect results before Apply.

### Clone: copy clean paper texture

1. Select **Clone**, or use **Set clone source** in the preview section.
2. Tap a clean paper area in the document. Picking a source does not create an edit.
3. Set brush size if needed, then paint over the unwanted area. Each new stroke starts at the chosen source; its path copies the corresponding source path.
4. Preview/compare, Apply or Cancel. Session Undo/Redo/Clear and the outer image-edit Undo remain available.

The source is the unchanged visible page from when this erase session began—not the archival original and not earlier draft edits. Source coordinates and stroke offsets are held in document coordinates, so zoom/pan do not intentionally move the sampled content. No additional full-page clone-source canvas is allocated. If the mapped source leaves the image, copying is clipped/transparent there; choose another source rather than expect invented content. Clean sources can still be a poor match under different lighting, and copied text will be copied too. Pen/Rectangle cover modes do not affect Clone or Local repair and are hidden while those tools are selected.

### Memory/cancellation safeguards

- Repair worker crop: **maximum 1024×1024 including 32-pixel context and brush bounds**. This is a processing bound, not a model resolution or a promised RAM budget. Oversized strokes fail before processing; Undo and use shorter strokes.
- Exact draft-footprint guards: maximum **4 MiB total one-byte crop masks per preview batch**. Apply fewer repair strokes at a time if that limit is reached. Small translated canvases can rasterize edges slightly differently between engines; intersecting with the visible draft footprint prevents newly changed unselected edge pixels.
- A worker startup/loading failure can use the already loaded main OpenCV engine for crops **no larger than 512×512**. The preview status discloses fallback use. Larger fallback work is refused. This fallback uses brief synchronous processing; the browser cannot interrupt an OpenCV call mid-operation, and the limit does not guarantee an exact time.
- **Cancel** (or Escape) during a running Preview invalidates the session and terminates its worker. Late results cannot overwrite a reopened editor. During final Apply, wait for the operation to finish, as before.
- The existing full-page overlay canvas is reused for result preview; before/after toggles its visibility rather than allocating a second full-page preview. Crop canvases and matrices are released after each job. Current working images and the existing bounded Undo snapshot still occupy memory.
- The Stage 4.1 **Memory** button remains unchanged in behavior: finish/cancel the editor first, then release temporary workers/previews. It keeps documents/current edits and preserves Undo unless you explicitly confirm discarding it. Browser reclamation timing is not controllable.

**No invisible-erasure or secure-redaction guarantee.** These operations estimate/copy a plausible background, cannot recover hidden wording, and retain original working sources/Undo as before. Real iPhone 14 Safari/Chrome testing is still required. Automated desktop Chromium and WebKit checks are not physical-device certification.

## Preserved from 4.1: local tools and safe memory controls

### Paper background modes

- **Auto · follow gentle shading** (default): Rectangle/Pen use a small bilinear color field estimated near the selection corners. It follows gradual shading instead of using one flat color. Dark corner outliers fall back to the overall paper estimate to reduce ink contamination. It is not texture synthesis, AI, inpainting, or recovery of original hidden pixels. Dense text or strong/complex shadows can still give poor results.
- **Auto · solid paper match** keeps the previous flat-estimate option.
- **Picked paper color · both tools** uses the solid paper color you choose. Tap **Pick paper**, then tap a clean paper area on the displayed document. Sampling does not draw a stroke. Tapping Pick paper again cancels; selecting a tool cancels pending picking. The color input lets you choose an exact custom color. Both Pen and Rectangle use it.
- **Manual · pen color / white rectangle** retains old behavior. Choosing a palette swatch switches to Manual. Existing marks are not recolored when you change modes.

The source is a fixed snapshot at maximum 800-pixel edge, not a new full image for every move. Each shading tile is only 26×26 pixels and recalculated when its command bounds change. Preview and Apply share the same field. Shapes remain opaque (Pen stroke edges are antialiased). Local repair remains separate. Short pen strokes work better across changing paper conditions.

### Free memory

Tap the **Memory chip icon** in the top bar. On phones the button is icon-only to keep the navigation compact.

- **Free memory** terminates the filter worker (including its OpenCV/WASM runtime), cancels queued worker requests and releases thumbnail/temporary selection canvases. The filter worker is lazily reloaded on the next filter/PDF job, including offline after successful caching.
- Saved IndexedDB documents, current working images, current unsaved edits, offline app assets and downloaded files are not deleted. **Undo is retained by default.**
- Optional **Also discard the previous image-edit Undo snapshot** requires both selecting the checkbox and a separate confirmation. It keeps current edits but removes that one Undo opportunity. Free memory never silently discards editor-session drafts; finish/cancel active Erase/Filter/Share before using it.
- Old Undo canvases are explicitly reduced when replaced/discarded. The browser decides when released memory is reclaimed. No exact MB-freed promise or total-memory meter is offered.
- The main crop/vision engine, current page/source canvases and saved-page strings remain resident for continued editing. This is not an unload-everything button or Clear site data. Large batches can still exhaust memory; export important documents.

### AI research—not installed yet

This release intentionally contains **no AI runtime or model weights**, performs no automatic model download and uploads no documents. You requested local improvements plus AI research; the findings are in **AI-MODEL-RESEARCH.md**. A pinned MI-GAN model ran on synthetic fixtures in desktop Chromium and WebKit, but its fill was too dark on the paper fixture and peak memory/iPhone performance are not validated. That is not sufficient for an iPhone-ready AI release. The untested model is not bundled into your working scanner.

`research/` contains optional benchmark evidence, not deployable AI. Do not enable it as an app feature. Any future AI release must test real document crops, masked-only compositing, memory, cancellation, and a physical iPhone 14 before shipping. Nothing in 4.1 requires a paid API or backend.

## Preserved from 3.2

- **The cropped scan is the PDF page** by default: no A4 canvas, padding or added margins. Each page retains its own proportions and portrait/landscape orientation. The longest physical edge is 297 mm; proportions, not an original scanner DPI, determine the other edge.
- Optional **Fit to A4 · 5 mm margins** in both Export and Share. Compression changes embedded pixel resolution/quality, not the chosen PDF geometry.
- Original, Auto, Lighten, No Shadow, Magic Color, Magic Pro, Grayscale, B&W, B&W 2. Soft B&W remains a separate gentle grayscale preset. Enhance/Eco/legacy Magic remain available.
- Expand **Brightness · Contrast · Sharpness** for optional fine controls. Neutral Original copies the cropped/edited working pixels exactly. Manual covering creates a new working base, as before.
- OpenCV recipes run in a **Web Worker**, with queued previews, stale-result guards and transferable buffers. This is CPU/WASM processing, not a claim of GPU acceleration. Full image copies, crop/editing and final PDF assembly can still cost UI time. Cancellation discards obsolete results; it does not interrupt an OpenCV operation already running.
- Strict B&W and B&W 2 are re-binarized after adjustments. Truly opaque binary final pages use a **1-bit lossless grayscale PNG/PDF image path** where CompressionStream is supported; other browsers use lossless PNG. Gray/color pages use JPEG. Downscaling remains information-losing, even for binary pages. Painting gray or rotating with antialiasing can make a formerly binary page continuous-tone.
- Old saved versions 1–3 keep their legacy recipe and exact saved pixels on reopen. A **Use updated preset** button explicitly switches an old setting to the new recipe. No database schema migration or automatic image rewrite.

### Filter interface

`await applyFilter(imageData, filterType, settings?, control?)` returns a new ImageData without detaching or modifying the caller's input. `FilterProcessor.defaults(type)` supplies version-4 defaults. Brightness/contrast range from -50 to 50, sharpness from 0 to 100. `control` can specify a cancellation group and queue priority. See `filter-client.js`.

Recipes: Auto uses white balance/histogram stretch; Lighten uses gamma/offset; No Shadow uses reduced-resolution dilation/heavy-blur illumination estimation and division; Magic Color adds white-paper tone mapping/saturation/unsharp masking; Magic Pro adds bilateral smoothing and stronger normalization/sharpening. Grayscale preserves continuous tones; B&W uses adaptive thresholding; B&W 2 uses less blur and greater faint-stroke sensitivity. Strong processing can erase pale marks or amplify noise. Magic Pro is not AI and cannot reliably repair heavy stains, creases, hidden wording or major damage.

Requires a current browser with Web Workers, WebAssembly and OffscreenCanvas. No backend, AI upload or automatic handwriting removal is enabled.

**Deployment:** `tests/` and `research/` are optional and is not needed on GitHub Pages. Markdown documentation is optional for app operation. Upload all app assets and the entire `vendor/` folder, keeping licenses.

## Upgrade safely

1. **Export important documents and back up your current source files first.** Device/browser storage is not a document backup.
2. Extract `ProScan-Stage-4.2-Complete.zip`. Its root contains `index.html` and the `vendor` folder; there is no extra project-folder wrapper inside the ZIP.
3. Upload **all extracted files and the entire `vendor/` folder** to the same published directory as your existing `index.html`. Replace old files, do not append code or upload the ZIP itself as the website.
4. Wait for deployment to finish. Reload while online, save any open edits, then accept the app update notice. The tab title must become **ProScan Studio | Stage 4.2**.
5. If an older stage still appears, use the app's Refresh button while online after exporting/saving. Do not use browser “Clear site data” if you need your saved documents: it can delete IndexedDB pages.
6. Run the checklist below on your actual phone before using important documents.

Built on the locked, accepted complete Stage 4.1 package. Saved-page IDs, database/store names and schema version are unchanged. The vendor libraries are unchanged and included in full again to prevent missing-folder problems. No AI upload or model API is enabled.

Expected published layout:

```text
index.html
style.css
app.js
vision.js
filter-client.js
filter-worker.js
filter-core.js
pdf-image-codec.js
paper-match.js
local-repair-core.js
manifest.json
sw.js
icon.svg
icon-192.png
icon-512.png
README.md
AI-MODEL-RESEARCH.md
TEST-REPORT.md
THIRD-PARTY.md
vendor/
    opencv-4.5.4.js
    jspdf-2.5.1.umd.min.js
    LICENSE-OpenCV.txt
    LICENSE-jsPDF.txt
```

For your current deployment, these two URLs must return JavaScript, not 404 or HTML:

- `https://bobbykesh.github.io/ai/vendor/opencv-4.5.4.js`
- `https://bobbykesh.github.io/ai/vendor/jspdf-2.5.1.umd.min.js`

This OpenCV file embeds its WebAssembly binary; it does not require a separate `.wasm` upload.

## New: Compress & Share

From the Document Stack, click **Share PDF**. A **Compress & Share** dialog opens before sending anything. It automatically prepares a recommended Balanced copy, then rebuilds it when you change compression settings. No separate Export step is needed.

1. Choose a preset or custom JPEG quality/resolution.
2. Wait until **Generated PDF size** shows the actual completed PDF size, not an estimate. All saved pages are included.
3. Edit the PDF name if desired.
4. Tap **Share PDF** in the dialog to open the device's share sheet with that exact prepared copy.

The final tap is deliberate: browsers require a fresh user gesture for native file sharing. PDF encoding is finished before the tap, rather than risking a blocked share call after lengthy asynchronous processing. You do not have to first export a file and import it again.

### Compression choices

| Preset | JPEG quality | Maximum longest edge per page |
| --- | --- | --- |
| Best quality | 95% | Keep current working resolution |
| Light | 85% | 2400 px |
| Balanced (default) | 65% | 1800 px |
| Strong | 45% | 1200 px |
| Custom | Slider from 20–100% | Keep resolution, 2400, 1800 or 1200 px |

Images are only downscaled, never enlarged. These are pixel limits, not promised file sizes or scan DPI. Each PDF page follows the selected layout, independently of compression. Gray/color pages use JPEG; exact binary pages follow the lossless path described above.

**Compression is lossy.** Stronger settings can reduce small-text/stamp clarity; file-size reductions vary and are not guaranteed for every source. The app displays the actual generated size and does not claim an estimated percentage reduction against an unknown original file. Use Best/Light for delicate documents and inspect the PDF when readability matters.

### Sharing, cancellation and recovery

- Compression uses disposable canvases from snapshots of the saved final page images. It does not change original/cropped/final saved pixels, filter settings, page order, editor canvases or the database.
- Original working sources remain available; this affects only the copy being sent. The normal Export dialog and its quality settings are independent and unchanged.
- No file is sent or downloaded merely by changing a compression preset.
- **Download copy** saves the same generated PDF bytes as Share would send. It does not regenerate at another quality.
- If the browser cannot share PDF files, the final action reads **Download PDF** instead, with a clear explanation. Send that downloaded file using another app.
- Cancelling the native share sheet keeps the prepared copy ready to retry. A native sharing error also retains it so you can retry or explicitly Download copy with a fresh gesture.
- Cancelling the compression dialog discards its pending copy. A cancelled/stale preparation result cannot overwrite a newer selection. Changing settings rapidly builds the latest request only.
- PDF preparation failure shows a Retry action without changing saved pages.
- Cancel leaves the editor available even if an old image decode is still winding down.
- On phones, the settings scroll independently while Cancel/Download/Share remain visible in the footer.
- This flow works offline after successful app/library caching. Transmitting a file through another app may still need connectivity.
- Presets reset to Balanced each time you reopen Share; saved-page data and your separate Export settings are not repurposed to store sharing preferences.

## Optional browser AI remains deferred

Follow the model research report before enabling AI. The agreed route is a self-hosted browser model with no paid backend. Require on-demand download, one bounded repair job at a time, preview/Undo/Cancel, and worker unloading. No document upload or model API key is needed for that design. Actual model quality, peak memory and physical iPhone 14 support remain release gates—not claims of this package.

---

## 1. Pen color and size — like the supplied reference

Open **Erase tools**, then click **Pen**. A bottom-panel section opens with:

- Eight opaque neutral swatches: White, Off-white, Light gray, Silver gray, Medium gray, Dark gray, Charcoal and Black.
- A selected-color ring and a small color indicator on the Pen button.
- A full-width **Size** slider, initially 3, adjustable from 1–80.
- A chevron to collapse the settings and regain preview space.

In **Manual** mode, Pen **paints over the document in the selected solid color**. Auto instead estimates smooth nearby paper shading for each stroke. Manual does not call inpainting, blur or automatically select letters. Auto interpolates an estimated color field, not the hidden original background. This is deliberate manual covering, as requested. The stroke interior is opaque; brush edges are antialiased for smoothness.

Size is measured in displayed screen pixels at the start of each stroke and converted into image coordinates. Zooming in lets you make finer edits in the underlying image. Existing strokes stay anchored to document pixels when you zoom, pan, resize, or reopen the settings. Changing the current color or size does not retroactively change earlier strokes.

## 2. Rectangle background mode

Auto is the default and estimates gentle paper shading. Solid Auto and picked paper color are also available. Manual restores the previous **pure-white #FFFFFF rectangle**, independent of the pen swatch. Both are opaque covering, not blur or inpainting. The preview displays the fill before Apply. Rectangle coordinates are rounded to image-pixel boundaries. A zero-size rectangle does not create an edit.

## 3. Local repair — updated in 4.2

Local repair remains separate from Pen and Rectangle. It uses a cyan selection and brush size, but palette colors are ignored. The new bounded crop/preview workflow is described at the top. Cover and Clone commands are processed in drawing order with repair strokes. Small marks work best. The tool is disabled if the runtime does not expose conventional inpainting; the other tools remain available.

## 4. Manual editor safety and precision controls

- Strokes/rectangles are held as document-coordinate commands in a transparent preview overlay. They are committed only on **Apply**.
- **Undo / Redo** operate on the current erase-session edits, including Clear edits. New drawing after Undo discards that session's redo branch.
- **Clear edits** clears the draft and can itself be undone.
- **Cancel** discards the entire session and leaves the previous final image unchanged.
- **+ / −**, **Fit**, **Pan**, and two-finger pinch zoom are available. Zoom is limited to 100–400%.
- A pinch cancels the provisional first-finger stroke so zooming should not leave a stray mark. Pointer cancellation also discards the interrupted stroke.
- Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z undo/redo the current erase session. Escape closes pen settings first, then cancels the editor.
- There are up to 100 session undo/redo steps and 300 drawn edits per session. Brush paths are bounded at 10,000 sampled points per stroke for memory safety. Apply and reopen the editor for additional work.
- After Apply, the main **Undo edit** can restore the pre-apply image/base/settings. This remains a single image-edit undo level, not an unlimited external history.

Applying manual edits deliberately bakes the visible result into a new filter base and sets **Original**. Filters then start from that edited base so they do not resurrect covered content. Original means that working base, not an untouched archival photo. This is not a fully layered, non-destructive project format; keep an exported backup and your original photo.

## 5. Soft and strict black and white

Choose **Soft B&W** for the previous gentle grayscale recipe (default strength 40). It preserves gray detail and black/white endpoints without hard thresholding. Choose **B&W** or **B&W 2** for strict binary output; inspect faint print/pencil and speckles before saving. Old saved B&W pages retain their Soft/Crisp style and sensitivity until you explicitly change presets or modernize. Filters cannot restore detail already lost in a saved binary base.

## Preserved from the previous stages

- Theme/Refresh local SVG icons, theme preference, and refresh safeguards.
- OpenCV readiness timeout/retry and local bundled libraries.
- Image import, perspective crop, stable handles, crop geometry validation, keyboard controls and crop undo/reset.
- Scrolling real-image filter thumbnails, strength controls, source comparison, exact filter cancel, and full-working-resolution Apply.
- Original, Auto Enhance, No Shadow, Lighten, Enhance, Eco, Grayscale and legacy Magic presets.
- IndexedDB saving/restoration, reopening saved final pixels, deletion/reordering.
- Multi-page PDF export with page fitting/orientation, quality re-encoding, first-page JPEG/PNG export, sharing with download fallback.
- Offline app-shell/library caching after installation and user-accepted cache updates.

The database remains `ProScanDB`, store `pages`, schema version 1. The existing optional `stage32Version` marker is retained and settings fields without changing IDs or forcing a schema upgrade. Very old/unknown-filter records retain the safe saved-final-image baseline migration. Avoid rolling back to older code after editing new Stage 3 pages, because older software does not understand version-4 presets/adjustments.

## Important privacy / document-integrity note

**This is not certified secure redaction.** Covering removes underlying pixels from the newly flattened final page image, but the app can still retain an original working source, pre-apply Undo snapshots and older exported copies. Do not distribute project data or claim that all copies of obscured content have been securely destroyed. Inspect exported final images/PDFs and use a dedicated redaction workflow for sensitive/legal requirements.

No document is sent to an AI service. This release has no trained handwriting/text detector, generative model, OCR pipeline or AI backend. Magic selection, handwriting detection and text detection remain disabled instead of pretending to work. PDFs are image-based, not searchable OCR PDFs.

## Hosting, resolution and offline limits

- Serve over HTTPS, or localhost for development. Do not double-click `index.html` into a `file://` URL.
- To test locally with Python 3, run `python -m http.server 8080 --bind 0.0.0.0` from this folder, then open `http://localhost:8080` on that computer. A phone on a normal LAN HTTP address generally does not have service-worker support; use HTTPS for real phone/PWA tests.
- Preserve lowercase paths and the `vendor` folder. Custom Content Security Policies must allow local JavaScript and OpenCV WebAssembly compilation.
- Import rejects files above 35 MB and caps the working image's longest edge at 2800 pixels for mobile memory safety. Browser-decodable formats only; HEIC support is browser-dependent. Keep the real original files separately.
- The stored `original` is a JPEG working-source copy, not the untouched upload. Cropped/final working images use PNG to reduce repeated JPEG degradation.
- Filter previews use a 1200-pixel maximum edge and 260-pixel thumbnails; the full working image is processed on Apply. Fine details can differ slightly after resampling.
- Large batches/high-resolution editing may hit memory/quota limits or pause the main thread. Browser/OS process termination cannot always be caught.
- Offline use requires successful service-worker installation, storage capacity and HTTPS/localhost. First access needs the bundled files; private mode/storage eviction may prevent offline availability.
- Share opens the compression dialog first, then the final explicit user tap sends/downloads the prepared copy. Native availability depends on browser/device permissions; a successful API response is not proof of recipient delivery.
- For future releases change `CACHE_NAME` in `sw.js`. The Stage 4.2 cache requests fresh install assets and waits for user acceptance. Do not clear IndexedDB just to update the UI.
- Dependencies remain pinned to the previous working versions. No dependency vulnerability/security audit was performed in this stage.

## Before production

1. Test pen colors and size on your physical phone; confirm black/gray/white interior colors in the export.
2. Check Auto on cream/gray paper, then select Manual: the rectangle must be white regardless of pen swatch.
3. Undo/redo, clear/undo, cancel, zoom/pan and pinch; verify marks stay aligned.
4. Apply, save/reload and change filters; covered content must not reappear.
5. Test Soft B&W and both binary presets, including fine adjustments.
6. Test faint print, pencil, stamps, shadows and photos; no filter has universal accuracy.
7. Export a multi-page PDF and inspect it in your normal viewer/printer.
8. Test the real Stage 4.1 → Stage 4.2 update, offline reload and native sharing on your own devices.

See `TEST-REPORT.md` for the automated checks actually executed. Passing tests reduces regression risk; it is not a promise that nothing can break on every device or scan.
