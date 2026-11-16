# Bundled third-party dependencies

These are vendored, pinned copies of the dependency versions in the supplied app. They are not fetched from a CDN at runtime. No dependency security audit has been performed for this stage.

## OpenCV.js 4.5.4

- Download source: https://docs.opencv.org/4.5.4/opencv.js
- Upstream: https://github.com/opencv/opencv/tree/4.5.4
- License text: `vendor/LICENSE-OpenCV.txt` (Apache License 2.0).
- This distribution embeds its WebAssembly binary.

## jsPDF 2.5.1

- Download source: https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js
- Upstream: https://github.com/parallax/jsPDF/tree/v2.5.1
- License text: `vendor/LICENSE-jsPDF.txt` (MIT).
- The distributed file retains its bundled license header.

## PDF.js 3.11.174

- Package source: `pdfjs-dist@3.11.174` (`build/pdf.min.js` and `build/pdf.worker.min.js`)
- Upstream: https://github.com/mozilla/pdf.js/tree/v3.11.174
- License text: `vendor/LICENSE-PDFjs.txt` (Apache License 2.0).
- Both files retain their bundled Apache 2.0 license headers.

## SHA-256 checksums

- `opencv-4.5.4.js`: `6dcb650571741a27882fbf707783bfa2b20301987db83257c81d37db3250cd8a`
- `jspdf-2.5.1.umd.min.js`: `98ccf17aa10c20bb1301762618fcc9b6ab3a4e7f26b6071d64d0b41154df3875`
- `pdf-3.11.174.min.js`: `5b5799e6f8c680663207ac5b42ee14eed2a406fa7af48f50c154f0c0b1566946`
- `pdf.worker-3.11.174.min.js`: `feabdf309770ed24bba31a5467836cdc8cf639c705af27d52b585b041bb8527b`
