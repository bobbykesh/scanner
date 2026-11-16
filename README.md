# KeshScan Studio

A local-first document scanner that runs entirely in the browser. Import a photo or
a PDF, crop it, clean it up, fill in text, sign it, and export one merged PDF.
Nothing is uploaded — there is no backend, no account, no API key and no build step.

**Live app:** https://bobbykesh.github.io/scanner/
**Install:** open the link on a phone, then "Add to Home Screen". It works offline.

---

## What it does

| Stage | Tools |
| --- | --- |
| Import | Drop or choose JPEG, PNG, WebP or PDF. Multi-page PDFs import all pages at once (up to 30). |
| Crop | Drag four corner handles, with a magnifier, live pixel readout and one-tap reset. |
| Filters | Original, Auto, Lighten, No Shadow, Magic Color, Magic Pro, Grayscale, B&W, Soft B&W, Enhance, Eco, plus strength, brightness, contrast and sharpness. |
| Erase | Pen, rectangle, patch area and copy-texture tools with adjustable brush size. |
| Add Text | Text matched to the document's own font, weight, size and ink — placed as an editable object. |
| Sign | Draw on a full-screen pad, or scan / upload a signature. Black, blue or charcoal ink, reusable on later pages. |
| Document stack | Reorder any page to any position, delete, reopen and keep editing. |
| Export | One merged PDF (or JPEG / PNG), edge-to-edge or fitted to A4, with a choice of compression. Share it with the native share sheet. |

Added text and signatures are **non-destructive objects**: tap a placed object to
select it, then edit or delete it. They are only flattened when you export.

---

## Privacy

Everything happens on the device. Documents live in the browser's IndexedDB and
are never transmitted. There is no analytics, no tracking and no third-party
runtime request beyond the vendored libraries in `vendor/`. The app works fully
offline after the first load.

---

## Running it

There is no build step. Serve the folder over HTTP:

```
python3 -m http.server 8080
```

then open `http://localhost:8080`. Opening `index.html` directly from the
filesystem will not work, because the app uses Web Workers and a service worker.

### Deployment (GitHub Pages)

1. Push these files to the repository root (or `main` branch `/docs`).
2. Settings → Pages → Source: **Deploy from a branch**, branch `main`, folder `/`.
3. Open `https://<user>.github.io/scanner/` and add it to the home screen.

Service-worker updates are versioned in `sw.js`. Bump `CACHE_NAME` on every
deploy and existing users get an in-app update prompt — never a surprise reload.

---

## Requirements and limits

- A current browser with Web Workers, WebAssembly, OffscreenCanvas and
  IndexedDB. Chrome, Edge, Safari 16.4+ and Firefox all work.
- Files up to 35 MB. The working image's longest edge is capped at 2800 px for
  mobile memory safety; imported PDF pages are rendered at 2200 px (1800 px above
  10 pages).
- **Merged exports are raster:** pages are re-encoded as images, so text in the
  exported PDF is not selectable. Searchable OCR is not enabled in this release.
- Erase and patch tools estimate a plausible background. They are **not**
  secure redaction and cannot recover or guarantee removal of hidden content.
- Storage is not a backup. Export important documents and keep the originals.

---

## Files

```
index.html              app shell
style.css               all styling (design tokens at the bottom of the file)
app.js                  application logic
sw.js                   service worker (precache + update prompt)
manifest.json           installable PWA metadata
icon.svg                 app icon (source)
icon-192.png             home-screen icon
icon-512.png             home-screen icon
vision.js               crop / perspective engine (OpenCV wrapper)
filter-client.js        filter worker client
filter-core.js          filter presets and adjustments
filter-worker.js        filter worker entry
pdf-image-codec.js      PDF image encoding (JPEG / 1-bit PNG)
paper-match.js          document font, weight and ink matching for Add Text
local-repair-core.js    erase / patch engine
vendor/                 pinned third-party libraries and their licences
THIRD-PARTY.md          dependency provenance and SHA-256 checksums
TEST-REPORT.md          test and UX-audit results
```

Every file above is loaded by the app. `vendor/` is pinned — these are not
fetched from a CDN at runtime.

---

## Testing

The app was verified with four automated suites in headless Chromium and a
scripted UX audit. Results, thresholds and before/after numbers are in
[TEST-REPORT.md](TEST-REPORT.md).

---

## Licence and trademarks

Source is provided for use by the named organisation. The name **KeshScan
Studio**, its logo and its icons are unregistered trademarks of the author; see
[TRADEMARK.md](TRADEMARK.md). Third-party libraries retain their own licences —
see [THIRD-PARTY.md](THIRD-PARTY.md).
