/* Public interface: await applyFilter(imageData, filterType, optionalSettings). */
"use strict";
(() => {
  const types = [
    "original",
    "auto",
    "lighten",
    "shadow",
    "magic-color",
    "magic-pro",
    "grayscale",
    "bw",
    "bw2",
    "bw-soft",
    "enhance",
    "eco",
    "magic",
  ];
  const aliases = {
    "no shadow": "shadow",
    "no-shadow": "shadow",
    "magic color": "magic-color",
    magiccolor: "magic-color",
    "magic pro": "magic-pro",
    magicpro: "magic-pro",
    "b&w": "bw",
    "b&w 2": "bw2",
    "bw-2": "bw2",
    "soft b&w": "bw-soft",
    "auto enhance": "auto",
  };
  function canonical(type) {
    const key = String(type || "original")
      .toLowerCase()
      .trim();
    return aliases[key] || key;
  }
  function defaults(type) {
    type = canonical(type);
    return {
      version: 4,
      strength:
        type === "bw"
          ? 55
          : type === "bw-soft"
            ? 40
            : type === "shadow"
              ? 90
              : type === "magic-color"
                ? 100
                : type === "magic-pro"
                  ? 85
                  : 70,
      bwMode: type === "bw-soft" ? "soft" : "crisp",
      brightness: 0,
      contrast: 0,
      sharpness: 0,
    };
  }
  function normalizeSettings(settings = {}, type = "original") {
    type = canonical(type);
    const result = { ...defaults(type), ...settings };
    result.version = [1, 2, 3, 4].includes(settings.version)
      ? settings.version
      : 4;
    if (["magic-color", "magic-pro", "bw2", "bw-soft"].includes(type))
      result.version = 4;
    for (const [key, low, high] of [
      ["strength", 0, 100],
      ["brightness", -50, 50],
      ["contrast", -50, 50],
      ["sharpness", 0, 100],
    ]) {
      const value = Number(result[key]);
      result[key] = Number.isFinite(value)
        ? Math.max(low, Math.min(high, value))
        : defaults(type)[key];
    }
    result.bwMode =
      result.version < 3 ? "crisp" : settings.bwMode || defaults(type).bwMode;
    return result;
  }
  let worker = null,
    ready = false,
    active = null,
    sequence = 0,
    timer = null,
    lastFailure = 0;
  const queue = [],
    pending = new Map();
  const stats = { completed: 0, lastDuration: 0, workerReady: false };
  const abort = () =>
    new DOMException("Obsolete processing request", "AbortError");
  function failAll(message) {
    const error = new Error(message);
    clearTimeout(timer);
    for (const job of pending.values()) job.reject(error);
    pending.clear();
    queue.length = 0;
    active = null;
    worker?.terminate();
    worker = null;
    ready = false;
    stats.workerReady = false;
    lastFailure = Date.now();
  }
  function ensureWorker() {
    if (worker) return;
    if (typeof Worker === "undefined")
      throw new Error(
        "This browser has no Web Worker support. Filters need a current browser.",
      );
    worker = new Worker(new URL("filter-worker.js", document.baseURI));
    timer = setTimeout(
      () =>
        failAll(
          "Filter worker startup timed out. Check all worker and vendor files, then reload.",
        ),
      90000,
    );
    worker.onerror = (event) => {
      event.preventDefault();
      failAll(
        "Filter worker could not load. Check worker files, browser support and worker-src permissions.",
      );
    };
    worker.onmessage = (event) => {
      const m = event.data;
      if (m.startupError) {
        failAll(m.startupError);
        return;
      }
      if (m.ready) {
        clearTimeout(timer);
        ready = true;
        stats.workerReady = true;
        pump();
        return;
      }
      if (!active || active.id !== m.id) return;
      const job = pending.get(m.id);
      pending.delete(m.id);
      active = null;
      if (job) {
        if (m.error) job.reject(new Error(m.error));
        else {
          stats.completed++;
          stats.lastDuration = m.duration;
          job.resolve(
            m.kind === "pdf"
              ? { ...m, bytes: new Uint8Array(m.bytes) }
              : new ImageData(
                  new Uint8ClampedArray(m.buffer),
                  m.width,
                  m.height,
                ),
          );
        }
      }
      pump();
    };
  }
  function pump() {
    if (!ready || active || !queue.length) return;
    queue.sort((a, b) => b.priority - a.priority || a.id - b.id);
    const job = queue.shift();
    if (!pending.has(job.id)) {
      pump();
      return;
    }
    active = job;
    worker.postMessage(
      {
        id: job.id,
        kind: job.kind,
        type: job.type,
        width: job.width,
        height: job.height,
        buffer: job.data.buffer,
        options: job.options,
      },
      [job.data.buffer],
    );
  }
  function enqueue(data, kind, type, options = {}, control = {}) {
    if (
      !data ||
      !Number.isInteger(data.width) ||
      !Number.isInteger(data.height) ||
      data.width < 1 ||
      data.height < 1 ||
      data.width * data.height > 20000000 ||
      !data.data ||
      data.data.length !== data.width * data.height * 4
    )
      return Promise.reject(
        new Error("Expected valid RGBA ImageData, up to 20 megapixels."),
      );
    return new Promise((resolve, reject) => {
      if (Date.now() - lastFailure < 1500) {
        reject(
          new Error(
            "Filter worker is unavailable. Check the deployment files and reload.",
          ),
        );
        return;
      }
      const id = ++sequence,
        job = {
          id,
          kind,
          type,
          options,
          width: data.width,
          height: data.height,
          data: new Uint8ClampedArray(data.data),
          group: control.group || "default",
          priority: control.priority ?? 1,
          resolve,
          reject,
        };
      pending.set(id, job);
      queue.push(job);
      try {
        ensureWorker();
        pump();
      } catch (error) {
        pending.delete(id);
        const i = queue.indexOf(job);
        if (i >= 0) queue.splice(i, 1);
        reject(error);
      }
    });
  }
  function cancel(group) {
    for (const [id, job] of pending)
      if (job.group === group) {
        pending.delete(id);
        job.reject(abort());
      }
    for (let i = queue.length - 1; i >= 0; i--)
      if (queue[i].group === group) queue.splice(i, 1);
  }
  async function applyFilter(data, type, settings = {}, control = {}) {
    type = canonical(type);
    if (!types.includes(type))
      throw new Error("Unknown document filter: " + type);
    return enqueue(
      data,
      "filter",
      type,
      normalizeSettings(settings, type),
      control,
    );
  }
  function releaseMemory() {
    clearTimeout(timer);
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    }
    worker = null;
    ready = false;
    stats.workerReady = false;
    active = null;
    for (const job of pending.values()) job.reject(abort());
    pending.clear();
    queue.length = 0;
    lastFailure = 0;
  }
  const api = {
    releaseMemory,
    repairImage: (data, mask, control = {}) => {
      if (
        data.width > 1024 ||
        data.height > 1024 ||
        mask.length !== data.width * data.height
      )
        return Promise.reject(
          new Error(
            "Repair needs a valid mask and a crop no larger than 1024 pixels per edge.",
          ),
        );
      return enqueue(
        data,
        "repair",
        null,
        { mask: new Uint8Array(mask) },
        control,
      );
    },
    applyFilter,
    preparePdfImage: (data, options = {}, control = {}) =>
      enqueue(data, "pdf", null, options, control),
    cancel,
    defaults,
    normalizeSettings,
    canonical,
    supportsFilter: (type) => types.includes(canonical(type)),
    supportsStrength: (type) =>
      !["original", "magic"].includes(canonical(type)),
    types,
    stats,
  };
  window.FilterProcessor = api;
  window.applyFilter = applyFilter;
})();
