"use strict";
(async () => {
  try {
    // Load OpenCV before any legacy DOM shim so it chooses its worker runtime.
    importScripts("vendor/opencv-4.5.4.js");
    await new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(
        () => finish(new Error("Worker image engine startup timed out.")),
        85000,
      );
      const poll = setInterval(check, 50);
      function finish(error) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(poll);
        error ? reject(error) : resolve();
      }
      function check() {
        if (self.cv && typeof self.cv.Mat === "function") finish();
      }
      if (self.cv && typeof self.cv.then === "function")
        self.cv.then((value) => {
          self.cv = value;
          check();
        }, finish);
      else if (self.cv) {
        self.cv.onRuntimeInitialized = check;
        self.cv.onAbort = (reason) => finish(new Error(String(reason)));
      }
      check();
    });
    self.window = self;
    self.document = {
      createElement(tag) {
        if (tag !== "canvas" || typeof OffscreenCanvas === "undefined")
          throw new Error(
            "Legacy filter reprocessing needs OffscreenCanvas in this browser.",
          );
        return new OffscreenCanvas(1, 1);
      },
      getElementById() {
        throw new Error("Use ImageData, not DOM IDs, in a worker.");
      },
    };
    // Adapt the unchanged legacy recipes to OffscreenCanvas, never the UI DOM.
    cv.imread = (source) =>
      cv.matFromImageData(
        source.getContext("2d").getImageData(0, 0, source.width, source.height),
      );
    cv.imshow = (target, source) => {
      let rgba = new cv.Mat();
      try {
        if (source.channels() === 1)
          cv.cvtColor(source, rgba, cv.COLOR_GRAY2RGBA);
        else if (source.channels() === 3)
          cv.cvtColor(source, rgba, cv.COLOR_RGB2RGBA);
        else source.copyTo(rgba);
        target.width = rgba.cols;
        target.height = rgba.rows;
        target
          .getContext("2d")
          .putImageData(
            new ImageData(
              new Uint8ClampedArray(rgba.data),
              rgba.cols,
              rgba.rows,
            ),
            0,
            0,
          );
      } finally {
        rgba.delete();
      }
    };
    importScripts(
      "vision.js",
      "filter-core.js",
      "pdf-image-codec.js",
      "local-repair-core.js",
    );
    self.onmessage = async (event) => {
      const job = event.data,
        start = performance.now();
      try {
        const image = new ImageData(
          new Uint8ClampedArray(job.buffer),
          job.width,
          job.height,
        );
        if (job.kind === "pdf") {
          const result = await PdfImageCodec.prepare(image, job.options);
          self.postMessage(
            {
              id: job.id,
              kind: "pdf",
              ...result,
              duration: performance.now() - start,
            },
            [result.bytes.buffer],
          );
        } else {
          const output =
            job.kind === "repair"
              ? LocalRepairCore.apply(image, job.options)
              : FilterCore.applyFilter(image, job.type, job.options);
          self.postMessage(
            {
              id: job.id,
              kind: "filter",
              width: output.width,
              height: output.height,
              buffer: output.data.buffer,
              duration: performance.now() - start,
            },
            [output.data.buffer],
          );
        }
      } catch (error) {
        self.postMessage({ id: job.id, error: error.message || String(error) });
      }
    };
    self.postMessage({ ready: true });
  } catch (error) {
    self.postMessage({ startupError: error.message || String(error) });
  }
})();
