/* Bounded, local candidate detection. Never commits or discards source pixels. */
"use strict";
window.DocumentAutoCrop = {
  detect(source) {
    const scale = Math.min(1, 900 / Math.max(source.width, source.height)),
      c = document.createElement("canvas");
    c.width = Math.max(2, Math.round(source.width * scale));
    c.height = Math.max(2, Math.round(source.height * scale));
    c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
    const mats = [];
    const keep = (m) => {
      mats.push(m);
      return m;
    };
    let candidates = [];
    try {
      const src = keep(cv.imread(c)),
        gray = keep(new cv.Mat()),
        blur = keep(new cv.Mat());
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
      for (const mode of ["edge", "light", "dark"]) {
        const mask = keep(new cv.Mat());
        if (mode === "edge") {
          cv.Canny(blur, mask, 40, 120);
          const kernel = keep(cv.Mat.ones(3, 3, cv.CV_8U));
          cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);
        } else
          cv.threshold(
            blur,
            mask,
            0,
            255,
            (mode === "light" ? cv.THRESH_BINARY : cv.THRESH_BINARY_INV) |
              cv.THRESH_OTSU,
          );
        const contours = keep(new cv.MatVector()),
          hierarchy = keep(new cv.Mat());
        cv.findContours(
          mask,
          contours,
          hierarchy,
          cv.RETR_LIST,
          cv.CHAIN_APPROX_SIMPLE,
        );
        const ranked = [];
        for (let i = 0; i < contours.size(); i++) {
          let contour = contours.get(i);
          const area = Math.abs(cv.contourArea(contour));
          contour.delete();
          if (area > c.width * c.height * 0.18) ranked.push({ i, area });
        }
        ranked.sort((a, b) => b.area - a.area);
        for (const entry of ranked.slice(0, 24)) {
          const contour = contours.get(entry.i),
            poly = new cv.Mat();
          try {
            cv.approxPolyDP(
              contour,
              poly,
              0.018 * cv.arcLength(contour, true),
              true,
            );
            if (poly.rows !== 4 || !cv.isContourConvex(poly)) continue;
            let points = Array.from({ length: 4 }, (_, i) => ({
              x: poly.data32S[i * 2],
              y: poly.data32S[i * 2 + 1],
            }));
            const cx = points.reduce((s, p) => s + p.x, 0) / 4,
              cy = points.reduce((s, p) => s + p.y, 0) / 4;
            points.sort(
              (a, b) =>
                Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx),
            );
            let first = points.reduce(
              (best, p, i) =>
                p.x + p.y < points[best].x + points[best].y ? i : best,
              0,
            );
            points = [...points.slice(first), ...points.slice(0, first)];
            const area = entry.area / (c.width * c.height);
            if (
              area > 0.95 ||
              points.some(
                (p) =>
                  p.x < 3 || p.y < 3 || p.x > c.width - 4 || p.y > c.height - 4,
              )
            )
              continue;
            const lengths = points.map((p, i) =>
              Math.hypot(
                p.x - points[(i + 1) % 4].x,
                p.y - points[(i + 1) % 4].y,
              ),
            );
            if (
              Math.min(...lengths) < Math.min(c.width, c.height) * 0.18 ||
              Math.max(...lengths) / Math.min(...lengths) > 6
            )
              continue;
            let angleQuality = 1;
            for (let i = 0; i < 4; i++) {
              const p = points[i],
                a = points[(i + 3) % 4],
                b = points[(i + 1) % 4];
              let cosine = Math.abs(
                ((a.x - p.x) * (b.x - p.x) + (a.y - p.y) * (b.y - p.y)) /
                  (lengths[(i + 3) % 4] * lengths[i]),
              );
              angleQuality = Math.min(angleQuality, 1 - cosine);
            }
            if (angleQuality < 0.35) continue;
            // Reject flat/no-contrast shapes by comparing edge-adjacent pixels.
            const pixels = c
              .getContext("2d")
              .getImageData(0, 0, c.width, c.height).data;
            const sample = (x, y) => {
              x = Math.max(0, Math.min(c.width - 1, Math.round(x)));
              y = Math.max(0, Math.min(c.height - 1, Math.round(y)));
              const j = (y * c.width + x) * 4;
              return (pixels[j] + pixels[j + 1] + pixels[j + 2]) / 3;
            };
            let contrast = 0;
            for (let i = 0; i < 4; i++) {
              const a = points[i],
                b = points[(i + 1) % 4];
              let v = 0;
              for (let t of [0.25, 0.5, 0.75]) {
                let x = a.x + (b.x - a.x) * t,
                  y = a.y + (b.y - a.y) * t,
                  dx = cx - x,
                  dy = cy - y,
                  d = Math.hypot(dx, dy);
                v +=
                  Math.abs(
                    sample(x + (dx / d) * 5, y + (dy / d) * 5) -
                      sample(x - (dx / d) * 5, y - (dy / d) * 5),
                  ) / 3;
              }
              contrast += Math.min(1, v / 45) / 4;
            }
            if (contrast < 0.3) continue;
            candidates.push({
              points,
              score: area * 0.45 + angleQuality * 0.25 + contrast * 0.3,
            });
          } finally {
            contour.delete();
            poly.delete();
          }
        }
      }
      candidates.sort((a, b) => b.score - a.score);
      if (!candidates.length) return null;
      const best = candidates[0];
      if (best.score < 0.52) return null;
      // A similarly scored, materially different boundary is ambiguous.
      if (
        candidates.some(
          (v) =>
            v.score > best.score - 0.045 &&
            v.points.some(
              (p, i) =>
                Math.hypot(p.x - best.points[i].x, p.y - best.points[i].y) >
                Math.min(c.width, c.height) * 0.12,
            ),
        )
      )
        return null;
      return {
        points: best.points.map((p) => ({
          x: Math.max(0, Math.min(source.width - 1, p.x / scale)),
          y: Math.max(0, Math.min(source.height - 1, p.y / scale)),
        })),
        score: best.score,
      };
    } finally {
      for (const m of mats.reverse()) m.delete();
      c.width = c.height = 1;
    }
  },
};
