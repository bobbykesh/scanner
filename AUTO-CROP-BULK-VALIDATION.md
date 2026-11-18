# Current-main KeshScan feature merge validation

Base: `d38b0a2547434283b41602c89224dfe145056679` (Delete All).

The old Stage 4.3 package was NOT copied over current main. Auto crop and bulk
filters were merged additively into KeshScan, preserving branding, resumable PDF
import/checkpoints, PDF runtime/worker, non-destructive text/signatures, sheet/dock
layout, gallery actions and Delete All. Vendor files are unchanged. No AI added.

## Desktop Chromium and Playwright WebKit — PASS

- Synthetic perspective page and reversed-contrast paper: corners within 12 source
  pixels of known fixtures. Blank/frame-filling/small-object candidates rejected.
- Six rotation/shading fixtures: moderate cases found in both engines. The most
  severe shadow fixture was found in Chromium and safely rejected in WebKit.
- Import suggestion, Reset/full image, Auto Detect, Undo, confirmed perspective
  crop and saving/reloading tested. Forty repeated detector runs per engine kept
  OpenCV heap capacity at 134,217,728 bytes before/after. Not a peak RAM measurement.
- Three-page bulk grayscale + nondefault brightness: preset/settings persisted,
  edited base pixels retained. Injected decode, database/quota and staging-budget
  failures produced no saved-record changes; retry succeeded.
- Real two-page PDF import using vendored PDF.js; PDF re-crop retained full bounds
  and raster dimensions. Actual UI text entry and drawn-signature placement,
  saving and bulk filtering retained two editable annotation records, original
  sources, crop bases, PDF flags and page count after reload.
- Exported merged PDF; offline reload retained PDF.js, new detector and saved pages.
  Delete All Cancel retained pages; confirmed Delete All removed stored pages.
- Installed actual old-main service worker, accepted waiting merged update,
  verified unchanged KeshScan title/saved record and new detector precache, then
  reloaded successfully offline. A guard requires explicit update acceptance
  before controllerchange triggers a reload; initial registration no longer shows a
  false update toast due to an activation race.

## Additional checks — PASS

Chromium scanner smoke: image import, manual handles/Undo, filter preview/Cancel/
Apply, rotation/Undo, erase selection/Cancel, save/open/reload, PDF and PNG/JPEG
exports, offline reload. No page errors in passing smoke/feature/preservation tests.

390×844 WebKit layout: crop controls inside viewport, no horizontal overflow,
bulk action reachable. Screenshots inspected. Fixed a pre-existing mobile toast
inset conflict found here: simultaneous top+bottom insets stretched a notice over
the crop screen. Non-editor notices now stay compact. Also completed an existing
missing closing-button delimiter in filter markup.

Bulk writes use a single transaction, independently of the existing incremental
save signature heuristic, so equal-length but different encoded pixels cannot
be skipped by that heuristic. Bookkeeping is refreshed only after commit.

## Limits

No physical iPhone14 run, native-share verification, total/peak RAM profiling,
real-photo accuracy benchmark, OCR/content-retention scoring, glare/clutter/partial
edge certification or all-pages Undo. User inspection of proposed corners is
mandatory. One-page PDF import, very large resumable imports, signature camera
capture and every prior advanced-tool option were not exhaustively retested.
Their implementations are retained, not newly certified.

Tests in `tests/keshscan-*.cjs` are optional development scripts and use localhost
ports 8098/8099, local workspace paths and installed Node/Playwright browsers.
The update test requires an old-main fixture directory and is not a deployment
command. No tests, evidence, npm dependencies or credentials are needed to host.
