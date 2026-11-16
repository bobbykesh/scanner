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

### Third-party vendor files

- `opencv-4.5.4.js`: `6dcb650571741a27882fbf707783bfa2b20301987db83257c81d37db3250cd8a`
- `jspdf-2.5.1.umd.min.js`: `98ccf17aa10c20bb1301762618fcc9b6ab3a4e7f26b6071d64d0b41154df3875`
- `pdf-3.11.174.min.js`: `5b5799e6f8c680663207ac5b42ee14eed2a406fa7af48f50c154f0c0b1566946`
- `pdf.worker-3.11.174.min.js`: `feabdf309770ed24bba31a5467836cdc8cf639c705af27d52b585b041bb8527b`

### First-party application files (Stage 5)

- `app.js`: `95a07da53bc0c3a305a8c01347e4c778ecd06b8b1a312817e2e111dfcd8d6467`
- `index.html`: `486a84c64c8e007e9ae6a3b3c79196ee458e1aa4d1598aacd2a22e34d049a92b`
- `style.css`: `fe413aedca5514e8d6e4ed08d443a9b405a13053f27c3bd8a3186052a9fbcafd`
- `sw.js`: `b9c50266fa702cf78b3ad0faf046c1e441660610899501ad1e1f06e7357410c9`
- `manifest.json`: `a135f9410662b70ab943e9ec9c08be24863622357cb8a90242b230a9aae82320`
- `paper-match.js`: `d43a6690f03539b2c57b61688c94e0926e0e31682e49c051beb886aa1cc74275`
- `vision.js`: `7f2bdcc170867c9de8b6d85902ca28854974e1b8bf5dea5f1d1014221933173d`
- `filter-client.js`: `d8c55f37ca6fc46d7df2aaaf2b4c81f67ae6ca3513cb7b3a7ff116e80a1af0b6`
- `filter-core.js`: `2969f10bc82eedd9a6f5e42040b83b6a2ab57e5756b9b98a43b7e2e36c05efad`
- `filter-worker.js`: `ec5ff35fe60005471b7587d75f2d7ef5e0935601515c40a973a5f7c338ed6827`
- `local-repair-core.js`: `e3793338294e7607bcb6a1b13a55d97e2fd8819dbcecad55b8cae394b7e13216`
- `pdf-image-codec.js`: `7782312edc35dfe702b66eb1e32435b26593ee859a4b246af59e447ff995d4dc`
