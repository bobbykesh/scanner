"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $("canvas-input"),
    previewCanvas = $("canvas-preview");
  const finalCanvas = $("canvas-final"),
    bufferCanvas = $("canvas-buffer"),
    maskCanvas = $("canvas-mask");
  const selection = document.createElement("canvas");
  let currentImage = null,
    proxyImage = null,
    corners = [],
    cropHistory = [];
  let currentFilter = "original",
    documentPages = [],
    activePageId = null;
  let visionReady = false,
    busy = false,
    dirty = false,
    saving = false;
  let previewFrame = null,
    importVersion = 0,
    activeView = "upload-area";
  let editUndo = null,
    filterSession = null,
    eraseActive = false,
    drawing = null;
  let eraseTool = "pen",
    updateRegistration = null,
    storageAvailable = true,
    storageReadable = true;
  let currentFilterSettings = FilterProcessor.defaults("original");
  let filterPreviewTimer = null,
    thumbnailEpoch = 0;
  const MAX_EDGE = 2800,
    MAX_FILE_BYTES = 35 * 1024 * 1024;
  const VIEW_IDS = ["upload-area", "crop-view", "process-view", "gallery-view"];

  function notice(message, error = false) {
    const box = $("status-message");
    box.textContent = message;
    box.classList.toggle("error", error);
    box.hidden = false;
  }
  function fail(message, error) {
    console.error(message, error);
    notice(`${message} ${error?.message || String(error || "")}`, true);
  }
  function showView(id) {
    activeView = id;
    VIEW_IDS.forEach((view) => {
      $(view).hidden = view !== id;
    });
    $("btn-return-gallery").hidden = !documentPages.length;
    if (id === "crop-view")
      requestAnimationFrame(() => {
        renderStudio();
        updatePreview();
      });
  }
  function setLoading(message, visible = true) {
    $("loading-text").textContent = message;
    $("loading-overlay").hidden = !visible;
    $("loading-overlay").querySelector(".loader").hidden = false;
    $("btn-retry").hidden = true;
  }
  function copy(source, target) {
    target.width = source.width;
    target.height = source.height;
    target.getContext("2d").drawImage(source, 0, 0);
    return target;
  }
  function clone(source) {
    return copy(source, document.createElement("canvas"));
  }
  function loadImage(source) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () =>
        image.naturalWidth && image.naturalHeight
          ? resolve(image)
          : reject(new Error("Invalid image dimensions."));
      image.onerror = () =>
        reject(new Error("Cannot decode this image. Try JPEG, PNG or WebP."));
      image.src = source;
    });
  }
  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () =>
        reject(reader.error || new Error("File read failed."));
      reader.onabort = () => reject(new Error("File read cancelled."));
      reader.readAsDataURL(file);
    });
  }
  async function runTask(message, task) {
    if (busy || saving) return false;
    if (!visionReady) {
      notice("The image engine is not ready.", true);
      return false;
    }
    busy = true;
    setLoading(message);
    if (previewFrame !== null) {
      cancelAnimationFrame(previewFrame);
      previewFrame = null;
    }
    try {
      await new Promise((resolve) =>
        requestAnimationFrame(() => setTimeout(resolve, 0)),
      );
      await task();
      return true;
    } catch (error) {
      fail("Operation failed; please try again.", error);
      return false;
    } finally {
      busy = false;
      $("loading-overlay").hidden = true;
      if (activeView === "crop-view") updatePreview();
    }
  }
  function markDirty() {
    dirty = true;
  }
  function rememberEdit() {
    // One bounded undo level, avoiding an unbounded stack of full-resolution images.
    clearEditUndo();
    editUndo = {
      base: clone(bufferCanvas),
      final: clone(finalCanvas),
      filter: currentFilter,
      settings: { ...currentFilterSettings },
    };
    $("btn-undo-edit").disabled = false;
  }
  function clearEditUndo() {
    if (editUndo) {
      editUndo.base.width = editUndo.base.height = 1;
      editUndo.final.width = editUndo.final.height = 1;
    }
    editUndo = null;
    $("btn-undo-edit").disabled = true;
  }
  function syncFilters(type) {
    document.querySelectorAll(".filter-item[data-filter]").forEach((item) => {
      const selected = item.dataset.filter === type;
      item.classList.toggle("active", selected);
      item.setAttribute("aria-pressed", String(selected));
    });
  }
  function initProxy() {
    proxyImage = document.createElement("canvas");
    const scale = Math.min(
      1,
      800 / Math.max(currentImage.width, currentImage.height),
    );
    proxyImage.width = Math.max(2, Math.round(currentImage.width * scale));
    proxyImage.height = Math.max(2, Math.round(currentImage.height * scale));
    proxyImage
      .getContext("2d")
      .drawImage(currentImage, 0, 0, proxyImage.width, proxyImage.height);
  }
  function defaultCorners() {
    return [
      { x: currentImage.width * 0.05, y: currentImage.height * 0.05 },
      { x: currentImage.width * 0.95, y: currentImage.height * 0.05 },
      { x: currentImage.width * 0.95, y: currentImage.height * 0.95 },
      { x: currentImage.width * 0.05, y: currentImage.height * 0.95 },
    ];
  }
  function initStudio() {
    canvas.width = currentImage.width;
    canvas.height = currentImage.height;
    corners = defaultCorners();
    cropHistory = [];
    $("btn-undo").disabled = true;
    $("btn-crop").disabled = false;
    $("preview-status").textContent = "";
    showView("crop-view");
  }
  async function importFile(file) {
    if (!file || busy || saving || !visionReady) return;
    const version = ++importVersion;
    await runTask("Opening document…", async () => {
      if (file.type && !file.type.startsWith("image/"))
        throw new Error("Choose an image file.");
      if (file.size > MAX_FILE_BYTES)
        throw new Error("Choose an image smaller than 35 MB.");
      const image = await loadImage(await readFile(file));
      if (version !== importVersion) return;
      const scale = Math.min(
        1,
        MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight),
      );
      const normalized = document.createElement("canvas");
      normalized.width = Math.max(2, Math.round(image.naturalWidth * scale));
      normalized.height = Math.max(2, Math.round(image.naturalHeight * scale));
      const ctx = normalized.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, normalized.width, normalized.height);
      ctx.drawImage(image, 0, 0, normalized.width, normalized.height);
      currentImage = normalized;
      initProxy();
      activePageId = null;
      currentFilter = "original";
      currentFilterSettings = FilterProcessor.defaults("original");
      clearEditUndo();
      syncFilters(currentFilter);
      markDirty();
      $("btn-save-page").textContent = "Add to Doc";
      initStudio();
      notice(
        scale < 1
          ? "Image resized to a maximum edge of 2800 px for safer mobile processing. Keep your original file for full resolution."
          : "Image opened. Adjust the four corners, then flatten.",
      );
    });
  }
  function renderStudio() {
    if (!currentImage || activeView !== "crop-view") return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(currentImage, 0, 0);
    ctx.beginPath();
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = Math.max(2, canvas.width / 250);
    corners.forEach((p, i) =>
      i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y),
    );
    ctx.closePath();
    ctx.stroke();
    const holder = $("handle-container");
    if (!holder.children.length) {
      ["Top left", "Top right", "Bottom right", "Bottom left"].forEach(
        (label, index) => {
          const handle = document.createElement("button");
          handle.className = "handle";
          handle.type = "button";
          handle.setAttribute(
            "aria-label",
            `${label} crop corner; use arrow keys to adjust`,
          );
          handle.addEventListener("pointerdown", (event) =>
            startDrag(event, index),
          );
          handle.addEventListener("keydown", (event) => {
            const offsets = {
              ArrowLeft: [-1, 0],
              ArrowRight: [1, 0],
              ArrowUp: [0, -1],
              ArrowDown: [0, 1],
            };
            if (!offsets[event.key] || busy) return;
            event.preventDefault();
            pushCropHistory();
            const step = event.shiftKey ? 20 : 3;
            corners[index].x = Math.max(
              0,
              Math.min(
                canvas.width - 1,
                corners[index].x + offsets[event.key][0] * step,
              ),
            );
            corners[index].y = Math.max(
              0,
              Math.min(
                canvas.height - 1,
                corners[index].y + offsets[event.key][1] * step,
              ),
            );
            renderStudio();
            updatePreview();
            markDirty();
          });
          holder.appendChild(handle);
        },
      );
    }
    [...holder.children].forEach((handle, i) => {
      handle.style.left = `${(corners[i].x / canvas.width) * 100}%`;
      handle.style.top = `${(corners[i].y / canvas.height) * 100}%`;
    });
  }
  function pushCropHistory() {
    cropHistory.push(corners.map((p) => ({ ...p })));
    if (cropHistory.length > 30) cropHistory.shift();
    $("btn-undo").disabled = false;
  }
  function updatePreview() {
    if (!visionReady || !proxyImage || busy || activeView !== "crop-view")
      return;
    if (previewFrame !== null) cancelAnimationFrame(previewFrame);
    previewFrame = requestAnimationFrame(() => {
      previewFrame = null;
      if (busy || activeView !== "crop-view") return;
      try {
        const points = corners.map((p) => ({
          x: (p.x * proxyImage.width) / canvas.width,
          y: (p.y * proxyImage.height) / canvas.height,
        }));
        VisionEngine.warpPerspective(proxyImage, points, previewCanvas);
        $("preview-status").textContent = "";
      } catch (error) {
        $("preview-status").textContent =
          error.message || "Adjust the crop corners.";
      }
    });
  }
  function startDrag(event, index) {
    if (busy || event.button !== 0) return;
    event.preventDefault();
    pushCropHistory();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const move = (e) => {
      if (e.pointerId !== event.pointerId) return;
      const rect = canvas.getBoundingClientRect();
      corners[index] = {
        x: Math.max(
          0,
          Math.min(
            canvas.width - 1,
            ((e.clientX - rect.left) * canvas.width) / rect.width,
          ),
        ),
        y: Math.max(
          0,
          Math.min(
            canvas.height - 1,
            ((e.clientY - rect.top) * canvas.height) / rect.height,
          ),
        ),
      };
      renderStudio();
      updatePreview();
      markDirty();
    };
    const end = (e) => {
      if (e.pointerId !== event.pointerId) return;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      handle.removeEventListener("lostpointercapture", end);
      if (handle.hasPointerCapture(event.pointerId))
        handle.releasePointerCapture(event.pointerId);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    handle.addEventListener("lostpointercapture", end);
  }
  $("drop-zone").addEventListener("click", () => $("file-input").click());
  $("file-input").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    importFile(file);
  });
  ["dragenter", "dragover"].forEach((type) =>
    $("drop-zone").addEventListener(type, (e) => {
      e.preventDefault();
      $("drop-zone").classList.add("dragover");
    }),
  );
  ["dragleave", "drop"].forEach((type) =>
    $("drop-zone").addEventListener(type, (e) => {
      e.preventDefault();
      $("drop-zone").classList.remove("dragover");
      if (type === "drop") importFile(e.dataTransfer.files[0]);
    }),
  );
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
  window.addEventListener("resize", () => {
    renderStudio();
    updatePreview();
  });
  $("btn-undo").addEventListener("click", () => {
    if (!cropHistory.length || busy) return;
    corners = cropHistory.pop();
    $("btn-undo").disabled = !cropHistory.length;
    renderStudio();
    updatePreview();
  });
  $("btn-reset").addEventListener("click", () => {
    if (busy) return;
    pushCropHistory();
    corners = defaultCorners();
    renderStudio();
    updatePreview();
    markDirty();
  });
  $("btn-cancel-crop").addEventListener("click", () => {
    if (dirty && !confirm("Discard this unsaved scan?")) return;
    dirty = false;
    showView(documentPages.length ? "gallery-view" : "upload-area");
  });
  $("btn-crop").addEventListener("click", async () => {
    const ok = await runTask("Flattening document…", async () => {
      const nextBase = document.createElement("canvas"),
        nextFinal = document.createElement("canvas");
      VisionEngine.warpPerspective(currentImage, corners, nextBase);
      await renderFilter(
        nextBase,
        nextFinal,
        currentFilter,
        currentFilterSettings,
      );
      copy(nextBase, bufferCanvas);
      copy(nextFinal, finalCanvas);
      clearEditUndo();
      markDirty();
    });
    if (ok) showView("process-view");
    else updatePreview();
  });

  // All preset/adjustment processing is asynchronous and runs in the worker.
  const filterDescriptions = {
    original:
      "Raw cropped working pixels at neutral adjustments. After covering, Original means the edited working base.",
    auto: "Automatic white balance and gentle histogram stretching. Natural local processing, not AI.",
    lighten:
      "Gamma-based brightening with a soft highlight offset. Inspect faint pencil before saving.",
    shadow:
      "Large-kernel dilation + heavy blur estimate paper illumination; division reduces gradual shadows. Not recovery of hidden detail.",
    "magic-color":
      "Shadow flattening, white-paper S-curve, saturation boost and light unsharp masking. Strong settings may remove pale marks.",
    "magic-pro":
      "Bilateral texture smoothing, stronger illumination normalization and text sharpening. Heavy damage cannot be reliably restored.",
    grayscale:
      "Perceptual luminance, moderate contrast and a slight paper lift; continuous gray tones are preserved.",
    bw: "Strict black/white output using blur and local adaptive thresholding. Higher sensitivity retains more faint ink and may retain noise.",
    bw2: "More sensitive binary preset with less blur and a lower threshold bias for faint strokes; check for background speckles.",
    "bw-soft":
      "The previous gentle grayscale B&W style, kept as a separate non-binary option.",
    enhance:
      "Local white balance, paper normalization and contrast enhancement.",
    eco: "Lighter grayscale working preset; export compression is a separate setting.",
    magic:
      "Legacy Stage 1 contrast preset, retained for compatibility. This is not Magic Color.",
  };
  function settingsKey(type, settings) {
    return JSON.stringify({
      type,
      ...FilterProcessor.normalizeSettings(settings, type),
    });
  }
  function scaledCanvas(source, edge) {
    const result = document.createElement("canvas"),
      scale = Math.min(1, edge / Math.max(source.width, source.height));
    result.width = Math.max(1, Math.round(source.width * scale));
    result.height = Math.max(1, Math.round(source.height * scale));
    result
      .getContext("2d")
      .drawImage(source, 0, 0, result.width, result.height);
    return result;
  }
  function canvasData(source) {
    return source
      .getContext("2d", { willReadFrequently: true })
      .getImageData(0, 0, source.width, source.height);
  }
  async function renderFilter(source, target, type, settings, control = {}) {
    const options = FilterProcessor.normalizeSettings(settings, type);
    if (
      type === "original" &&
      !options.brightness &&
      !options.contrast &&
      !options.sharpness
    ) {
      copy(source, target);
      return;
    }
    const result = await applyFilter(
      canvasData(source),
      type,
      options,
      control,
    );
    target.width = result.width;
    target.height = result.height;
    target.getContext("2d").putImageData(result, 0, 0);
  }
  function positionFilterPreview() {
    if (!filterSession) return;
    document.body.style.setProperty(
      "--filter-sheet-height",
      `${$("filter-modal").getBoundingClientRect().height + 14}px`,
    );
  }
  if (typeof ResizeObserver !== "undefined")
    new ResizeObserver(positionFilterPreview).observe($("filter-modal"));
  window.addEventListener("resize", positionFilterPreview);
  function updateFilterControls() {
    const session = filterSession;
    if (!session) return;
    syncFilters(session.selected);
    $("filter-strength").disabled = !FilterProcessor.supportsStrength(
      session.selected,
    );
    $("filter-strength").value = session.settings.strength;
    $("filter-strength-value").value = `${session.settings.strength}%`;
    $("filter-strength-label").textContent = ["bw", "bw2"].includes(
      session.selected,
    )
      ? "Sensitivity"
      : "Strength";
    const legacy = session.settings.version < 4;
    $("filter-modernize").hidden = !legacy;
    $("bw-controls").hidden = !(session.selected === "bw" && legacy);
    $("bw-mode").value = session.settings.bwMode || "crisp";
    $("filter-description").textContent =
      (legacy
        ? "Saved legacy recipe preserved. Use updated preset to switch algorithms. "
        : "") + filterDescriptions[session.selected];
    for (const name of ["brightness", "contrast", "sharpness"]) {
      $("adjust-" + name).value = session.settings[name] || 0;
      $("adjust-" + name + "-value").value = String(
        session.settings[name] || 0,
      );
    }
    $("filter-compare").textContent = session.comparing
      ? "Show filter"
      : "Show source";
    $("filter-compare").setAttribute("aria-pressed", String(session.comparing));
    session.presetSettings[session.selected] = { ...session.settings };
  }
  async function generateThumbnails(session) {
    const epoch = ++thumbnailEpoch;
    FilterProcessor.cancel("thumbs");
    for (const item of document.querySelectorAll(".filter-item[data-filter]")) {
      if (filterSession !== session || epoch !== thumbnailEpoch) return;
      const target = item.querySelector("canvas"),
        label = item.querySelector(".thumbnail-loading");
      try {
        await renderFilter(
          session.thumbnailBase,
          target,
          item.dataset.filter,
          session.presetSettings[item.dataset.filter] ||
            FilterProcessor.defaults(item.dataset.filter),
          { group: "thumbs", priority: 0 },
        );
        if (filterSession !== session || epoch !== thumbnailEpoch) return;
        label.hidden = true;
      } catch (error) {
        if (error.name === "AbortError") return;
        label.hidden = false;
        label.textContent = "Preview unavailable";
        console.warn(error);
        return;
      }
    }
  }
  function queueFilterPreview(delay = 0) {
    if (!filterSession || busy) return;
    clearTimeout(filterPreviewTimer);
    FilterProcessor.cancel("preview");
    const session = filterSession,
      request = ++session.request;
    session.pending = true;
    $("filter-confirm").disabled = true;
    $("filter-status").textContent = "Processing preview in background…";
    filterPreviewTimer = setTimeout(async () => {
      filterPreviewTimer = null;
      if (filterSession !== session || busy) return;
      const selected = session.selected,
        settings = { ...session.settings };
      try {
        const result = document.createElement("canvas");
        if (
          settingsKey(selected, settings) ===
          settingsKey(session.previousFilter, session.previousSettings)
        )
          copy(scaledCanvas(session.previous, 1200), result);
        else
          await renderFilter(session.previewBase, result, selected, settings, {
            group: "preview",
            priority: 2,
          });
        if (filterSession !== session || session.request !== request) return;
        session.previewResult = result;
        if (!session.comparing) copy(result, finalCanvas);
        session.valid = true;
        $("filter-status").textContent =
          "Preview ready · Apply renders full working resolution. Thumbnails are approximate.";
      } catch (error) {
        if (
          filterSession !== session ||
          session.request !== request ||
          error.name === "AbortError"
        )
          return;
        session.valid = false;
        $("filter-status").textContent =
          `Preview failed: ${error.message || String(error)}. Cancel or retry a preset.`;
        console.error(error);
      } finally {
        if (filterSession === session && session.request === request) {
          session.pending = false;
          $("filter-confirm").disabled = !session.valid;
        }
      }
    }, delay);
  }
  $("btn-open-filters").addEventListener("click", () => {
    if (busy || saving || eraseActive || filterSession) return;
    const previous = clone(finalCanvas);
    filterSession = {
      previous,
      previousFilter: currentFilter,
      previousSettings: { ...currentFilterSettings },
      presetSettings: { [currentFilter]: { ...currentFilterSettings } },
      selected: currentFilter,
      settings: { ...currentFilterSettings },
      previewBase: scaledCanvas(bufferCanvas, 1200),
      thumbnailBase: scaledCanvas(bufferCanvas, 260),
      previewResult: scaledCanvas(previous, 1200),
      comparing: false,
      pending: false,
      valid: true,
      request: 0,
    };
    document.body.classList.add("filtering");
    updateFilterControls();
    $("filter-confirm").disabled = false;
    $("filter-status").textContent =
      "Current appearance preserved · presets process in a background worker.";
    document.querySelectorAll(".thumbnail-loading").forEach((label) => {
      label.hidden = false;
      label.textContent = "Loading…";
    });
    $("filter-modal").showModal();
    positionFilterPreview();
    const active = document.querySelector(".filter-item.active");
    if (active)
      $("filter-modal").querySelector(".filter-grid").scrollLeft = Math.max(
        0,
        active.offsetLeft - 24,
      );
    generateThumbnails(filterSession);
  });
  document.querySelectorAll(".filter-item[data-filter]").forEach((item) =>
    item.addEventListener("click", () => {
      if (!filterSession || busy) return;
      filterSession.presetSettings[filterSession.selected] = {
        ...filterSession.settings,
      };
      filterSession.selected = item.dataset.filter;
      filterSession.settings = {
        ...(filterSession.presetSettings[item.dataset.filter] ||
          FilterProcessor.defaults(item.dataset.filter)),
      };
      filterSession.comparing = false;
      updateFilterControls();
      queueFilterPreview();
    }),
  );
  $("filter-strength").addEventListener("input", () => {
    if (!filterSession || busy) return;
    filterSession.settings.strength = Number($("filter-strength").value);
    filterSession.comparing = false;
    updateFilterControls();
    queueFilterPreview(100);
  });
  $("filter-strength").addEventListener("change", () => {
    if (filterSession) generateThumbnails(filterSession);
  });
  $("bw-mode").addEventListener("change", () => {
    if (!filterSession || busy) return;
    filterSession.settings = {
      ...filterSession.settings,
      version: 3,
      bwMode: $("bw-mode").value,
    };
    filterSession.comparing = false;
    updateFilterControls();
    queueFilterPreview();
    generateThumbnails(filterSession);
  });
  $("filter-modernize").addEventListener("click", () => {
    if (!filterSession || busy) return;
    filterSession.settings = FilterProcessor.defaults(filterSession.selected);
    filterSession.comparing = false;
    updateFilterControls();
    queueFilterPreview();
    generateThumbnails(filterSession);
  });
  for (const name of ["brightness", "contrast", "sharpness"]) {
    $("adjust-" + name).addEventListener("input", () => {
      if (!filterSession || busy) return;
      filterSession.settings[name] = Number($("adjust-" + name).value);
      filterSession.comparing = false;
      updateFilterControls();
      queueFilterPreview(120);
    });
  }
  $("filter-reset-adjustments").addEventListener("click", () => {
    if (!filterSession || busy) return;
    Object.assign(filterSession.settings, {
      brightness: 0,
      contrast: 0,
      sharpness: 0,
    });
    filterSession.comparing = false;
    updateFilterControls();
    queueFilterPreview();
  });
  $("filter-compare").addEventListener("click", () => {
    if (!filterSession || busy) return;
    filterSession.comparing = !filterSession.comparing;
    copy(
      filterSession.comparing
        ? filterSession.previewBase
        : filterSession.previewResult,
      finalCanvas,
    );
    updateFilterControls();
  });
  function closeFilterSession() {
    clearTimeout(filterPreviewTimer);
    filterPreviewTimer = null;
    thumbnailEpoch++;
    FilterProcessor.cancel("preview");
    FilterProcessor.cancel("thumbs");
    filterSession = null;
    document.body.classList.remove("filtering");
    $("filter-modal").close();
  }
  function cancelFilters() {
    if (busy) return;
    if (filterSession) {
      copy(filterSession.previous, finalCanvas);
      syncFilters(filterSession.previousFilter);
    }
    closeFilterSession();
  }
  $("filter-cancel").addEventListener("click", cancelFilters);
  $("filter-modal").addEventListener("cancel", (event) => {
    event.preventDefault();
    cancelFilters();
  });
  $("filter-confirm").addEventListener("click", async () => {
    const session = filterSession;
    if (!session || session.pending || !session.valid || busy) return;
    if (
      settingsKey(session.selected, session.settings) ===
      settingsKey(session.previousFilter, session.previousSettings)
    ) {
      copy(session.previous, finalCanvas);
      closeFilterSession();
      return;
    }
    busy = true;
    FilterProcessor.cancel("thumbs");
    const controls = [
      ...$("filter-modal").querySelectorAll("button,input,select"),
    ];
    controls.forEach((c) => {
      c.disabled = true;
    });
    $("filter-status").textContent =
      "Applying full working resolution in the background…";
    try {
      const result = document.createElement("canvas");
      await renderFilter(
        bufferCanvas,
        result,
        session.selected,
        session.settings,
        { group: "apply", priority: 4 },
      );
      clearEditUndo();
      editUndo = {
        base: clone(bufferCanvas),
        final: session.previous,
        filter: session.previousFilter,
        settings: { ...session.previousSettings },
      };
      $("btn-undo-edit").disabled = false;
      copy(result, finalCanvas);
      currentFilter = session.selected;
      currentFilterSettings = { ...session.settings };
      markDirty();
      closeFilterSession();
    } catch (error) {
      $("filter-status").textContent =
        `Apply failed: ${error.message || String(error)}. Your previous result is retained; cancel or try another preset.`;
      console.error(error);
    } finally {
      busy = false;
      controls.forEach((c) => {
        c.disabled = false;
      });
      if (filterSession) updateFilterControls();
    }
  });

  $("btn-rotate").addEventListener("click", async () => {
    await runTask("Rotating document…", () => {
      const base = clone(bufferCanvas),
        result = clone(finalCanvas);
      VisionEngine.rotateImage(base);
      VisionEngine.rotateImage(result);
      rememberEdit();
      copy(base, bufferCanvas);
      copy(result, finalCanvas);
      markDirty();
    });
  });
  $("btn-undo-edit").addEventListener("click", () => {
    if (!editUndo || busy || eraseActive) return;
    copy(editUndo.base, bufferCanvas);
    copy(editUndo.final, finalCanvas);
    currentFilter = editUndo.filter;
    currentFilterSettings = { ...editUndo.settings };
    syncFilters(currentFilter);
    clearEditUndo();
    markDirty();
  });

  // Stage 3 manual editor: opaque cover commands stay in a transparent overlay
  // until Apply. Neither Pen nor Rectangle calls inpainting.
  let eraseSession = null,
    eraseFrame = null,
    penColor = "#ffffff";
  let coverMode = "auto",
    pickedPaperColor = "#ffffff",
    paperPicking = false;
  const surface = $("document-surface");
  const editorStage = document.querySelector(".processed-stage");
  function eraseCommands() {
    return eraseSession ? eraseSession.history[eraseSession.index] : [];
  }
  function editorActions() {
    if (!eraseSession) return;
    const count = eraseCommands().length;
    $("btn-preview-repair").disabled = !count || !!drawing || busy;
    $("btn-compare-repair").disabled = !eraseSession.previewReady || busy;
    $("btn-clone-source").disabled = busy || !!drawing;
    $("erase-count").value = `${count} edit${count === 1 ? "" : "s"}`;
    $("btn-erase-undo").disabled =
      !!drawing || eraseSession.index === 0 || busy;
    $("btn-erase-redo").disabled =
      !!drawing ||
      eraseSession.index >= eraseSession.history.length - 1 ||
      busy;
    $("btn-clear-mask").disabled = !count || !!drawing || busy;
    $("btn-apply-erase").disabled = !count || !!drawing || busy;
    $("btn-zoom-out").disabled = eraseSession.zoom <= 1 || !!drawing || busy;
    $("btn-zoom-in").disabled = eraseSession.zoom >= 4 || !!drawing || busy;
  }
  function pushEraseState(commands) {
    if (!eraseSession) return;
    eraseSession.history.splice(eraseSession.index + 1);
    eraseSession.history.push(commands);
    if (eraseSession.history.length > 101) eraseSession.history.shift();
    eraseSession.index = eraseSession.history.length - 1;
    editorActions();
    requestEraseRender();
  }
  function drawEraseCommand(ctx, command, repairMask = false) {
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    let fill = command.color;
    if (command.tool === "clone" && !repairMask) {
      fill = ctx.createPattern(finalCanvas, "no-repeat");
      fill.setTransform(
        new DOMMatrix().translate(command.offset.x, command.offset.y),
      );
    }
    if (command.paperMatch && !repairMask) {
      let bounds;
      if (command.tool === "rect")
        bounds = {
          x0: command.start.x,
          y0: command.start.y,
          x1: command.end.x,
          y1: command.end.y,
        };
      else {
        let left = Infinity,
          top = Infinity,
          right = -Infinity,
          bottom = -Infinity;
        for (const point of command.points) {
          left = Math.min(left, point.x);
          top = Math.min(top, point.y);
          right = Math.max(right, point.x);
          bottom = Math.max(bottom, point.y);
        }
        const pad = command.width / 2 + 2;
        bounds = {
          x0: left - pad,
          y0: top - pad,
          x1: right + pad,
          y1: bottom + pad,
        };
      }
      if (command.paperMatch === "flat")
        fill = eraseSession.paper.estimate(bounds);
      else {
        const key = JSON.stringify(bounds);
        if (command.fieldKey !== key) {
          if (command.field)
            command.field.tile.width = command.field.tile.height = 1;
          command.field = eraseSession.paper.field(bounds);
          command.fieldKey = key;
        }
        const field = command.field,
          pattern = ctx.createPattern(field.tile, "no-repeat");
        pattern.setTransform(
          new DOMMatrix()
            .translate(field.x - field.width / 24, field.y - field.height / 24)
            .scale(field.width / 24, field.height / 24),
        );
        fill = pattern;
      }
    }
    ctx.fillStyle = ctx.strokeStyle = repairMask
      ? "#ffffff"
      : command.tool === "repair"
        ? "rgba(34,211,238,.65)"
        : fill;
    if (command.tool === "rect") {
      const x = Math.floor(Math.min(command.start.x, command.end.x));
      const y = Math.floor(Math.min(command.start.y, command.end.y));
      const w = Math.ceil(Math.max(command.start.x, command.end.x)) - x;
      const h = Math.ceil(Math.max(command.start.y, command.end.y)) - y;
      ctx.fillRect(x, y, w, h);
    } else {
      const points = command.points;
      if (points.length) {
        ctx.lineWidth = command.width;
        ctx.lineCap = ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++)
          ctx.lineTo(points[i].x, points[i].y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(points[0].x, points[0].y, command.width / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }
  function renderErase() {
    if (!eraseActive || eraseSession.previewBusy || eraseSession.previewReady)
      return;
    const ctx = maskCanvas.getContext("2d");
    ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    eraseCommands().forEach((command) => drawEraseCommand(ctx, command));
    if (drawing?.command) drawEraseCommand(ctx, drawing.command);
  }
  function requestEraseRender() {
    if (eraseSession?.previewReady) resetRepairPreview();
    if (eraseFrame !== null) return;
    eraseFrame = requestAnimationFrame(() => {
      eraseFrame = null;
      renderErase();
    });
  }
  function updateEditorTransform() {
    if (!eraseSession) return;
    const session = eraseSession;
    if (session.zoom <= 1) {
      session.panX = 0;
      session.panY = 0;
    } else {
      const maxX =
        Math.max(
          0,
          (surface.offsetWidth * session.zoom - editorStage.clientWidth) / 2,
        ) +
        editorStage.clientWidth * 0.2;
      const maxY =
        Math.max(
          0,
          (surface.offsetHeight * session.zoom - editorStage.clientHeight) / 2,
        ) +
        editorStage.clientHeight * 0.2;
      session.panX = Math.max(-maxX, Math.min(maxX, session.panX));
      session.panY = Math.max(-maxY, Math.min(maxY, session.panY));
    }
    surface.style.transform = `translate(${session.panX}px, ${session.panY}px) scale(${session.zoom})`;
    $("erase-zoom").value = `${Math.round(session.zoom * 100)}%`;
    editorActions();
  }
  function positionEraseEditor() {
    if (!eraseActive) return;
    const height = $("erase-panel").getBoundingClientRect().height;
    const top = Math.max(
      70,
      document.querySelector(".navbar").getBoundingClientRect().bottom + 8,
    );
    document.body.style.setProperty("--erase-sheet-height", `${height + 12}px`);
    document.body.style.setProperty("--erase-editor-top", `${top}px`);
    updateEditorTransform();
  }
  if (typeof ResizeObserver !== "undefined")
    new ResizeObserver(positionEraseEditor).observe($("erase-panel"));
  window.addEventListener("resize", positionEraseEditor);
  function showPenSettings(show) {
    $("pen-settings").hidden = !show;
    document
      .querySelector('[data-tool="pen"]')
      .setAttribute("aria-expanded", String(show && eraseTool === "pen"));
    $("brush-mode-note").textContent = ["repair", "clone"].includes(eraseTool)
      ? "Repair/Clone use brush size only; palette colors are ignored. Preview the result before Apply."
      : "Auto follows gentle shading. Picked color applies to both tools; Manual uses the pen swatch or a white rectangle.";
    $("pen-settings").classList.toggle(
      "repair-settings",
      ["repair", "clone"].includes(eraseTool),
    );
    document.querySelectorAll(".color-swatch").forEach((button) => {
      button.disabled = ["repair", "clone"].includes(eraseTool);
    });
    positionEraseEditor();
  }
  function selectEraseTool(tool, openSettings = false) {
    if (busy || drawing) return;
    eraseTool = tool;
    $("erase-panel").classList.toggle(
      "precision-tools",
      ["repair", "clone"].includes(tool),
    );
    if (["repair", "clone"].includes(tool))
      document.querySelector(".local-repair-controls").open = true;
    if (eraseSession)
      eraseSession.clonePicking = tool === "clone" && !eraseSession.cloneSource;
    if (eraseSession?.previewReady) {
      resetRepairPreview();
      requestEraseRender();
    }
    paperPicking = false;
    $("btn-pick-paper").setAttribute("aria-pressed", "false");
    document.querySelectorAll(".erase-tool[data-tool]").forEach((button) => {
      const active = button.dataset.tool === tool;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    editorStage.classList.toggle("pan-mode", tool === "pan");
    $("erase-hint").textContent = {
      pen: "Auto Pen follows estimated gentle shading around each stroke. Use short strokes. Pick paper sets a shared solid color; Manual preserves palette colors.",
      rect: "Auto Rectangle follows estimated paper shading. Picked color uses your sample; Manual fills white. No AI or inpainting. Inspect before Apply.",
      repair:
        "Paint a small cyan selection, then Preview result. Conventional repair may smear nearby writing; it is not AI. Each stroke plus context must fit 1024 px.",
      clone:
        "Choose a clean source with Set clone source, then paint over the unwanted area. Each stroke starts at that source. Source is the page as it looked when this editor opened; no AI.",
      pan: "Drag to move the zoomed document. Use +/− or pinch to zoom; Fit resets the view.",
    }[tool];
    showPenSettings(openSettings && ["pen", "repair", "clone"].includes(tool));
  }
  function endErase() {
    if (eraseSession?.previewBusy && !eraseSession.applying) {
      eraseSession.previewEpoch++;
      FilterProcessor.releaseMemory();
      restorePreviewControls(eraseSession);
      eraseSession.previewBusy = false;
      busy = false;
    }
    if (busy) return;
    maskCanvas.style.opacity = "1";
    $("btn-compare-repair").setAttribute("aria-pressed", "false");
    $("btn-compare-repair").textContent = "Show before";
    $("repair-preview-status").textContent =
      "Draft selections · Preview result shows the flattened repair before Apply.";
    eraseActive = false;
    paperPicking = false;
    $("btn-pick-paper").setAttribute("aria-pressed", "false");
    drawing = null;
    if (eraseFrame !== null) cancelAnimationFrame(eraseFrame);
    eraseFrame = null;
    if (eraseSession) {
      const released = new Set();
      for (const state of eraseSession.history)
        for (const command of state)
          if (command.field && !released.has(command.field.tile)) {
            released.add(command.field.tile);
            command.field.tile.width = command.field.tile.height = 1;
          }
      if (drawing?.command?.field)
        drawing.command.field.tile.width =
          drawing.command.field.tile.height = 1;
      for (const id of eraseSession.pointers.keys())
        if (editorStage.hasPointerCapture(id))
          editorStage.releasePointerCapture(id);
    }
    eraseSession = null;
    document.body.classList.remove("erasing");
    editorStage.classList.remove("pan-mode");
    $("erase-panel").hidden = true;
    $("pen-settings").hidden = true;
    document
      .querySelector('[data-tool="pen"]')
      .setAttribute("aria-expanded", "false");
    surface.style.transform = "";
    maskCanvas.width = maskCanvas.height = 1;
    selection.width = selection.height = 1;
  }
  $("btn-open-erase").addEventListener("click", () => {
    if (busy || saving || filterSession || eraseActive) return;
    maskCanvas.width = finalCanvas.width;
    maskCanvas.height = finalCanvas.height;
    eraseSession = {
      previewReady: false,
      previewBusy: false,
      previewEpoch: 0,
      cloneSource: null,
      clonePicking: false,
      paper: PaperMatch.create(finalCanvas),
      history: [[]],
      index: 0,
      zoom: 1,
      panX: 0,
      panY: 0,
      pointers: new Map(),
      gesture: null,
      panning: null,
    };
    eraseActive = true;
    drawing = null;
    $("erase-panel").hidden = false;
    document.body.classList.add("erasing");
    document.querySelector('[data-tool="repair"]').disabled =
      !VisionEngine.canInpaint();
    $("clone-source-status").textContent = "Clone source not set";
    selectEraseTool("pen", false);
    editorActions();
    positionEraseEditor();
    renderErase();
  });
  $("btn-cancel-erase").addEventListener("click", endErase);
  $("btn-close-pen-settings").addEventListener("click", () =>
    showPenSettings(false),
  );
  document.querySelectorAll(".erase-tool[data-tool]").forEach((button) =>
    button.addEventListener("click", () => {
      const tool = button.dataset.tool;
      selectEraseTool(tool, ["pen", "repair", "clone"].includes(tool));
    }),
  );
  document.querySelectorAll(".color-swatch").forEach((button) =>
    button.addEventListener("click", () => {
      if (busy || drawing || eraseTool !== "pen") return;
      penColor = button.dataset.color;
      coverMode = "manual";
      $("cover-mode").value = "manual";
      $("pen-color-indicator").style.background = penColor;
      document.querySelectorAll(".color-swatch").forEach((item) => {
        const selected = item === button;
        item.classList.toggle("selected", selected);
        item.setAttribute("aria-pressed", String(selected));
      });
    }),
  );
  $("cover-mode").addEventListener("change", () => {
    coverMode = $("cover-mode").value;
    paperPicking = false;
    $("btn-pick-paper").setAttribute("aria-pressed", "false");
  });
  function setPickedColor(color) {
    pickedPaperColor = color;
    $("paper-color").value = color;
    $("paper-color-value").textContent = color;
    coverMode = "picked";
    $("cover-mode").value = "picked";
    paperPicking = false;
    $("btn-pick-paper").setAttribute("aria-pressed", "false");
  }
  $("paper-color").addEventListener("input", () => {
    if (!busy && !drawing) setPickedColor($("paper-color").value);
  });
  $("btn-pick-paper").addEventListener("click", () => {
    if (busy || drawing || !eraseSession) return;
    if (eraseSession) eraseSession.clonePicking = false;
    paperPicking = !paperPicking;
    $("btn-pick-paper").setAttribute("aria-pressed", String(paperPicking));
    $("erase-hint").textContent = paperPicking
      ? "Tap a clean paper area in the document to sample its color. Tap Pick paper again to cancel."
      : "Color picking cancelled. Choose a tool to continue.";
    showPenSettings(false);
  });
  $("brush-size").addEventListener("input", () => {
    $("brush-value").value = $("brush-size").value;
  });
  $("btn-erase-undo").addEventListener("click", () => {
    if (!eraseSession || busy || drawing || !eraseSession.index) return;
    eraseSession.index--;
    editorActions();
    requestEraseRender();
  });
  $("btn-erase-redo").addEventListener("click", () => {
    if (
      !eraseSession ||
      busy ||
      drawing ||
      eraseSession.index >= eraseSession.history.length - 1
    )
      return;
    eraseSession.index++;
    editorActions();
    requestEraseRender();
  });
  $("btn-clear-mask").addEventListener("click", () => {
    if (eraseSession && !busy && !drawing && eraseCommands().length)
      pushEraseState([]);
  });
  function zoomEditor(value) {
    if (!eraseSession || busy || drawing) return;
    eraseSession.zoom = Math.max(1, Math.min(4, value));
    updateEditorTransform();
  }
  $("btn-zoom-in").addEventListener("click", () =>
    zoomEditor((eraseSession?.zoom || 1) + 0.25),
  );
  $("btn-zoom-out").addEventListener("click", () =>
    zoomEditor((eraseSession?.zoom || 1) - 0.25),
  );
  $("btn-zoom-fit").addEventListener("click", () => {
    if (!eraseSession || busy || drawing) return;
    eraseSession.panX = eraseSession.panY = 0;
    zoomEditor(1);
  });
  editorStage.addEventListener(
    "wheel",
    (event) => {
      if (!eraseActive || !event.ctrlKey) return;
      event.preventDefault();
      zoomEditor(eraseSession.zoom + (event.deltaY < 0 ? 0.15 : -0.15));
    },
    { passive: false },
  );
  function maskPoint(event) {
    const rect = maskCanvas.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(
          maskCanvas.width,
          ((event.clientX - rect.left) * maskCanvas.width) / rect.width,
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          maskCanvas.height,
          ((event.clientY - rect.top) * maskCanvas.height) / rect.height,
        ),
      ),
    };
  }
  function pinchMetrics() {
    const [a, b] = [...eraseSession.pointers.values()];
    return {
      distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
    };
  }
  editorStage.addEventListener("pointerdown", (event) => {
    if (!eraseActive || busy || event.button !== 0) return;
    event.preventDefault();
    const session = eraseSession;
    if (session.previewReady) {
      resetRepairPreview();
      renderErase();
    }
    if (eraseTool === "clone" && !session.cloneSource && !paperPicking)
      session.clonePicking = true;
    if (session.clonePicking && event.target === maskCanvas) {
      session.cloneSource = maskPoint(event);
      session.clonePicking = false;
      $("clone-source-status").textContent =
        `Source: ${Math.round(session.cloneSource.x)}, ${Math.round(session.cloneSource.y)}`;
      $("erase-hint").textContent =
        "Clone source selected. Paint the destination; each new stroke starts at this source. No edit was added by picking.";
      return;
    }
    if (paperPicking && event.target === maskCanvas) {
      setPickedColor(session.paper.pick(maskPoint(event)));
      $("erase-hint").textContent =
        "Paper color sampled. Both Pen and Rectangle now use this solid color.";
      return;
    }
    session.pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    editorStage.setPointerCapture(event.pointerId);
    if (session.pointers.size >= 2) {
      // Cancel the provisional first-finger stroke: a pinch must not leave ink.
      drawing = null;
      session.panning = null;
      if (!session.gesture)
        session.gesture = {
          ...pinchMetrics(),
          zoom: session.zoom,
          panX: session.panX,
          panY: session.panY,
        };
      editorActions();
      requestEraseRender();
      return;
    }
    if (session.gesture) return;
    if (eraseTool === "pan" || event.target !== maskCanvas) {
      session.panning = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        panX: session.panX,
        panY: session.panY,
      };
      return;
    }
    if (eraseCommands().length >= 300) {
      notice(
        "Apply the current edits before adding more (300 edits per session).",
        true,
      );
      return;
    }
    const point = maskPoint(event),
      rect = maskCanvas.getBoundingClientRect();
    drawing = {
      pointerId: event.pointerId,
      command:
        eraseTool === "rect"
          ? {
              tool: "rect",
              start: point,
              end: point,
              color: coverMode === "picked" ? pickedPaperColor : "#ffffff",
              paperMatch:
                coverMode === "auto"
                  ? "shade"
                  : coverMode === "flat"
                    ? "flat"
                    : false,
            }
          : {
              tool: eraseTool,
              color: coverMode === "picked" ? pickedPaperColor : penColor,
              paperMatch:
                eraseTool === "pen" &&
                (coverMode === "auto"
                  ? "shade"
                  : coverMode === "flat"
                    ? "flat"
                    : false),
              width:
                (Number($("brush-size").value) * maskCanvas.width) / rect.width,
              points: [point],
              ...(eraseTool === "clone"
                ? {
                    offset: {
                      x: point.x - session.cloneSource.x,
                      y: point.y - session.cloneSource.y,
                    },
                  }
                : {}),
            },
    };
    editorActions();
    requestEraseRender();
  });
  function moveErasePointer(event) {
    if (!eraseActive || busy || !eraseSession.pointers.has(event.pointerId))
      return;
    const session = eraseSession;
    session.pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    if (session.gesture) {
      if (session.pointers.size < 2) return;
      const metric = pinchMetrics(),
        origin = session.gesture;
      session.zoom = Math.max(
        1,
        Math.min(4, (origin.zoom * metric.distance) / origin.distance),
      );
      session.panX = origin.panX + metric.x - origin.x;
      session.panY = origin.panY + metric.y - origin.y;
      updateEditorTransform();
      return;
    }
    if (session.panning?.pointerId === event.pointerId) {
      session.panX = session.panning.panX + event.clientX - session.panning.x;
      session.panY = session.panning.panY + event.clientY - session.panning.y;
      updateEditorTransform();
      return;
    }
    if (!drawing || drawing.pointerId !== event.pointerId) return;
    if (drawing.command.tool === "rect") drawing.command.end = maskPoint(event);
    else {
      const samples =
        typeof event.getCoalescedEvents === "function"
          ? event.getCoalescedEvents()
          : [];
      for (const sample of samples.length ? samples : [event]) {
        const point = maskPoint(sample),
          points = drawing.command.points,
          previous = points[points.length - 1];
        if (
          points.length < 10000 &&
          Math.hypot(point.x - previous.x, point.y - previous.y) >= 0.25
        )
          points.push(point);
      }
    }
    requestEraseRender();
  }
  editorStage.addEventListener("pointermove", moveErasePointer);
  function endErasePointer(event) {
    if (!eraseActive || !eraseSession?.pointers.has(event.pointerId)) return;
    if (drawing?.pointerId === event.pointerId) {
      if (event.type === "pointerup" && !eraseSession.gesture) {
        moveErasePointer(event);
        const command = drawing.command;
        if (
          command.tool !== "rect" ||
          (Math.abs(command.start.x - command.end.x) >= 1 &&
            Math.abs(command.start.y - command.end.y) >= 1)
        )
          pushEraseState([...eraseCommands(), command]);
      }
      drawing = null;
    }
    eraseSession.pointers.delete(event.pointerId);
    if (eraseSession.panning?.pointerId === event.pointerId)
      eraseSession.panning = null;
    if (!eraseSession.pointers.size) eraseSession.gesture = null;
    if (editorStage.hasPointerCapture(event.pointerId))
      editorStage.releasePointerCapture(event.pointerId);
    editorActions();
    requestEraseRender();
  }
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((type) =>
    editorStage.addEventListener(type, endErasePointer),
  );
  window.addEventListener("keydown", (event) => {
    if (
      eraseActive &&
      eraseSession?.previewBusy &&
      !eraseSession.applying &&
      event.key === "Escape"
    ) {
      event.preventDefault();
      endErase();
      return;
    }
    if (!eraseActive || busy) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (!$("pen-settings").hidden) showPenSettings(false);
      else endErase();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      $(event.shiftKey ? "btn-erase-redo" : "btn-erase-undo").click();
    }
  });

  function resetRepairPreview() {
    if (!eraseSession) return;
    eraseSession.previewReady = false;
    maskCanvas.style.opacity = "1";
    $("btn-compare-repair").textContent = "Show before";
    $("btn-compare-repair").setAttribute("aria-pressed", "false");
    $("repair-preview-status").textContent =
      "Draft selections · Preview result shows the flattened repair before Apply.";
    editorActions();
  }
  function restorePreviewControls(session) {
    if (!session.previewControls) return;
    for (const [element, disabled] of session.previewControls)
      element.disabled = disabled;
    session.previewControls = null;
  }
  $("btn-clone-source").addEventListener("click", () => {
    if (!eraseSession || busy || drawing) return;
    selectEraseTool("clone", false);
    eraseSession.clonePicking = true;
    paperPicking = false;
    $("erase-hint").textContent =
      "Tap a clean source area in the document. This sets the clone source without painting.";
  });
  $("btn-compare-repair").addEventListener("click", () => {
    if (!eraseSession?.previewReady || busy) return;
    const before = maskCanvas.style.opacity !== "0";
    maskCanvas.style.opacity = before ? "0" : "1";
    $("btn-compare-repair").textContent = before
      ? "Show result"
      : "Show before";
    $("btn-compare-repair").setAttribute("aria-pressed", String(before));
  });
  function commandBounds(command) {
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity;
    for (const point of command.points) {
      left = Math.min(left, point.x);
      top = Math.min(top, point.y);
      right = Math.max(right, point.x);
      bottom = Math.max(bottom, point.y);
    }
    const pad = command.width / 2 + 32;
    const x = Math.max(0, Math.floor(left - pad)),
      y = Math.max(0, Math.floor(top - pad));
    return {
      x,
      y,
      w: Math.min(finalCanvas.width, Math.ceil(right + pad)) - x,
      h: Math.min(finalCanvas.height, Math.ceil(bottom + pad)) - y,
    };
  }
  async function composeRepairPreview(session, commands, epoch) {
    // Preflight every crop before altering the draft overlay. Never resize the saved page.
    let maskBudget = 0;
    for (const command of commands)
      if (command.tool === "repair") {
        const b = commandBounds(command);
        maskBudget += b.w * b.h;
        if (maskBudget > 4 * 1024 * 1024)
          throw Error(
            "This repair batch needs too much mask memory. Apply fewer repair strokes at a time.",
          );
        if (b.w > 1024 || b.h > 1024)
          throw Error(
            "That repair stroke is too large. Undo it and use shorter strokes (1024 px maximum including context).",
          );
      }
    if (eraseFrame !== null) {
      cancelAnimationFrame(eraseFrame);
      eraseFrame = null;
    }
    // Capture the exact full-canvas draft footprint before the result reuses its canvas.
    // WebKit can rasterize translated small canvases a few edge pixels differently.
    const draft = maskCanvas.getContext("2d", { willReadFrequently: true });
    draft.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    for (const command of commands) drawEraseCommand(draft, command);
    const footprints = new Map();
    for (const command of commands)
      if (command.tool === "repair") {
        const b = commandBounds(command),
          rgba = draft.getImageData(b.x, b.y, b.w, b.h),
          alpha = new Uint8Array(b.w * b.h);
        for (let i = 0; i < alpha.length; i++) alpha[i] = rgba.data[i * 4 + 3];
        footprints.set(command, alpha);
      }
    copy(finalCanvas, maskCanvas);
    maskCanvas.style.opacity = "1";
    const target = maskCanvas.getContext("2d", { willReadFrequently: true });
    for (let index = 0; index < commands.length; index++) {
      if (eraseSession !== session || session.previewEpoch !== epoch)
        throw new DOMException("Preview cancelled", "AbortError");
      const command = commands[index];
      if (command.tool !== "repair") {
        drawEraseCommand(target, command);
        continue;
      }
      const b = commandBounds(command),
        local = document.createElement("canvas");
      local.width = b.w;
      local.height = b.h;
      try {
        const ctx = local.getContext("2d", { willReadFrequently: true });
        ctx.translate(-b.x, -b.y);
        drawEraseCommand(ctx, command, true);
        const rgba = ctx.getImageData(0, 0, b.w, b.h),
          mask = new Uint8Array(b.w * b.h);
        for (let i = 0; i < mask.length; i++)
          mask[i] =
            rgba.data[i * 4 + 3] > 0 && footprints.get(command)[i] > 0
              ? 255
              : 0;
        $("repair-preview-status").textContent =
          `Repairing selected crop ${index + 1}/${commands.length} · ${b.w} × ${b.h} px…`;
        const crop = target.getImageData(b.x, b.y, b.w, b.h);
        let repaired;
        try {
          repaired = await FilterProcessor.repairImage(crop, mask, {
            group: "local-repair",
            priority: 4,
          });
        } catch (error) {
          if (
            error.name === "AbortError" ||
            eraseSession !== session ||
            session.previewEpoch !== epoch
          )
            throw error;
          const loadingFailure =
            /load|startup|unavailable|could not|timed out/i.test(
              error.message || "",
            );
          if (!loadingFailure) throw error;
          if (b.w > 512 || b.h > 512)
            throw Error(
              "Repair worker could not load. Retry online or use smaller strokes (512 px including context for fallback).",
            );
          $("repair-preview-status").textContent =
            "Worker unavailable · processing a small local crop with the existing engine…";
          await new Promise((resolve) =>
            requestAnimationFrame(() => setTimeout(resolve, 0)),
          );
          if (eraseSession !== session || session.previewEpoch !== epoch)
            throw new DOMException("Preview cancelled", "AbortError");
          repaired = LocalRepairCore.apply(crop, { mask });
          session.usedRepairFallback = true;
        }
        if (eraseSession !== session || session.previewEpoch !== epoch)
          throw new DOMException("Preview cancelled", "AbortError");
        target.putImageData(repaired, b.x, b.y);
      } finally {
        local.width = local.height = 1;
      }
    }
    if (eraseSession !== session || session.previewEpoch !== epoch)
      throw new DOMException("Preview cancelled", "AbortError");
  }
  $("btn-preview-repair").addEventListener("click", async () => {
    const session = eraseSession;
    if (!session || busy || drawing || !eraseCommands().length) return;
    busy = true;
    session.previewBusy = true;
    session.previewReady = false;
    session.usedRepairFallback = false;
    const epoch = ++session.previewEpoch;
    session.previewControls = [
      ...$("erase-panel").querySelectorAll("button,input,select"),
    ]
      .filter((e) => e.id !== "btn-cancel-erase")
      .map((e) => [e, e.disabled]);
    for (const [element] of session.previewControls) element.disabled = true;
    try {
      await composeRepairPreview(session, [...eraseCommands()], epoch);
      session.previewReady = true;
      $("repair-preview-status").textContent =
        "Result preview ready. Compare before/result, Apply to commit, or Cancel to discard." +
        (session.usedRepairFallback
          ? " Small-crop fallback used because the worker was unavailable."
          : "");
    } catch (error) {
      if (eraseSession === session && session.previewEpoch === epoch) {
        session.previewReady = false;
        $("repair-preview-status").textContent =
          `Preview failed: ${error.message}. Draft selections kept; Undo or Cancel.`;
      }
    } finally {
      if (eraseSession === session && session.previewEpoch === epoch) {
        session.previewBusy = false;
        busy = false;
        restorePreviewControls(session);
        editorActions();
        if (!session.previewReady) renderErase();
      }
    }
  });
  $("btn-apply-erase").addEventListener("click", async () => {
    const session = eraseSession;
    if (!session || busy || drawing || !eraseCommands().length) return;
    const commands = [...eraseCommands()];
    session.applying = true;
    const ok = await runTask("Applying local edits…", async () => {
      if (!session.previewReady) {
        session.previewBusy = true;
        try {
          await composeRepairPreview(session, commands, ++session.previewEpoch);
        } finally {
          session.previewBusy = false;
        }
      }
      rememberEdit();
      copy(maskCanvas, finalCanvas);
      copy(maskCanvas, bufferCanvas);
      currentFilter = "original";
      currentFilterSettings = FilterProcessor.defaults("original");
      syncFilters(currentFilter);
      markDirty();
    });
    session.applying = false;
    if (ok) endErase();
    else {
      session.previewReady = false;
      maskCanvas.style.opacity = "1";
      renderErase();
      editorActions();
    }
  });

  // IndexedDB writes are only considered saved when the transaction completes.
  const DB_NAME = "ProScanDB",
    STORE_NAME = "pages";
  function openDB() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("IndexedDB is unavailable."));
        return;
      }
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        reject(
          new Error(
            "Device storage did not open. Close other ProScan tabs and reload.",
          ),
        );
      }, 12000);
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME))
          request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      };
      request.onerror = () => {
        clearTimeout(timer);
        reject(request.error);
      };
      request.onblocked = () =>
        notice(
          "Storage is blocked by another open tab. Close other ProScan tabs.",
          true,
        );
      request.onsuccess = () => {
        clearTimeout(timer);
        if (expired) {
          request.result.close();
          return;
        }
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
    });
  }
  async function saveToDB() {
    if (!storageReadable)
      throw new Error(
        "Previously saved pages could not be read. Reload to retry before saving over them.",
      );
    const db = await openDB();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () =>
          reject(tx.error || new Error("Storage transaction failed."));
        try {
          const store = tx.objectStore(STORE_NAME);
          store.clear();
          documentPages.forEach((page, order) => store.put({ ...page, order }));
        } catch (error) {
          tx.abort();
          reject(error);
        }
      });
    } finally {
      db.close();
    }
  }
  async function persist() {
    if (shareSession) closeShareDialog();
    saving = true;
    $("save-status").textContent = "Saving…";
    try {
      await saveToDB();
      storageAvailable = true;
      $("save-status").textContent = "Saved on this device";
      return true;
    } catch (error) {
      storageAvailable = false;
      $("save-status").textContent = "Memory only · export a backup";
      fail(
        "Device storage failed. Pages remain in memory: export before reloading.",
        error,
      );
      return false;
    } finally {
      saving = false;
    }
  }
  async function loadSavedDocuments() {
    const db = await openDB();
    try {
      const pages = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        let result;
        const request = tx.objectStore(STORE_NAME).getAll();
        request.onsuccess = () => {
          result = request.result;
        };
        tx.oncomplete = () => resolve(result || []);
        tx.onerror = tx.onabort = () =>
          reject(tx.error || new Error("Could not read saved pages."));
      });
      documentPages = pages.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      if (documentPages.length) {
        renderGallery();
        showView("gallery-view");
        $("save-status").textContent = "Restored from this device";
      }
    } finally {
      db.close();
    }
  }
  $("btn-save-page").addEventListener("click", async () => {
    if (busy || saving || eraseActive) return;
    try {
      const existing = documentPages.find((page) => page.id === activePageId);
      const page = {
        stage1Version: 1,
        stage2Version: 1,
        stage3Version: 1,
        stage32Version: 1,
        filterSettings: { ...currentFilterSettings },
        id:
          existing?.id ??
          (crypto.randomUUID
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random()}`),
        original:
          existing?.original || currentImage.toDataURL("image/jpeg", 0.95),
        cropped: bufferCanvas.toDataURL("image/png"),
        filter: currentFilter,
        final: finalCanvas.toDataURL("image/png"),
      };
      if (existing) documentPages[documentPages.indexOf(existing)] = page;
      else documentPages.push(page);
      const saved = await persist();
      dirty = !saved;
      renderGallery();
      showView("gallery-view");
    } catch (error) {
      fail("Could not add this page.", error);
    }
  });
  function renderGallery() {
    const gallery = $("page-gallery");
    gallery.replaceChildren();
    if (!documentPages.length) {
      const p = document.createElement("p");
      p.textContent = "No pages yet. Add a page to get started.";
      gallery.append(p);
    }
    documentPages.forEach((page, index) => {
      const card = document.createElement("article");
      card.className = "page-card";
      const open = document.createElement("button");
      open.className = "page-open";
      const image = document.createElement("img");
      image.src = page.final;
      image.alt = `Page ${index + 1}`;
      image.loading = "lazy";
      const number = document.createElement("span");
      number.className = "page-num";
      number.textContent = `Page ${index + 1} · Edit`;
      open.append(image, number);
      open.onclick = () => editPage(page.id);
      const actions = document.createElement("div");
      actions.className = "card-actions";
      function action(text, label, callback, disabled = false) {
        const button = document.createElement("button");
        button.textContent = text;
        button.setAttribute("aria-label", label);
        button.disabled = disabled;
        button.onclick = callback;
        actions.append(button);
        return button;
      }
      action(
        "←",
        `Move page ${index + 1} earlier`,
        () => movePage(page.id, -1),
        index === 0,
      );
      action(
        "→",
        `Move page ${index + 1} later`,
        () => movePage(page.id, 1),
        index === documentPages.length - 1,
      );
      action("Delete", `Delete page ${index + 1}`, () =>
        deletePage(page.id),
      ).className = "btn-del";
      card.append(open, actions);
      gallery.append(card);
    });
    $("btn-export-trigger").disabled = $("btn-share").disabled =
      !documentPages.length;
  }
  async function editPage(id) {
    const page = documentPages.find((item) => item.id === id);
    if (!page || saving || busy) return;
    const ok = await runTask("Opening saved page…", async () => {
      const [original, base, result] = await Promise.all([
        loadImage(page.original),
        loadImage(page.cropped),
        loadImage(page.final),
      ]);
      currentImage = clone(original);
      initProxy();
      copy(base, bufferCanvas);
      copy(result, finalCanvas);
      activePageId = page.id;
      currentFilter = FilterProcessor.supportsFilter(page.filter)
        ? FilterProcessor.canonical(page.filter)
        : "original";
      currentFilterSettings = FilterProcessor.normalizeSettings(
        page.filterSettings || { strength: 70, version: 1 },
        currentFilter,
      );
      // Old app versions could save erased pixels only in `final`.
      // Flatten legacy pages so choosing a filter cannot silently resurrect them.
      if (!page.stage1Version || !FilterProcessor.supportsFilter(page.filter)) {
        copy(result, bufferCanvas);
        currentFilter = "original";
        currentFilterSettings = FilterProcessor.defaults("original");
      }
      syncFilters(currentFilter);
      clearEditUndo();
      dirty = false;
      $("btn-save-page").textContent = "Update Page";
    });
    if (ok) showView("process-view");
  }
  async function deletePage(id) {
    if (busy || saving || !confirm("Delete this page?")) return;
    documentPages = documentPages.filter((page) => page.id !== id);
    const saved = await persist();
    dirty = !saved;
    renderGallery();
  }
  async function movePage(id, offset) {
    if (busy || saving) return;
    const index = documentPages.findIndex((page) => page.id === id),
      next = index + offset;
    if (index < 0 || next < 0 || next >= documentPages.length) return;
    [documentPages[index], documentPages[next]] = [
      documentPages[next],
      documentPages[index],
    ];
    const saved = await persist();
    dirty = !saved;
    renderGallery();
  }
  $("btn-add-more").addEventListener("click", () => {
    if (!saving) showView("upload-area");
  });
  $("btn-return-gallery").addEventListener("click", () =>
    showView("gallery-view"),
  );
  $("btn-back").addEventListener("click", () => {
    if (busy || saving) return;
    if (activePageId !== null) {
      if (dirty && !confirm("Discard unsaved page edits?")) return;
      dirty = false;
      showView("gallery-view");
    } else {
      if (
        dirty &&
        !confirm(
          "Return to crop? Reprocessing will replace this unsaved result.",
        )
      )
        return;
      showView("crop-view");
    }
  });

  // Export quality is applied by re-encoding pixels, not misused as a jsPDF option.
  function exportName(value = $("filename-input").value) {
    return (
      (value.trim() || "ProScan_Document")
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
        .replace(/[. ]+$/g, "")
        .slice(0, 100) || "ProScan_Document"
    );
  }
  function canvasBlob(source, type, quality) {
    return new Promise((resolve, reject) =>
      source.toBlob(
        (blob) =>
          blob ? resolve(blob) : reject(new Error("Image encoding failed.")),
        type,
        quality,
      ),
    );
  }
  async function makePDF(quality, options = {}) {
    if (!window.jspdf?.jsPDF)
      throw new Error(
        "The local PDF library could not be loaded. Reload the app.",
      );
    const pages = options.pages || documentPages;
    if (!pages.length) throw new Error("Add at least one page first.");
    const layout = options.layout === "a4" ? "a4" : "document";
    function checkCancelled() {
      if (options.cancelled?.())
        throw new DOMException("PDF preparation cancelled", "AbortError");
    }
    let pdf = null;
    for (let i = 0; i < pages.length; i++) {
      checkCancelled();
      const image = await loadImage(pages[i].final);
      checkCancelled();
      const source = clone(image);
      const encoded = await FilterProcessor.preparePdfImage(
        canvasData(source),
        { quality, maxEdge: options.maxEdge || 0 },
        { group: options.group || "export-pdf", priority: 3 },
      );
      source.width = source.height = 1;
      checkCancelled();
      const iw = image.naturalWidth,
        ih = image.naturalHeight,
        orientation = iw > ih ? "landscape" : "portrait";
      // Layout uses full working dimensions, not compressed pixel dimensions.
      const scale = 297 / Math.max(iw, ih);
      const format = layout === "a4" ? "a4" : [iw * scale, ih * scale];
      if (!pdf)
        pdf = new window.jspdf.jsPDF({
          orientation,
          unit: "mm",
          format,
          compress: true,
          precision: 10,
        });
      else pdf.addPage(format, orientation);
      const pw = pdf.internal.pageSize.getWidth(),
        ph = pdf.internal.pageSize.getHeight();
      let x = 0,
        y = 0,
        w = pw,
        h = ph;
      if (layout === "a4") {
        const factor = Math.min((pw - 10) / iw, (ph - 10) / ih);
        w = iw * factor;
        h = ih * factor;
        x = (pw - w) / 2;
        y = (ph - h) / 2;
      }
      pdf.addImage(
        encoded.bytes,
        encoded.format,
        x,
        y,
        w,
        h,
        undefined,
        "FAST",
      );
      options.onProgress?.(i + 1, pages.length);
      if (options.cancelled || options.onProgress)
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    checkCancelled();
    return pdf.output("blob");
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  $("btn-export-trigger").addEventListener("click", () => {
    if (busy || saving || !documentPages.length) return;
    $("name-modal").showModal();
  });
  $("modal-cancel").addEventListener("click", () => $("name-modal").close());
  $("export-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("name-modal").close();
    const name = exportName(),
      format = $("export-format").value;
    const quality = Number($("compression-select").value);
    await runTask("Preparing export…", async () => {
      if (!documentPages.length) throw new Error("Add a page first.");
      let blob;
      if (format === "pdf")
        blob = await makePDF(quality, { layout: $("export-layout").value });
      else {
        const image = await loadImage(documentPages[0].final);
        blob = await canvasBlob(
          clone(image),
          format === "png" ? "image/png" : "image/jpeg",
          quality,
        );
      }
      download(blob, `${name}.${format}`);
      notice(
        format === "pdf"
          ? "PDF download requested. Confirm that the file saved successfully."
          : "First-page image download requested. Use PDF to export every page.",
      );
    });
  });
  // Prepare a disposable copy before the final native-share user gesture.
  const SHARE_PRESETS = {
    best: { quality: 95, edge: 0 },
    light: { quality: 85, edge: 2400 },
    balanced: { quality: 65, edge: 1800 },
    strong: { quality: 45, edge: 1200 },
  };
  let shareSession = null,
    shareTimer = null,
    shareBuildRunning = false;
  function shareFilename() {
    return `${exportName(
      $("share-filename")
        .value.trim()
        .replace(/\.pdf$/i, ""),
    )}.pdf`;
  }
  function shareFile() {
    return new File([shareSession.blob], shareFilename(), {
      type: "application/pdf",
    });
  }
  function canShareFile(file) {
    try {
      return (
        typeof navigator.share === "function" &&
        typeof navigator.canShare === "function" &&
        navigator.canShare({ files: [file] })
      );
    } catch (_) {
      return false;
    }
  }
  function formatBytes(bytes) {
    return bytes < 1024
      ? `${bytes} B`
      : bytes < 1024 * 1024
        ? `${(bytes / 1024).toFixed(1)} KB`
        : `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  function setShareControls() {
    const session = shareSession;
    if (!session) return;
    const sending = !!session.sending,
      ready = !!session.blob && !session.queued;
    [
      "share-preset",
      "share-quality",
      "share-resolution",
      "share-layout",
      "share-filename",
      "share-cancel",
      "share-retry",
    ].forEach((id) => {
      $(id).disabled = sending;
    });
    $("share-send").disabled = sending || !ready;
    $("share-download").disabled = sending || !ready;
    if (ready) {
      const native = canShareFile(shareFile());
      $("share-send").textContent = sending
        ? "Sharing…"
        : native
          ? "Share PDF"
          : "Download PDF";
      $("share-support").textContent = native
        ? "Ready. Tap Share PDF to send this exact compressed copy through your device's share sheet."
        : "This browser cannot share PDF files here. Download the same compressed copy, then send it from your device.";
    } else {
      $("share-send").textContent = "Preparing…";
      $("share-support").textContent =
        "Compression is local. A final tap will share or download the prepared PDF; no separate export is needed.";
    }
  }
  function closeShareDialog(force = false) {
    if (shareSession?.sending && !force) return;
    FilterProcessor.cancel("share-pdf");
    clearTimeout(shareTimer);
    shareTimer = null;
    shareSession = null;
    if ($("share-modal").open) $("share-modal").close();
  }
  function requestShareBuild(delay = 150) {
    const session = shareSession;
    if (!session || session.sending) return;
    session.revision++;
    FilterProcessor.cancel("share-pdf");
    session.queued = true;
    session.blob = null;
    $("share-size").textContent = "Calculating…";
    $("share-progress").hidden = false;
    $("share-progress").value = 0;
    $("share-status").textContent = "Preparing your compressed PDF…";
    $("share-retry").hidden = true;
    $("share-quality-value").value = `${$("share-quality").value}%`;
    setShareControls();
    clearTimeout(shareTimer);
    shareTimer = setTimeout(() => {
      shareTimer = null;
      drainShareBuilds();
    }, delay);
  }
  async function drainShareBuilds() {
    if (shareBuildRunning || !shareSession?.queued) return;
    const session = shareSession,
      revision = session.revision;
    const quality = Number($("share-quality").value) / 100;
    const maxEdge = Number($("share-resolution").value);
    session.queued = false;
    // The read-only job has its own lock; cancelling must not leave the editor
    // blocked or overwrite another operation's busy flag.
    shareBuildRunning = true;
    const cancelled = () =>
      shareSession !== session || session.revision !== revision;
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const blob = await makePDF(quality, {
        pages: session.pages,
        maxEdge,
        layout: $("share-layout").value,
        group: "share-pdf",
        cancelled,
        onProgress(done, total) {
          if (cancelled()) return;
          $("share-progress").value = done / total;
          $("share-status").textContent =
            `Compressing page ${done} of ${total}…`;
        },
      });
      if (cancelled()) return;
      session.blob = blob;
      $("share-size").textContent = formatBytes(blob.size);
      $("share-details").textContent =
        `${session.pages.length} page${session.pages.length === 1 ? "" : "s"} · color JPEG quality ${Math.round(quality * 100)}% · ${maxEdge ? `longest edge up to ${maxEdge} px per page` : "working resolution retained"}`;
      $("share-status").textContent =
        "Ready — this is the actual generated PDF size, not an estimate.";
      $("share-progress").hidden = true;
      setShareControls();
    } catch (error) {
      if (cancelled() || error.name === "AbortError") return;
      session.blob = null;
      $("share-size").textContent = "Not ready";
      $("share-status").textContent =
        `Could not prepare PDF: ${error.message || String(error)}. Retry or choose another setting.`;
      $("share-progress").hidden = true;
      $("share-retry").hidden = false;
      setShareControls();
      $("share-send").textContent = "Share PDF";
      console.error("Share preparation failed:", error);
    } finally {
      shareBuildRunning = false;
      if (shareSession?.queued) {
        clearTimeout(shareTimer);
        shareTimer = null;
        queueMicrotask(drainShareBuilds);
      }
    }
  }
  $("btn-share").addEventListener("click", () => {
    if (busy || saving || !documentPages.length || shareSession) return;
    shareSession = {
      pages: documentPages.map((page) => ({ final: page.final })),
      revision: 0,
      queued: false,
      sending: false,
      blob: null,
    };
    $("share-filename").value = exportName();
    $("share-preset").value = "balanced";
    $("share-layout").value = "document";
    $("share-quality").value = "65";
    $("share-resolution").value = "1800";
    $("share-details").textContent =
      `${documentPages.length} saved page${documentPages.length === 1 ? "" : "s"} · originals stay unchanged`;
    $("share-modal").showModal();
    requestShareBuild(0);
  });
  $("share-preset").addEventListener("change", () => {
    const preset = SHARE_PRESETS[$("share-preset").value];
    if (preset) {
      $("share-quality").value = preset.quality;
      $("share-resolution").value = preset.edge;
    }
    requestShareBuild();
  });
  ["share-quality", "share-resolution"].forEach((id) =>
    $(id).addEventListener(id === "share-quality" ? "input" : "change", () => {
      $("share-preset").value = "custom";
      requestShareBuild();
    }),
  );
  $("share-layout").addEventListener("change", () => requestShareBuild());
  $("share-filename").addEventListener("input", setShareControls);
  $("share-retry").addEventListener("click", () => requestShareBuild(0));
  $("share-cancel").addEventListener("click", () => closeShareDialog());
  $("share-modal").addEventListener("cancel", (event) => {
    event.preventDefault();
    closeShareDialog();
  });
  $("share-modal").addEventListener("close", () => {
    if (!$("share-modal").open && shareSession && !shareSession.sending)
      closeShareDialog();
  });
  $("share-download").addEventListener("click", () => {
    if (!shareSession?.blob || shareSession.queued || shareSession.sending)
      return;
    const file = shareFile();
    download(file, file.name);
    closeShareDialog();
    notice("Compressed PDF download requested. Saved pages were not changed.");
  });
  $("share-send").addEventListener("click", async () => {
    const session = shareSession;
    if (!session?.blob || session.queued || session.sending) return;
    const file = shareFile();
    if (!canShareFile(file)) {
      download(file, file.name);
      closeShareDialog();
      notice(
        "File sharing is unavailable here. Download of the same compressed PDF was requested instead.",
      );
      return;
    }
    session.sending = true;
    busy = true;
    setShareControls();
    try {
      // No asynchronous PDF work before this call: keep the user's gesture.
      await navigator.share({
        files: [file],
        title: file.name.replace(/\.pdf$/i, ""),
      });
      closeShareDialog(true);
      notice(
        "The device share action finished. Confirm delivery in the selected app; saved pages were not changed.",
      );
    } catch (error) {
      if (error.name === "AbortError") {
        session.sending = false;
        if (shareSession === session)
          $("share-status").textContent =
            "Sharing was cancelled. Your compressed PDF is ready to retry or download.";
      } else {
        session.sending = false;
        if (shareSession === session)
          $("share-status").textContent =
            `Sharing failed: ${error.message || String(error)}. Tap Download copy to save this same compressed PDF, or retry Share.`;
        console.warn("Native sharing failed; prepared PDF retained:", error);
      }
    } finally {
      busy = false;
      session.sending = false;
      if (shareSession === session) setShareControls();
    }
  });

  function updateOnlineStatus() {
    const online = navigator.onLine;
    $("offline-badge").textContent = online ? "Online" : "Offline";
    $("offline-badge").classList.toggle("offline", !online);
  }
  ["online", "offline"].forEach((type) =>
    window.addEventListener(type, updateOnlineStatus),
  );
  updateOnlineStatus();
  try {
    document.body.classList.toggle(
      "light-theme",
      localStorage.getItem("proscan-theme") === "light",
    );
  } catch (_) {}
  function syncThemeButton() {
    const target = document.body.classList.contains("light-theme")
      ? "dark"
      : "light";
    $("theme-toggle").setAttribute("aria-label", `Switch to ${target} theme`);
    $("theme-toggle").title = `Switch to ${target} theme`;
  }
  syncThemeButton();
  $("theme-toggle").addEventListener("click", () => {
    const light = document.body.classList.toggle("light-theme");
    syncThemeButton();
    try {
      localStorage.setItem("proscan-theme", light ? "light" : "dark");
    } catch (_) {}
  });
  function safeToReload() {
    if (busy || saving) {
      notice("Wait for the current operation to finish.", true);
      return false;
    }
    if (
      (dirty || !storageAvailable || (eraseActive && eraseCommands().length)) &&
      !confirm(
        "Unsaved edits or memory-only pages may be lost. Export or save them first. Reload anyway?",
      )
    )
      return false;
    return true;
  }
  $("btn-retry").addEventListener("click", () => location.reload());
  $("btn-hard-refresh").addEventListener("click", async () => {
    if (!navigator.onLine) {
      notice(
        "Connect to the internet before refreshing application files.",
        true,
      );
      return;
    }
    if (
      !safeToReload() ||
      !confirm(
        "Refresh ProScan application files? Saved document storage will not be cleared.",
      )
    )
      return;
    try {
      // Do not unregister other apps or delete their caches on this origin.
      if ("serviceWorker" in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        const scope = new URL("./", location.href).href;
        for (const reg of registrations)
          if (reg.scope === scope) await reg.unregister();
      }
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter((key) => key.startsWith("proscan-studio-"))
            .map((key) => caches.delete(key)),
        );
      }
      dirty = false;
      location.reload();
    } catch (error) {
      fail("Could not refresh application files.", error);
    }
  });
  $("update-btn").addEventListener("click", () => {
    if (!safeToReload()) return;
    if (updateRegistration?.waiting)
      updateRegistration.waiting.postMessage({ type: "SKIP_WAITING" });
    else location.reload();
  });
  window.addEventListener("beforeunload", (event) => {
    if (
      dirty ||
      saving ||
      busy ||
      !storageAvailable ||
      (eraseActive && eraseCommands().length)
    ) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  async function registerWorker() {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    try {
      const reg = await navigator.serviceWorker.register("./sw.js");
      updateRegistration = reg;
      if (reg.waiting) $("update-toast").hidden = false;
      reg.addEventListener("updatefound", () => {
        const worker = reg.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (
            worker.state === "installed" &&
            navigator.serviceWorker.controller
          )
            $("update-toast").hidden = false;
        });
      });
      let reloading = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        // First installation claims the page without interrupting work.
        if (!$("update-toast").hidden && !reloading) {
          reloading = true;
          location.reload();
        }
      });
    } catch (error) {
      console.warn("Offline installation unavailable:", error);
      notice(
        "App works online, but offline installation failed. Check storage and hosting settings.",
      );
    }
  }
  function loadOpenCV() {
    return new Promise((resolve, reject) => {
      let settled = false,
        poll;
      const timeout = setTimeout(
        () =>
          finish(
            new Error(
              "Image engine did not start within 90 seconds. Reload and check that the vendor folder is uploaded.",
            ),
          ),
        90000,
      );
      function finish(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(poll);
        error ? reject(error) : resolve();
      }
      function check() {
        if (window.cv && typeof window.cv.Mat === "function") finish();
      }
      const script = document.createElement("script");
      script.src = "./vendor/opencv-4.5.4.js";
      script.async = true;
      script.onerror = () =>
        finish(
          new Error(
            "Could not load vendor/opencv-4.5.4.js. Check the uploaded files.",
          ),
        );
      script.onload = () => {
        const engine = window.cv;
        if (engine && typeof engine.then === "function") {
          engine.then(
            (value) => {
              window.cv = value;
              check();
            },
            (error) => finish(error),
          );
        } else if (engine) {
          engine.onRuntimeInitialized = check;
          engine.onAbort = (reason) => finish(new Error(String(reason)));
          check();
        }
      };
      poll = setInterval(check, 100);
      document.head.appendChild(script);
    });
  }
  async function boot() {
    try {
      await loadOpenCV();
      visionReady = true;
      try {
        await loadSavedDocuments();
      } catch (error) {
        storageAvailable = false;
        storageReadable = false;
        fail(
          "Saved pages could not be read. Do not overwrite storage until this is resolved.",
          error,
        );
      }
      $("drop-zone").disabled = false;
      $("loading-overlay").hidden = true;
      registerWorker();
    } catch (error) {
      $("loading-overlay").querySelector(".loader").hidden = true;
      $("loading-text").textContent = error.message || String(error);
      $("btn-retry").hidden = false;
      console.error(error);
    }
  }
  boot();

  function memoryBlocked() {
    return (
      busy || saving || eraseActive || filterSession || shareSession || drawing
    );
  }
  $("btn-memory").addEventListener("click", () => {
    if (memoryBlocked()) {
      notice(
        "Finish or cancel the current tool/Share dialog before freeing memory. Your draft is kept.",
        true,
      );
      return;
    }
    $("memory-drop-undo").checked = false;
    $("memory-drop-undo").disabled = !editUndo;
    $("memory-status").textContent =
      "Saved documents and current edits will stay. Filter engine reloads on next use. AI model is not installed.";
    $("memory-modal").showModal();
  });
  $("memory-close").addEventListener("click", () => $("memory-modal").close());
  $("memory-free").addEventListener("click", () => {
    if (memoryBlocked()) {
      notice("Finish the active operation first.", true);
      return;
    }
    const dropUndo = $("memory-drop-undo").checked;
    if (
      dropUndo &&
      editUndo &&
      !confirm(
        "Discard the previous image-edit Undo snapshot? Current edits and saved documents will stay.",
      )
    )
      return;
    FilterProcessor.releaseMemory();
    clearTimeout(filterPreviewTimer);
    filterPreviewTimer = null;
    thumbnailEpoch++;
    document.querySelectorAll(".filter-item canvas").forEach((c) => {
      c.width = c.height = 1;
    });
    maskCanvas.width =
      maskCanvas.height =
      selection.width =
      selection.height =
        1;
    if (dropUndo) clearEditUndo();
    $("memory-status").textContent =
      "Released filter worker and temporary canvases. " +
      (dropUndo
        ? "Previous image-edit Undo was discarded. "
        : "Undo retained. ") +
      "Documents and current edits are unchanged. The browser controls when RAM is reclaimed; the main crop engine remains loaded.";
    notice(
      "Temporary resources released. Saved documents and current edits kept.",
    );
  });
})();
