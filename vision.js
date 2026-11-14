/* Stage 3: local document processing. No AI models or uploads. */
"use strict";
window.VisionEngine = {
  getDist(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  },
  validateCorners(points) {
    if (
      !Array.isArray(points) ||
      points.length !== 4 ||
      points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))
    ) {
      throw new Error("Four valid crop corners are required.");
    }
    let direction = 0;
    for (let i = 0; i < 4; i++) {
      const a = points[i],
        b = points[(i + 1) % 4],
        c = points[(i + 2) % 4];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cross) < 1)
        throw new Error("Crop corners are too close together or aligned.");
      const sign = Math.sign(cross);
      if (direction && sign !== direction)
        throw new Error(
          "Crop edges cannot cross. Keep each handle at its own corner.",
        );
      direction = sign;
    }
    if (direction < 0)
      throw new Error("Crop corners must remain in clockwise order.");
  },
  warpPerspective(source, points, target) {
    this.validateCorners(points);
    const width = Math.round(
      Math.max(
        this.getDist(points[0], points[1]),
        this.getDist(points[3], points[2]),
      ),
    );
    const height = Math.round(
      Math.max(
        this.getDist(points[0], points[3]),
        this.getDist(points[1], points[2]),
      ),
    );
    if (width < 2 || height < 2 || width * height > 20000000)
      throw new Error("Invalid crop size. Choose a smaller, valid area.");
    let src, from, to, matrix, dst;
    try {
      src = cv.imread(source);
      from = cv.matFromArray(
        4,
        1,
        cv.CV_32FC2,
        points.flatMap((p) => [p.x, p.y]),
      );
      to = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0,
        0,
        width - 1,
        0,
        width - 1,
        height - 1,
        0,
        height - 1,
      ]);
      matrix = cv.getPerspectiveTransform(from, to);
      dst = new cv.Mat();
      cv.warpPerspective(
        src,
        dst,
        matrix,
        new cv.Size(width, height),
        cv.INTER_LINEAR,
        cv.BORDER_REPLICATE,
      );
      cv.imshow(target, dst);
    } finally {
      dst?.delete();
      matrix?.delete();
      to?.delete();
      from?.delete();
      src?.delete();
    }
  },
  rotateImage(target) {
    let src, dst;
    try {
      src = cv.imread(target);
      dst = new cv.Mat();
      cv.rotate(src, dst, cv.ROTATE_90_CLOCKWISE);
      cv.imshow(target, dst);
    } finally {
      dst?.delete();
      src?.delete();
    }
  },
  filterTypes: [
    "original",
    "auto",
    "shadow",
    "lighten",
    "enhance",
    "eco",
    "grayscale",
    "bw",
    "magic",
  ],
  supportsFilter(type) {
    return this.filterTypes.includes(type);
  },
  supportsStrength(type) {
    return ["auto", "shadow", "lighten", "enhance", "eco", "bw"].includes(type);
  },
  normalizeSettings(settings = {}) {
    const value = Number(settings.strength);
    return {
      strength: Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 70,
      version: [1, 2].includes(settings.version) ? settings.version : 3,
      bwMode:
        settings.bwMode === "crisp" || [1, 2].includes(settings.version)
          ? "crisp"
          : "soft",
    };
  },
  // A coarse illumination field suppresses fine text before smoothing. Work at
  // <= 900 px so background estimation does not allocate several huge Mats.
  illuminationField(source) {
    let rgba, gray, small, closed, smooth, kernel;
    try {
      rgba = cv.imread(source);
      gray = new cv.Mat();
      cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
      const scale = Math.min(1, 900 / Math.max(gray.cols, gray.rows));
      const width = Math.max(1, Math.round(gray.cols * scale));
      const height = Math.max(1, Math.round(gray.rows * scale));
      small = new cv.Mat();
      closed = new cv.Mat();
      smooth = new cv.Mat();
      cv.resize(gray, small, new cv.Size(width, height), 0, 0, cv.INTER_AREA);
      const span = Math.max(3, Math.round(Math.min(width, height) * 0.035) | 1);
      kernel = cv.getStructuringElement(
        cv.MORPH_ELLIPSE,
        new cv.Size(span, span),
      );
      cv.morphologyEx(small, closed, cv.MORPH_CLOSE, kernel);
      const blur = Math.max(3, Math.round(Math.min(width, height) * 0.07) | 1);
      cv.GaussianBlur(
        closed,
        smooth,
        new cv.Size(blur, blur),
        0,
        0,
        cv.BORDER_REPLICATE,
      );
      return { width, height, data: new Uint8Array(smooth.data) };
    } finally {
      kernel?.delete();
      smooth?.delete();
      closed?.delete();
      small?.delete();
      gray?.delete();
      rgba?.delete();
    }
  },
  removeIllumination(source, pixels, width, height, amount) {
    const field = this.illuminationField(source);
    // Precompute bilinear horizontal coordinates; vertically interpolate per row.
    const left = new Uint16Array(width),
      right = new Uint16Array(width),
      blend = new Float32Array(width);
    for (let x = 0; x < width; x++) {
      const fx = Math.max(
        0,
        Math.min(field.width - 1, ((x + 0.5) * field.width) / width - 0.5),
      );
      left[x] = Math.floor(fx);
      right[x] = Math.min(left[x] + 1, field.width - 1);
      blend[x] = fx - left[x];
    }
    for (let y = 0; y < height; y++) {
      const fy = Math.max(
        0,
        Math.min(field.height - 1, ((y + 0.5) * field.height) / height - 0.5),
      );
      const y0 = Math.floor(fy),
        y1 = Math.min(y0 + 1, field.height - 1),
        wy = fy - y0;
      for (let x = 0; x < width; x++) {
        const wx = blend[x];
        const a =
          field.data[y0 * field.width + left[x]] * (1 - wx) +
          field.data[y0 * field.width + right[x]] * wx;
        const b =
          field.data[y1 * field.width + left[x]] * (1 - wx) +
          field.data[y1 * field.width + right[x]] * wx;
        const paper = a * (1 - wy) + b * wy;
        const gain =
          1 +
          (Math.min(2.6, Math.max(1, 248 / Math.max(95, paper))) - 1) * amount;
        const i = (y * width + x) * 4;
        pixels[i] = Math.min(255, pixels[i] * gain);
        pixels[i + 1] = Math.min(255, pixels[i + 1] * gain);
        pixels[i + 2] = Math.min(255, pixels[i + 2] * gain);
      }
    }
  },
  // Conservative percentile stretch. Clipping the black point is deliberately
  // limited so faint pencil/stamps are less likely to disappear.
  stretchDocument(pixels, amount) {
    const histogram = new Uint32Array(256);
    for (let i = 0; i < pixels.length; i += 4)
      histogram[
        Math.round(
          0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2],
        )
      ]++;
    const count = pixels.length / 4;
    function percentile(q) {
      let sum = 0;
      for (let i = 0; i < 256; i++) {
        sum += histogram[i];
        if (sum >= count * q) return i;
      }
      return 255;
    }
    const black = Math.min(28, percentile(0.005)),
      white = Math.max(210, percentile(0.99));
    const table = new Uint8Array(256);
    for (let v = 0; v < 256; v++) {
      const mapped = Math.max(
        0,
        Math.min(255, ((v - black) * 255) / Math.max(1, white - black)),
      );
      table[v] = Math.round(v + (mapped - v) * amount);
    }
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = table[pixels[i]];
      pixels[i + 1] = table[pixels[i + 1]];
      pixels[i + 2] = table[pixels[i + 2]];
    }
  },
  applyFilter(source, target, type, options = {}) {
    if (!this.supportsFilter(type))
      throw new Error("This filter is not available.");
    const settings = this.normalizeSettings(options),
      strength = settings.strength / 100;
    const input =
      typeof source === "string" ? document.getElementById(source) : source;
    const output =
      typeof target === "string" ? document.getElementById(target) : target;
    if (!input || !output)
      throw new Error("A source and destination canvas are required.");
    // Keep Stage 1 Magic, and legacy B&W when requested, pixel-compatible.
    if (type === "magic" || (type === "bw" && settings.version === 1)) {
      let src, dst;
      try {
        src = cv.imread(input);
        dst = new cv.Mat();
        if (type === "bw") {
          cv.cvtColor(src, dst, cv.COLOR_RGBA2GRAY);
          cv.GaussianBlur(dst, dst, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
          cv.adaptiveThreshold(
            dst,
            dst,
            255,
            cv.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv.THRESH_BINARY,
            11,
            2,
          );
        } else {
          cv.cvtColor(src, dst, cv.COLOR_RGBA2RGB);
          cv.convertScaleAbs(dst, dst, 1.2, 10);
        }
        cv.imshow(output, dst);
      } finally {
        dst?.delete();
        src?.delete();
      }
      return;
    }
    const work = document.createElement("canvas");
    work.width = input.width || input.naturalWidth;
    work.height = input.height || input.naturalHeight;
    if (!work.width || !work.height)
      throw new Error("The image has not loaded.");
    const context = work.getContext("2d", { willReadFrequently: true });
    context.drawImage(input, 0, 0, work.width, work.height);
    if (type !== "original") {
      const image = context.getImageData(0, 0, work.width, work.height),
        pixels = image.data;
      if (
        ["shadow", "enhance", "auto", "eco"].includes(type) ||
        (type === "bw" && (settings.version < 3 || settings.bwMode === "crisp"))
      ) {
        const correction =
          type === "shadow"
            ? strength
            : type === "bw"
              ? settings.version < 3
                ? 0.9
                : settings.bwMode === "soft"
                  ? 0.25 + strength * 0.35
                  : 0.65
              : strength * 0.85;
        this.removeIllumination(
          work,
          pixels,
          work.width,
          work.height,
          correction,
        );
      }
      if (["auto", "enhance", "eco"].includes(type))
        this.stretchDocument(pixels, strength * (type === "auto" ? 0.8 : 1));
      if (type === "lighten") {
        const table = new Uint8Array(256),
          exponent = 1 / (1 + strength * 0.85);
        for (let i = 0; i < 256; i++)
          table[i] = Math.round(255 * Math.pow(i / 255, exponent));
        for (let i = 0; i < pixels.length; i += 4) {
          pixels[i] = table[pixels[i]];
          pixels[i + 1] = table[pixels[i + 1]];
          pixels[i + 2] = table[pixels[i + 2]];
        }
      }
      if (type === "grayscale" || type === "eco") {
        for (let i = 0; i < pixels.length; i += 4) {
          const gray = Math.round(
            0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2],
          );
          // Eco softly pushes near-white paper towards white; it is not a file
          // compression setting or an automatic handwriting remover.
          const value =
            type === "eco" && gray > 200
              ? Math.round(gray + (255 - gray) * strength * 0.8)
              : gray;
          pixels[i] = pixels[i + 1] = pixels[i + 2] = value;
        }
      }
      context.putImageData(image, 0, 0);
      if (type === "bw") {
        let rgba, gray, binary;
        try {
          rgba = cv.imread(work);
          gray = new cv.Mat();
          binary = new cv.Mat();
          cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
          if (settings.version >= 3 && settings.bwMode === "soft") {
            // A mild, monotone global tone curve keeps gray detail without
            // thresholding, local edge halos, or aggressive paper normalization.
            // At zero sensitivity this is ordinary grayscale.
            gray.copyTo(binary);
            const table = new Uint8Array(256);
            const contrast = 1 + strength * 0.4,
              gamma = 1 / (1 + strength * 0.15);
            for (let value = 0; value < 256; value++) {
              const t = value / 255;
              const light = Math.pow(t, contrast),
                dark = Math.pow(1 - t, contrast);
              table[value] = Math.round(
                255 * Math.pow(light / (light + dark), gamma),
              );
            }
            for (let i = 0; i < gray.data.length; i++)
              binary.data[i] = table[gray.data[i]];
            cv.imshow(work, binary);
          } else {
            // A dimension-relative neighborhood behaves better across previews
            // and exports, though thumbnails remain approximate.
            const size = Math.max(
              3,
              Math.round(Math.min(work.width, work.height) * 0.025) | 1,
            );
            const bias = 2 + strength * 12;
            cv.adaptiveThreshold(
              gray,
              binary,
              255,
              cv.ADAPTIVE_THRESH_GAUSSIAN_C,
              cv.THRESH_BINARY,
              size,
              bias,
            );
            cv.imshow(work, binary);
          }
        } finally {
          binary?.delete();
          gray?.delete();
          rgba?.delete();
        }
      }
    }
    output.width = work.width;
    output.height = work.height;
    output.getContext("2d").drawImage(work, 0, 0);
    work.width = work.height = 1;
  },
  canInpaint() {
    return (
      typeof window.cv?.inpaint === "function" &&
      typeof window.cv?.INPAINT_TELEA === "number"
    );
  },
  applyAIErase(source, selection, target) {
    if (!this.canInpaint())
      throw new Error(
        "This OpenCV build does not include inpainting. Advanced erasing will be added in a later stage.",
      );
    let rgba, rgb, maskRgba, mask, dst;
    try {
      rgba = cv.imread(source);
      rgb = new cv.Mat();
      cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
      maskRgba = cv.imread(selection);
      mask = new cv.Mat();
      cv.cvtColor(maskRgba, mask, cv.COLOR_RGBA2GRAY);
      cv.threshold(mask, mask, 1, 255, cv.THRESH_BINARY);
      if (!cv.countNonZero(mask))
        throw new Error("Select an area before applying erase.");
      dst = new cv.Mat();
      cv.inpaint(rgb, mask, dst, 3, cv.INPAINT_TELEA);
      cv.imshow(target, dst);
    } finally {
      dst?.delete();
      mask?.delete();
      maskRgba?.delete();
      rgb?.delete();
      rgba?.delete();
    }
  },
};
