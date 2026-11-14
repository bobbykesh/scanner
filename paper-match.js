"use strict";
// Immutable, reduced-size session snapshot. No inpainting or uploads.
window.PaperMatch = {
  create(source) {
    const scale = Math.min(1, 800 / Math.max(source.width, source.height)),
      c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(source.width * scale));
    c.height = Math.max(1, Math.round(source.height * scale));
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, c.width, c.height);
    const { data } = ctx.getImageData(0, 0, c.width, c.height),
      w = c.width,
      h = c.height;
    c.width = c.height = 1;
    const api = {
      estimate(bounds) {
        const x0 = Math.min(bounds.x0, bounds.x1) * scale,
          y0 = Math.min(bounds.y0, bounds.y1) * scale,
          x1 = Math.max(bounds.x0, bounds.x1) * scale,
          y1 = Math.max(bounds.y0, bounds.y1) * scale,
          samples = [];
        function add(x, y) {
          x = Math.round(x);
          y = Math.round(y);
          if (x < 0 || y < 0 || x >= w || y >= h) return;
          const i = (y * w + x) * 4;
          if (data[i + 3] < 240) return;
          const r = data[i],
            g = data[i + 1],
            b = data[i + 2];
          samples.push({ r, g, b, l: 0.2126 * r + 0.7152 * g + 0.0722 * b });
        }
        for (const distance of [3, 7, 13, 22]) {
          const left = x0 - distance,
            right = x1 + distance,
            top = y0 - distance,
            bottom = y1 + distance,
            steps = Math.min(
              160,
              Math.max(12, Math.ceil(Math.max(right - left, bottom - top) / 3)),
            );
          for (let j = 0; j <= steps; j++) {
            const t = j / steps;
            add(left + t * (right - left), top);
            add(left + t * (right - left), bottom);
            add(left, top + t * (bottom - top));
            add(right, top + t * (bottom - top));
          }
        }
        if (samples.length < 24)
          for (let y = 0; y < h; y += Math.max(1, Math.floor(h / 35)))
            for (let x = 0; x < w; x += Math.max(1, Math.floor(w / 35)))
              add(x, y);
        if (!samples.length) return "#ffffff";
        samples.sort((a, b) => a.l - b.l);
        const paper = samples.slice(
          Math.floor(samples.length * 0.35),
          Math.max(1, Math.ceil(samples.length * 0.95)),
        );
        return (
          "#" +
          ["r", "g", "b"]
            .map((k) => {
              const v = paper.map((p) => p[k]).sort((a, b) => a - b);
              return v[Math.floor(v.length / 2)].toString(16).padStart(2, "0");
            })
            .join("")
        );
      },
      pick(point) {
        const values = [[], [], []],
          x = Math.round(point.x * scale),
          y = Math.round(point.y * scale);
        for (let j = -1; j <= 1; j++)
          for (let i = -1; i <= 1; i++) {
            const px = Math.max(0, Math.min(w - 1, x + i)),
              py = Math.max(0, Math.min(h - 1, y + j)),
              offset = (py * w + px) * 4;
            for (let k = 0; k < 3; k++) values[k].push(data[offset + k]);
          }
        return (
          "#" +
          values
            .map((v) =>
              v
                .sort((a, b) => a - b)[4]
                .toString(16)
                .padStart(2, "0"),
            )
            .join("")
        );
      },
      field(bounds) {
        const x = Math.min(bounds.x0, bounds.x1),
          y = Math.min(bounds.y0, bounds.y1),
          width = Math.max(2, Math.abs(bounds.x1 - bounds.x0)),
          height = Math.max(2, Math.abs(bounds.y1 - bounds.y0));
        const positions = [
          [x, y],
          [x + width, y],
          [x, y + height],
          [x + width, y + height],
        ];
        const colors = positions
          .map(([px, py]) => api.estimate({ x0: px, y0: py, x1: px, y1: py }))
          .map((hex) =>
            [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)),
          );
        const baseHex = api.estimate(bounds),
          base = [1, 3, 5].map((i) => parseInt(baseHex.slice(i, i + 2), 16));
        const luminance = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        // A corner dominated by ink should not pull a dark wedge into the fill.
        for (let i = 0; i < colors.length; i++)
          if (luminance(colors[i]) < luminance(base) - 60)
            colors[i] = base.slice();
        const tile = document.createElement("canvas");
        tile.width = tile.height = 26;
        const context = tile.getContext("2d"),
          image = context.createImageData(26, 26);
        for (let j = 0; j < 26; j++)
          for (let i = 0; i < 26; i++) {
            const u = Math.max(0, Math.min(1, (i - 1) / 23)),
              v = Math.max(0, Math.min(1, (j - 1) / 23)),
              offset = (j * 26 + i) * 4;
            for (let k = 0; k < 3; k++)
              image.data[offset + k] = Math.round(
                (1 - v) * ((1 - u) * colors[0][k] + u * colors[1][k]) +
                  v * ((1 - u) * colors[2][k] + u * colors[3][k]),
              );
            image.data[offset + 3] = 255;
          }
        context.putImageData(image, 0, 0);
        return { tile, x, y, width, height };
      },
    };
    return api;
  },
};
