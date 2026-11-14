/* Bounded conventional inpainting, worker with a small existing-engine fallback. Not AI. */
"use strict";
self.LocalRepairCore = {
  apply(image, options = {}) {
    const mask = new Uint8Array(options.mask || []);
    if (
      image.width > 1024 ||
      image.height > 1024 ||
      mask.length !== image.width * image.height
    )
      throw Error(
        "Local repair is limited to a 1024-pixel crop. Use smaller strokes.",
      );
    if (typeof cv.inpaint !== "function")
      throw Error("Local inpainting is unavailable in this runtime.");
    let rgba, rgb, selection, dst;
    try {
      rgba = cv.matFromImageData(image);
      rgb = new cv.Mat();
      cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
      selection = cv.matFromArray(image.height, image.width, cv.CV_8UC1, mask);
      cv.threshold(selection, selection, 0, 255, cv.THRESH_BINARY);
      if (!cv.countNonZero(selection)) throw Error("Select an area to repair.");
      dst = new cv.Mat();
      cv.inpaint(rgb, selection, dst, 3, cv.INPAINT_TELEA);
      const output = new Uint8ClampedArray(image.data);
      // Never alter unselected context pixels or silently process the whole page.
      for (let i = 0; i < mask.length; i++)
        if (mask[i]) {
          output[i * 4] = dst.data[i * 3];
          output[i * 4 + 1] = dst.data[i * 3 + 1];
          output[i * 4 + 2] = dst.data[i * 3 + 2];
        }
      return new ImageData(output, image.width, image.height);
    } finally {
      dst?.delete();
      selection?.delete();
      rgb?.delete();
      rgba?.delete();
    }
  },
};
