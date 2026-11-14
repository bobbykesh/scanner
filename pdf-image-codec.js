"use strict";
self.PdfImageCodec = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  function chunk(type, data) {
    const out = new Uint8Array(data.length + 12),
      view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    let crc = 0xffffffff;
    for (let i = 4; i < 8 + data.length; i++)
      crc = table[(crc ^ out[i]) & 255] ^ (crc >>> 8);
    view.setUint32(out.length - 4, (crc ^ 0xffffffff) >>> 0);
    return out;
  }
  async function png1(data) {
    const row = Math.ceil(data.width / 8),
      raw = new Uint8Array((row + 1) * data.height),
      a = data.data;
    for (let y = 0; y < data.height; y++)
      for (let x = 0; x < data.width; x++)
        if (a[(y * data.width + x) * 4] === 255)
          raw[y * (row + 1) + 1 + (x >>> 3)] |= 1 << (7 - (x & 7));
    const compressed = new Uint8Array(
      await new Response(
        new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate")),
      ).arrayBuffer(),
    );
    const header = new Uint8Array(13),
      view = new DataView(header.buffer);
    view.setUint32(0, data.width);
    view.setUint32(4, data.height);
    header[8] = 1;
    header[9] = 0;
    const parts = [
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", compressed),
      chunk("IEND", new Uint8Array()),
    ];
    const output = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
    let position = 0;
    for (const p of parts) {
      output.set(p, position);
      position += p.length;
    }
    return output;
  }
  async function prepare(image, options = {}) {
    if (typeof OffscreenCanvas === "undefined")
      throw new Error(
        "Worker PDF encoding requires OffscreenCanvas. Use a current browser.",
      );
    const binary = FilterCore.isBinary(image),
      edge = Number(options.maxEdge) || 0,
      scale =
        edge > 0 ? Math.min(1, edge / Math.max(image.width, image.height)) : 1;
    const source = new OffscreenCanvas(image.width, image.height);
    source.getContext("2d").putImageData(image, 0, 0);
    let target = source;
    if (scale < 1) {
      target = new OffscreenCanvas(
        Math.max(1, Math.round(image.width * scale)),
        Math.max(1, Math.round(image.height * scale)),
      );
      const ctx = target.getContext("2d");
      ctx.imageSmoothingEnabled = !binary;
      ctx.drawImage(source, 0, 0, target.width, target.height);
      source.width = source.height = 1;
    }
    const width = target.width,
      height = target.height;
    let bytes, format, bitDepth;
    if (binary && typeof CompressionStream !== "undefined") {
      bytes = await png1(
        target.getContext("2d").getImageData(0, 0, width, height),
      );
      format = "PNG";
      bitDepth = 1;
    } else {
      const blob = await target.convertToBlob({
        type: binary ? "image/png" : "image/jpeg",
        quality: Math.max(0.2, Math.min(1, Number(options.quality) || 0.8)),
      });
      bytes = new Uint8Array(await blob.arrayBuffer());
      format = binary ? "PNG" : "JPEG";
      bitDepth = 8;
    }
    target.width = target.height = 1;
    return { bytes, format, width, height, binary, bitDepth };
  }
  return { prepare };
})();
