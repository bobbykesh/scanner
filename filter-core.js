/* Worker-only document recipes. OpenCV matrices are always released. */
"use strict";
self.FilterCore = (() => {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const canvas = (data) => {
    const c = new OffscreenCanvas(data.width, data.height);
    c.getContext("2d").putImageData(data, 0, 0);
    return c;
  };
  const mat = (data) => cv.matFromImageData(data);
  function imageFromMat(source) {
    const rgba = new cv.Mat();
    try {
      if (source.channels() === 1)
        cv.cvtColor(source, rgba, cv.COLOR_GRAY2RGBA);
      else if (source.channels() === 3)
        cv.cvtColor(source, rgba, cv.COLOR_RGB2RGBA);
      else source.copyTo(rgba);
      return new ImageData(
        new Uint8ClampedArray(rgba.data),
        rgba.cols,
        rgba.rows,
      );
    } finally {
      rgba.delete();
    }
  }
  function blur(data, radius = 3, sigma = 0.8) {
    let src, dst;
    try {
      src = mat(data);
      dst = new cv.Mat();
      cv.GaussianBlur(
        src,
        dst,
        new cv.Size(radius, radius),
        sigma,
        sigma,
        cv.BORDER_REPLICATE,
      );
      return imageFromMat(dst);
    } finally {
      dst?.delete();
      src?.delete();
    }
  }
  function bilateral(data, strength) {
    let src, rgb, dst;
    try {
      src = mat(data);
      rgb = new cv.Mat();
      dst = new cv.Mat();
      cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
      cv.bilateralFilter(
        rgb,
        dst,
        5,
        20 + 20 * strength,
        5,
        cv.BORDER_REPLICATE,
      );
      return imageFromMat(dst);
    } finally {
      dst?.delete();
      rgb?.delete();
      src?.delete();
    }
  }
  function grayscale(data) {
    const a = data.data;
    for (let i = 0; i < a.length; i += 4) {
      const g = clamp(0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2]);
      a[i] = a[i + 1] = a[i + 2] = g;
    }
  }
  function whiteBalance(data, amount) {
    const a = data.data,
      sum = [0, 0, 0];
    let count = 0;
    for (let i = 0; i < a.length; i += 16) {
      const r = a[i],
        g = a[i + 1],
        b = a[i + 2],
        high = Math.max(r, g, b),
        low = Math.min(r, g, b);
      if (low > 140 && high - low < 65) {
        sum[0] += r;
        sum[1] += g;
        sum[2] += b;
        count++;
      }
    }
    if (count < 24) return;
    const means = sum.map((v) => v / count),
      target = Math.max(...means);
    const gains = means.map(
      (v) =>
        1 +
        (Math.min(1.18, Math.max(0.85, target / Math.max(1, v))) - 1) * amount,
    );
    for (let i = 0; i < a.length; i += 4)
      for (let k = 0; k < 3; k++) a[i + k] = clamp(a[i + k] * gains[k]);
  }
  function stretch(data, amount = 0.4) {
    const a = data.data,
      hist = new Uint32Array(256);
    for (let i = 0; i < a.length; i += 4)
      hist[clamp(0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2])]++;
    function quantile(q) {
      let n = 0;
      for (let i = 0; i < 256; i++) {
        n += hist[i];
        if (n >= (a.length / 4) * q) return i;
      }
      return 255;
    }
    const low = Math.min(22, quantile(0.005)),
      high = Math.max(225, quantile(0.995)),
      lut = new Uint8Array(256);
    for (let i = 0; i < 256; i++)
      lut[i] = clamp(
        i + (clamp(((i - low) * 255) / Math.max(1, high - low)) - i) * amount,
      );
    for (let i = 0; i < a.length; i += 4)
      for (let k = 0; k < 3; k++) a[i + k] = lut[a[i + k]];
  }
  function illumination(data, amount = 1) {
    if (!amount) return;
    let src, gray, small, dilated, field, kernel;
    try {
      src = mat(data);
      gray = new cv.Mat();
      small = new cv.Mat();
      dilated = new cv.Mat();
      field = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      const scale = Math.min(1, 900 / Math.max(data.width, data.height));
      const w = Math.max(1, Math.round(data.width * scale)),
        h = Math.max(1, Math.round(data.height * scale));
      cv.resize(gray, small, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
      const size = Math.max(3, Math.round(Math.min(w, h) * 0.045) | 1),
        smooth = Math.max(3, Math.round(Math.min(w, h) * 0.085) | 1);
      kernel = cv.getStructuringElement(
        cv.MORPH_ELLIPSE,
        new cv.Size(size, size),
      );
      cv.dilate(small, dilated, kernel);
      cv.GaussianBlur(
        dilated,
        field,
        new cv.Size(smooth, smooth),
        0,
        0,
        cv.BORDER_REPLICATE,
      );
      const a = data.data,
        f = field.data,
        xs = new Int32Array(data.width),
        xe = new Int32Array(data.width),
        wx = new Float32Array(data.width);
      for (let x = 0; x < data.width; x++) {
        const p = Math.max(
          0,
          Math.min(w - 1, ((x + 0.5) * w) / data.width - 0.5),
        );
        xs[x] = Math.floor(p);
        xe[x] = Math.min(w - 1, xs[x] + 1);
        wx[x] = p - xs[x];
      }
      for (let y = 0; y < data.height; y++) {
        const py = Math.max(
            0,
            Math.min(h - 1, ((y + 0.5) * h) / data.height - 0.5),
          ),
          y0 = Math.floor(py),
          y1 = Math.min(h - 1, y0 + 1),
          wy = py - y0;
        for (let x = 0; x < data.width; x++) {
          const top =
              f[y0 * w + xs[x]] * (1 - wx[x]) + f[y0 * w + xe[x]] * wx[x],
            bottom =
              f[y1 * w + xs[x]] * (1 - wx[x]) + f[y1 * w + xe[x]] * wx[x];
          const bg = top * (1 - wy) + bottom * wy,
            gain = 1 + (Math.min(3.5, 255 / Math.max(65, bg)) - 1) * amount,
            i = (y * data.width + x) * 4;
          for (let k = 0; k < 3; k++) a[i + k] = clamp(a[i + k] * gain);
        }
      }
    } finally {
      kernel?.delete();
      field?.delete();
      dilated?.delete();
      small?.delete();
      gray?.delete();
      src?.delete();
    }
  }
  function sCurve(data, strength, pro = false) {
    const a = data.data,
      lut = new Uint8Array(256),
      exponent = pro ? 1.16 : 1.35;
    for (let i = 0; i < 256; i++) {
      const x = i / 255,
        p = Math.pow(x, exponent),
        q = Math.pow(1 - x, exponent);
      let v = (255 * p) / (p + q);
      if (i >= (pro ? 248 : 242)) v = 255;
      if (i <= (pro ? 6 : 10)) v = 0;
      lut[i] = clamp(i + (v - i) * strength);
    }
    for (let i = 0; i < a.length; i += 4)
      for (let k = 0; k < 3; k++) a[i + k] = lut[a[i + k]];
  }
  function saturate(data, gain) {
    const a = data.data;
    for (let i = 0; i < a.length; i += 4) {
      const g = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
      for (let k = 0; k < 3; k++) a[i + k] = clamp(g + (a[i + k] - g) * gain);
    }
  }
  function unsharp(data, amount) {
    if (!amount) return;
    const smooth = blur(data, 3, 0.8),
      a = data.data,
      b = smooth.data;
    for (let i = 0; i < a.length; i += 4) {
      const detail =
        (0.299 * (a[i] - b[i]) +
          0.587 * (a[i + 1] - b[i + 1]) +
          0.114 * (a[i + 2] - b[i + 2])) *
        amount;
      for (let k = 0; k < 3; k++) a[i + k] = clamp(a[i + k] + detail);
    }
  }
  function binary(data, strength, variant) {
    illumination(data, 0.85);
    const smooth = blur(data, 3, variant ? 0.4 : 0.65);
    let src, gray, out;
    try {
      src = mat(smooth);
      gray = new cv.Mat();
      out = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      const size = Math.max(
        3,
        Math.round(Math.min(data.width, data.height) * 0.035) | 1,
      );
      // Lower C retains fainter strokes (and potentially more paper noise).
      const bias = variant
        ? Math.max(0.5, 5 - strength * 0.045)
        : Math.max(1, 12 - strength * 0.11);
      cv.adaptiveThreshold(
        gray,
        out,
        255,
        cv.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv.THRESH_BINARY,
        size,
        bias,
      );
      return imageFromMat(out);
    } finally {
      out?.delete();
      gray?.delete();
      src?.delete();
    }
  }
  function adjustments(data, settings, strictBinary) {
    const a = data.data,
      brightness = Number(settings.brightness) || 0,
      contrast = Number(settings.contrast) || 0,
      sharpness = Number(settings.sharpness) || 0;
    if (brightness || contrast) {
      const factor = 1 + contrast / 100,
        offset = brightness * 1.5;
      for (let i = 0; i < a.length; i += 4)
        for (let k = 0; k < 3; k++)
          a[i + k] = clamp((a[i + k] - 128) * factor + 128 + offset);
    }
    unsharp(data, (sharpness / 100) * 1.2);
    if (strictBinary) {
      for (let i = 0; i < a.length; i += 4) {
        const v =
          0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2] >= 128 ? 255 : 0;
        a[i] = a[i + 1] = a[i + 2] = v;
        a[i + 3] = 255;
      }
    }
    return data;
  }
  function legacy(data, type, settings) {
    const input = canvas(data),
      output = new OffscreenCanvas(1, 1);
    VisionEngine.applyFilter(input, output, type, settings);
    return output
      .getContext("2d")
      .getImageData(0, 0, output.width, output.height);
  }
  function applyFilter(input, type, settings) {
    let data = new ImageData(
      new Uint8ClampedArray(input.data),
      input.width,
      input.height,
    );
    const strength = (settings.strength ?? 70) / 100;
    if (settings.version < 4) {
      data = legacy(data, type, settings);
      return adjustments(
        data,
        settings,
        type === "bw" && (settings.version < 3 || settings.bwMode === "crisp"),
      );
    }
    switch (type) {
      case "original":
        break;
      case "auto":
        whiteBalance(data, strength);
        stretch(data, 0.25 + 0.3 * strength);
        break;
      case "lighten": {
        const a = data.data,
          lut = new Uint8Array(256),
          gamma = 1 - 0.4 * strength;
        for (let v = 0; v < 256; v++) {
          const p = 255 * Math.pow(v / 255, gamma);
          lut[v] = clamp(p + 3 * strength * (1 - p / 255));
        }
        for (let i = 0; i < a.length; i += 4)
          for (let k = 0; k < 3; k++) a[i + k] = lut[a[i + k]];
        break;
      }
      case "shadow":
        illumination(data, strength);
        break;
      case "magic-color":
        illumination(data, Math.min(1, 0.85 * strength + 0.15));
        sCurve(data, strength);
        saturate(data, 1 + 0.25 * strength);
        unsharp(data, 0.25 * strength);
        break;
      case "magic-pro":
        data = bilateral(data, strength);
        illumination(data, 0.85 + 0.15 * strength);
        sCurve(data, strength, true);
        unsharp(data, 0.45 * strength);
        break;
      case "grayscale":
        grayscale(data);
        stretch(data, 0.22 * strength);
        {
          const a = data.data;
          for (let i = 0; i < a.length; i += 4) {
            const v = clamp(255 * Math.pow(a[i] / 255, 1 - 0.035 * strength));
            a[i] = a[i + 1] = a[i + 2] = v;
          }
        }
        break;
      case "bw":
        data = binary(data, settings.strength ?? 55, false);
        break;
      case "bw2":
        data = binary(data, settings.strength ?? 70, true);
        break;
      case "bw-soft":
        data = legacy(data, "bw", {
          strength: settings.strength,
          version: 3,
          bwMode: "soft",
        });
        break;
      case "enhance":
        whiteBalance(data, strength * 0.7);
        illumination(data, strength * 0.7);
        stretch(data, strength * 0.7);
        break;
      case "eco":
        illumination(data, strength * 0.65);
        grayscale(data);
        stretch(data, strength * 0.55);
        break;
      case "magic":
        data = legacy(data, "magic", { version: 3, strength: 70 });
        break;
      default:
        throw new Error("Unknown document filter: " + type);
    }
    return adjustments(data, settings, type === "bw" || type === "bw2");
  }
  function isBinary(data) {
    const a = data.data;
    for (let i = 0; i < a.length; i += 4)
      if (
        (a[i] !== 0 && a[i] !== 255) ||
        a[i + 1] !== a[i] ||
        a[i + 2] !== a[i] ||
        a[i + 3] !== 255
      )
        return false;
    return true;
  }
  return { applyFilter, isBinary };
})();
