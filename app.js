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
    textActive = false,
    signatureActive = false,
    drawing = null;
  let eraseTool = "pen",
    updateRegistration = null,
    storageAvailable = true,
    storageReadable = true;
  let currentFilterSettings = FilterProcessor.defaults("original");
  let filterPreviewTimer = null,
    thumbnailEpoch = 0;
  let currentSourceIsPdf = false,
    recropReturnView = null,
    pdfWorkerFallbackLoaded = false;
  const MAX_EDGE = 2800,
    MAX_FILE_BYTES = 35 * 1024 * 1024,
    MAX_PDF_PAGES = 30;
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
  function readFileBuffer(file) {
    if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () =>
        reject(reader.error || new Error("File read failed."));
      reader.onabort = () => reject(new Error("File read cancelled."));
      reader.readAsArrayBuffer(file);
    });
  }
  function isPdfFile(file) {
    if (!file) return false;
    const type = String(file.type || "").toLowerCase();
    if (type === "application/pdf" || type === "application/x-pdf") return true;
    return /\.pdf$/i.test(file.name || "");
  }
  function isImageFile(file) {
    if (!file) return false;
    const type = String(file.type || "").toLowerCase();
    if (type.startsWith("image/")) return true;
    if (
      (!type || type === "application/octet-stream") &&
      /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(file.name || "")
    )
      return true;
    return false;
  }
  async function openPdfDocument(arrayBuffer) {
    if (!window.pdfjsLib?.getDocument)
      throw new Error(
        "The local PDF reader library could not be loaded. Check vendor/pdf-3.11.174.min.js and reload.",
      );
    if (window.pdfjsLib.GlobalWorkerOptions) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
        "vendor/pdf.worker-3.11.174.min.js",
        document.baseURI,
      ).href;
    }
    const makeTask = (disableWorker) =>
      window.pdfjsLib.getDocument({
        data: new Uint8Array(arrayBuffer.slice(0)),
        isEvalSupported: false,
        useSystemFonts: true,
        disableFontFace: false,
        disableWorker,
      });
    try {
      return await makeTask(false).promise;
    } catch (error) {
      if (
        error?.name === "PasswordException" ||
        /password|encrypted/i.test(error?.message || "")
      )
        throw new Error(
          "This PDF is password-protected. Remove the password and try again.",
        );
      if (
        error?.name === "InvalidPDFException" ||
        error?.name === "MissingPDFException" ||
        /invalid pdf|missing pdf/i.test(error?.message || "")
      )
        throw new Error(
          "Cannot read this PDF file. Check that it is a valid, unencrypted PDF.",
        );
      if (!pdfWorkerFallbackLoaded && !window.pdfjsWorker) {
        await new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = "./vendor/pdf.worker-3.11.174.min.js";
          s.onload = () => {
            pdfWorkerFallbackLoaded = true;
            resolve();
          };
          s.onerror = () =>
            reject(
              new Error(
                "Could not load vendor/pdf.worker-3.11.174.min.js. Check the uploaded vendor folder.",
              ),
            );
          document.head.appendChild(s);
        });
      }
      try {
        return await makeTask(true).promise;
      } catch (fallbackError) {
        if (
          fallbackError?.name === "PasswordException" ||
          /password|encrypted/i.test(fallbackError?.message || "")
        )
          throw new Error(
            "This PDF is password-protected. Remove the password and try again.",
          );
        throw new Error(
          "Cannot read this PDF file. Check that it is a valid, unencrypted PDF.",
        );
      }
    }
  }
  async function renderPdfPageToCanvas(pdfDoc, pageNumber, maxEdge) {
    const page = await pdfDoc.getPage(pageNumber);
    try {
      const baseViewport = page.getViewport({ scale: 1 });
      const maxBaseDim = Math.max(
        1,
        baseViewport.width || 1,
        baseViewport.height || 1,
      );
      const targetEdge = Math.min(maxEdge, Math.max(1600, maxBaseDim * 2.5));
      const scale = Math.min(
        maxEdge / maxBaseDim,
        Math.max(1, targetEdge / maxBaseDim),
      );
      const viewport = page.getViewport({ scale });
      const rendered = document.createElement("canvas");
      rendered.width = Math.max(2, Math.round(viewport.width));
      rendered.height = Math.max(2, Math.round(viewport.height));
      const ctx = rendered.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, rendered.width, rendered.height);
      await page.render({
        canvasContext: ctx,
        viewport,
        background: "rgb(255,255,255)",
      }).promise;
      return rendered;
    } finally {
      try {
        page.cleanup();
      } catch (_) {}
    }
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
    if (currentSourceIsPdf) {
      return [
        { x: 0, y: 0 },
        { x: currentImage.width - 1, y: 0 },
        { x: currentImage.width - 1, y: currentImage.height - 1 },
        { x: 0, y: currentImage.height - 1 },
      ];
    }
    return [
      { x: currentImage.width * 0.05, y: currentImage.height * 0.05 },
      { x: currentImage.width * 0.95, y: currentImage.height * 0.05 },
      { x: currentImage.width * 0.95, y: currentImage.height * 0.95 },
      { x: currentImage.width * 0.05, y: currentImage.height * 0.95 },
    ];
  }
  function isFullPageCorners(points, width, height) {
    if (!Array.isArray(points) || points.length !== 4) return false;
    const expected = [
      { x: 0, y: 0 },
      { x: width - 1, y: 0 },
      { x: width - 1, y: height - 1 },
      { x: 0, y: height - 1 },
    ];
    return expected.every(
      (p, i) =>
        Math.abs(points[i].x - p.x) < 0.5 &&
        Math.abs(points[i].y - p.y) < 0.5,
    );
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
    const pdfUpload = isPdfFile(file);
    await runTask(pdfUpload ? "Opening PDF…" : "Opening document…", async () => {
      if (!pdfUpload && !isImageFile(file))
        throw new Error("Choose an image or PDF file.");
      if (file.size > MAX_FILE_BYTES)
        throw new Error("Choose a file smaller than 35 MB.");
      if (pdfUpload) {
        const buffer = await readFileBuffer(file);
        if (version !== importVersion) return;
        const pdfDoc = await openPdfDocument(buffer);
        try {
          if (version !== importVersion) return;
          const totalPages = pdfDoc.numPages || 0;
          if (totalPages < 1)
            throw new Error("This PDF file contains no pages.");
          if (totalPages > MAX_PDF_PAGES)
            throw new Error(
              `This PDF has ${totalPages} pages. Import a PDF with up to ${MAX_PDF_PAGES} pages at a time for device memory safety.`,
            );
          if (totalPages === 1) {
            setLoading("Rendering PDF page…");
            const rendered = await renderPdfPageToCanvas(
              pdfDoc,
              1,
              MAX_EDGE,
            );
            if (version !== importVersion) return;
            currentImage = rendered;
            currentSourceIsPdf = true;
            recropReturnView = null;
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
              "PDF page opened at full bounds. Adjust the four corners to crop, or tap Flatten & Process to edit filters, erase or save.",
            );
          } else {
            const pageMaxEdge = totalPages <= 10 ? 2200 : 1800;
            const importedPages = [];
            for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
              if (version !== importVersion) return;
              setLoading(
                `Rendering PDF page ${pageNum} of ${totalPages}…`,
              );
              await new Promise((resolve) => setTimeout(resolve, 0));
              const rendered = await renderPdfPageToCanvas(
                pdfDoc,
                pageNum,
                pageMaxEdge,
              );
              try {
                const pngDataUrl = rendered.toDataURL("image/png");
                const origDataUrl = rendered.toDataURL("image/jpeg", 0.95);
                importedPages.push({
                  stage1Version: 1,
                  stage2Version: 1,
                  stage3Version: 1,
                  stage32Version: 1,
                  fromPdf: true,
                  filterSettings: { ...FilterProcessor.defaults("original") },
                  id: crypto.randomUUID
                    ? crypto.randomUUID()
                    : `${Date.now()}-${Math.random()}-${pageNum}`,
                  original: origDataUrl,
                  cropped: pngDataUrl,
                  filter: "original",
                  final: pngDataUrl,
                });
              } finally {
                rendered.width = rendered.height = 1;
              }
            }
            if (version !== importVersion) return;
            recropReturnView = null;
            documentPages.push(...importedPages);
            const saved = await persist();
            dirty = !saved;
            renderGallery();
            showView("gallery-view");
            notice(
              `Imported ${importedPages.length} pages from PDF. Tap any page to edit, filter, crop or erase, or use Export / Share PDF.`,
            );
          }
        } finally {
          try {
            await pdfDoc.cleanup();
          } catch (_) {}
          try {
            await pdfDoc.destroy();
          } catch (_) {}
        }
        return;
      }
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
      currentSourceIsPdf = false;
      recropReturnView = null;
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
    if (recropReturnView === "process-view") {
      recropReturnView = null;
      showView("process-view");
      return;
    }
    if (dirty && !confirm("Discard this unsaved scan?")) return;
    dirty = false;
    showView(documentPages.length ? "gallery-view" : "upload-area");
  });
  $("btn-crop").addEventListener("click", async () => {
    const ok = await runTask("Flattening document…", async () => {
      const nextBase = document.createElement("canvas"),
        nextFinal = document.createElement("canvas");
      if (
        currentSourceIsPdf &&
        isFullPageCorners(corners, currentImage.width, currentImage.height)
      ) {
        VisionEngine.validateCorners(corners);
        copy(currentImage, nextBase);
      } else {
        VisionEngine.warpPerspective(currentImage, corners, nextBase);
      }
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
    if (ok) {
      recropReturnView = null;
      showView("process-view");
    } else updatePreview();
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
    if (
      busy ||
      saving ||
      eraseActive ||
      textActive ||
      signatureActive ||
      filterSession
    )
      return;
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

  $("btn-recrop").addEventListener("click", () => {
    if (
      busy ||
      saving ||
      eraseActive ||
      textActive ||
      signatureActive ||
      filterSession ||
      !currentImage
    )
      return;
    if (activePageId !== null) {
      if (
        dirty &&
        !confirm(
          "Re-cropping starts from this page's original source image and replaces unsaved edits. Continue?",
        )
      )
        return;
      recropReturnView = "process-view";
      initStudio();
    } else {
      if (
        dirty &&
        editUndo &&
        !confirm(
          "Return to crop? Reprocessing will replace your unsaved filter or erase edits.",
        )
      )
        return;
      showView("crop-view");
    }
  });
  $("btn-rotate").addEventListener("click", async () => {
    if (eraseActive || textActive || signatureActive || filterSession) return;
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
    if (!editUndo || busy || eraseActive || textActive || signatureActive)
      return;
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
    if (
      busy ||
      saving ||
      filterSession ||
      eraseActive ||
      textActive ||
      signatureActive
    )
      return;
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

  // Stage 4.3 Add Text + Signature: local-only, no uploads. Text matches
  // nearby scanned text via connected-components analysis; signatures are
  // converted to B&W, cropped, background-removed to transparent alpha, and
  // composited with a pre-scan multiply blend. Both commit through the same
  // single-level Undo edit snapshot as Filters/Erase.
  const TEXT_FONT_STACKS = {
    sans: "Arial, Helvetica, sans-serif",
    serif: 'Georgia, "Times New Roman", Times, serif',
    humanist: 'Calibri, "Segoe UI", Arial, sans-serif',
    mono: '"Courier New", Courier, monospace',
    narrow: '"Arial Narrow", Arial, sans-serif',
  };
  const TEXT_FONT_LABELS = {
    sans: "Sans",
    serif: "Serif",
    humanist: "Office Sans",
    mono: "Typewriter",
    narrow: "Narrow",
  };
  const SIG_INK_COLORS = {
    black: "#14161a",
    blue: "#2b4acb",
    charcoal: "#33373d",
  };
  function clampNum(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }
  function hexToRgb(hex) {
    const h = String(hex || "#000000").replace("#", "");
    const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgbToHex(r, g, b) {
    return (
      "#" +
      [r, g, b]
        .map((v) => clampNum(Math.round(v), 0, 255).toString(16).padStart(2, "0"))
        .join("")
    );
  }
  function medianOf(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }
  function percentileOf(values, q) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  }
  function textFontString(size, weight, familyKey) {
    return `${weight} ${size}px ${TEXT_FONT_STACKS[familyKey] || TEXT_FONT_STACKS.sans}`;
  }
  function getTextSettings() {
    return {
      text: $("text-content-input").value,
      family: $("text-font-family").value,
      weight: Number($("text-font-weight").value) || 500,
      size: Number($("text-font-size").value) || 28,
      ink: $("text-ink-color").value || "#22252a",
      autoFit: $("text-auto-fit").checked,
      coverBg: $("text-cover-bg").checked,
      softness: Number($("text-scan-softness").value) || 0,
      letterSpacing: Number($("text-letter-spacing").value) || 0,
    };
  }
  function setTextControls(style) {
    if (!style) return;
    if (style.fontFamily && TEXT_FONT_STACKS[style.fontFamily])
      $("text-font-family").value = style.fontFamily;
    if (style.fontWeight) $("text-font-weight").value = String(style.fontWeight);
    if (style.fontSize) {
      $("text-font-size").value = String(clampNum(Math.round(style.fontSize), 8, 140));
      $("text-font-size-value").textContent = `${$("text-font-size").value}px`;
    }
    if (style.inkColor) $("text-ink-color").value = style.inkColor;
    if (Number.isFinite(style.letterSpacing))
      $("text-letter-spacing").value = String(clampNum(style.letterSpacing, -20, 60));
  }
  function measureTextLayout(text, size, weight, familyKey, letterSpacing, boxWidth) {
    const lines = String(text || "").split("\n");
    const measureCanvas = document.createElement("canvas");
    const mctx = measureCanvas.getContext("2d");
    mctx.font = textFontString(size, weight, familyKey);
    try {
      mctx.letterSpacing = `${letterSpacing || 0}px`;
    } catch (e) {
      /* letterSpacing unsupported: ignore */
    }
    let maxWidth = 0;
    for (const line of lines) {
      const w = mctx.measureText(line || " ").width + (letterSpacing || 0) * Math.max(0, line.length - 1);
      maxWidth = Math.max(maxWidth, w);
    }
    const lineHeight = size * 1.28;
    return {
      lines,
      maxWidth,
      totalHeight: lineHeight * Math.max(1, lines.length),
      lineHeight,
      fits: maxWidth <= boxWidth && lineHeight * lines.length <= boxWidth * 4,
    };
  }
  function fitTextFontSize(text, box, weight, familyKey, letterSpacing) {
    if (!String(text || "").trim()) return null;
    const pad = 8;
    const availW = Math.max(20, box.w - pad * 2);
    const availH = Math.max(16, box.h - pad * 2);
    let lo = 8,
      hi = 140,
      best = 8;
    for (let i = 0; i < 24; i++) {
      const mid = Math.round((lo + hi) / 2);
      const layout = measureTextLayout(text, mid, weight, familyKey, letterSpacing, availW);
      if (layout.maxWidth <= availW && layout.totalHeight <= availH) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return best;
  }
  // Connected-components text sampling: threshold the region against its
  // paper luminance, label ink blobs, then derive glyph height, stroke
  // weight, serif/narrow/mono cues and median ink color.
  function sampleTextStyle(region) {
    const src = finalCanvas;
    if (!src || !src.width || !src.height) return null;
    const x0 = clampNum(Math.round(Math.min(region.x, region.x + region.w)), 0, src.width - 1);
    const y0 = clampNum(Math.round(Math.min(region.y, region.y + region.h)), 0, src.height - 1);
    const x1 = clampNum(Math.round(Math.max(region.x, region.x + region.w)), x0 + 1, src.width);
    const y1 = clampNum(Math.round(Math.max(region.y, region.y + region.h)), y0 + 1, src.height);
    const w = x1 - x0,
      h = y1 - y0;
    if (w < 12 || h < 12) return null;
    const scale = Math.min(1, 900 / Math.max(w, h));
    const aw = Math.max(2, Math.round(w * scale)),
      ah = Math.max(2, Math.round(h * scale));
    const tmp = document.createElement("canvas");
    tmp.width = aw;
    tmp.height = ah;
    const tctx = tmp.getContext("2d", { willReadFrequently: true });
    tctx.drawImage(src, x0, y0, w, h, 0, 0, aw, ah);
    let imageData;
    try {
      imageData = tctx.getImageData(0, 0, aw, ah);
    } catch (e) {
      return null;
    }
    const data = imageData.data;
    const count = aw * ah;
    const lum = new Float32Array(count);
    const lums = new Array(count);
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      const l = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
      lum[i] = l;
      lums[i] = l;
    }
    const paper = percentileOf(lums, 0.88);
    const inkThreshold = Math.min(paper - 38, 205);
    if (paper < 90) return null;
    const ink = new Uint8Array(count);
    let inkCount = 0;
    for (let i = 0; i < count; i++) {
      if (lum[i] < inkThreshold) {
        ink[i] = 1;
        inkCount++;
      }
    }
    if (inkCount < 24) return null;
    // 8-connected labeling with an explicit stack.
    const labels = new Int32Array(count).fill(-1);
    const components = [];
    const stack = new Int32Array(count);
    for (let start = 0; start < count; start++) {
      if (!ink[start] || labels[start] !== -1) continue;
      const id = components.length;
      let sp = 0;
      stack[sp++] = start;
      labels[start] = id;
      let minX = aw,
        maxX = -1,
        minY = ah,
        maxY = -1,
        area = 0;
      const pixels = [];
      while (sp > 0) {
        const p = stack[--sp];
        const px = p % aw,
          py = (p / aw) | 0;
        area++;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        if (pixels.length < 4000) pixels.push(p);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = px + dx,
              ny = py + dy;
            if (nx < 0 || ny < 0 || nx >= aw || ny >= ah) continue;
            const np = ny * aw + nx;
            if (ink[np] && labels[np] === -1) {
              labels[np] = id;
              stack[sp++] = np;
            }
          }
        }
      }
      components.push({ minX, maxX, minY, maxY, area, pixels });
    }
    const glyphs = components.filter((c) => {
      const cw = c.maxX - c.minX + 1,
        ch = c.maxY - c.minY + 1;
      return ch >= 4 && ch <= ah * 0.55 && cw >= 2 && cw <= aw * 0.45 && c.area >= 6;
    });
    if (glyphs.length < 3) return null;
    const heights = glyphs.map((c) => c.maxY - c.minY + 1);
    const widths = glyphs.map((c) => c.maxX - c.minX + 1);
    const capHeight = percentileOf(heights, 0.75);
    if (capHeight < 4) return null;
    const fontSize = clampNum(Math.round(capHeight / 0.7 / scale), 8, 140);
    // Stroke width = median horizontal ink run length per glyph row. One
    // pixel is subtracted because antialiased edges are counted as ink at
    // both sides of a stem, which otherwise inflates every weight.
    const runMedians = [];
    for (const c of glyphs) {
      const rows = new Map();
      for (const p of c.pixels) {
        const py = (p / aw) | 0;
        if (!rows.has(py)) rows.set(py, []);
        rows.get(py).push(p % aw);
      }
      const runs = [];
      for (const xs of rows.values()) {
        xs.sort((a, b) => a - b);
        let len = 1;
        for (let i = 1; i < xs.length; i++) {
          if (xs[i] === xs[i - 1] + 1) len++;
          else {
            runs.push(len);
            len = 1;
          }
        }
        runs.push(len);
      }
      if (runs.length) runMedians.push(medianOf(runs));
    }
    const medianStroke = medianOf(runMedians) || 2;
    const ratio = Math.max(1, medianStroke - 1) / Math.max(1, capHeight);
    const fontWeight = ratio < 0.175 ? 400 : ratio < 0.21 ? 500 : ratio < 0.26 ? 600 : 700;
    // Serif cue: ink row width near the baseline vs the middle rows.
    let serifVotes = 0,
      tallCount = 0;
    for (const c of glyphs) {
      const ch = c.maxY - c.minY + 1;
      if (ch < 7) continue;
      tallCount++;
      const bottomRows = new Set();
      const midRows = new Set();
      for (const p of c.pixels) {
        const py = (p / aw) | 0;
        if (py >= c.maxY - 2) bottomRows.add(p);
        if (py >= c.minY + Math.floor(ch / 2) - 1 && py <= c.minY + Math.floor(ch / 2) + 1)
          midRows.add(p);
      }
      const bottomW = bottomRows.size / 3;
      const midW = Math.max(1, midRows.size / 3);
      if (bottomW > midW * 1.3) serifVotes++;
    }
    const serifScore = tallCount ? serifVotes / tallCount : 0;
    const meanWidth = widths.reduce((a, b) => a + b, 0) / widths.length;
    const widthStd = Math.sqrt(
      widths.reduce((a, b) => a + (b - meanWidth) * (b - meanWidth), 0) / widths.length,
    );
    const medianAspect = medianOf(glyphs.map((c) => (c.maxX - c.minX + 1) / Math.max(1, c.maxY - c.minY + 1)));
    let fontFamily = "sans";
    if (serifScore > 0.35) fontFamily = "serif";
    else if (glyphs.length >= 8 && meanWidth > 0 && widthStd / meanWidth < 0.2) fontFamily = "mono";
    else if (medianAspect < 0.52) fontFamily = "narrow";
    // Median ink color from the darkest ink pixels.
    const inkPixels = [];
    for (let i = 0; i < count; i++) {
      if (ink[i]) {
        const o = i * 4;
        inkPixels.push({ l: lum[i], r: data[o], g: data[o + 1], b: data[o + 2] });
      }
    }
    inkPixels.sort((a, b) => a.l - b.l);
    const darkest = inkPixels.slice(0, Math.max(1, Math.floor(inkPixels.length * 0.3)));
    const inkColor = rgbToHex(
      medianOf(darkest.map((p) => p.r)),
      medianOf(darkest.map((p) => p.g)),
      medianOf(darkest.map((p) => p.b)),
    );
    return { fontSize, fontFamily, fontWeight, inkColor, letterSpacing: 0, glyphs: glyphs.length };
  }
  let textSession = null,
    textFrame = null;
  function updateTextTransform() {
    if (!textSession) return;
    const session = textSession;
    if (session.zoom <= 1) {
      session.panX = 0;
      session.panY = 0;
    } else {
      const maxX =
        Math.max(0, (surface.offsetWidth * session.zoom - editorStage.clientWidth) / 2) +
        editorStage.clientWidth * 0.2;
      const maxY =
        Math.max(0, (surface.offsetHeight * session.zoom - editorStage.clientHeight) / 2) +
        editorStage.clientHeight * 0.2;
      session.panX = clampNum(session.panX, -maxX, maxX);
      session.panY = clampNum(session.panY, -maxY, maxY);
    }
    surface.style.transform = `translate(${session.panX}px, ${session.panY}px) scale(${session.zoom})`;
    $("text-zoom").value = `${Math.round(session.zoom * 100)}%`;
  }
  function positionTextEditor() {
    if (!textActive) return;
    const height = $("text-panel").getBoundingClientRect().height;
    const top = Math.max(
      70,
      document.querySelector(".navbar").getBoundingClientRect().bottom + 8,
    );
    document.body.style.setProperty("--erase-sheet-height", `${height + 12}px`);
    document.body.style.setProperty("--erase-editor-top", `${top}px`);
    updateTextTransform();
  }
  if (typeof ResizeObserver !== "undefined")
    new ResizeObserver(positionTextEditor).observe($("text-panel"));
  window.addEventListener("resize", positionTextEditor);
  function textHandleSize() {
    return Math.max(12, (maskCanvas.width || 800) * 0.018);
  }
  function textCornerAt(point, box) {
    const hs = textHandleSize();
    const corners = [
      { key: "tl", x: box.x, y: box.y },
      { key: "tr", x: box.x + box.w, y: box.y },
      { key: "br", x: box.x + box.w, y: box.y + box.h },
      { key: "bl", x: box.x, y: box.y + box.h },
    ];
    for (const corner of corners)
      if (Math.abs(point.x - corner.x) <= hs && Math.abs(point.y - corner.y) <= hs)
        return corner.key;
    return null;
  }
  function drawTextBoxChrome(ctx, box) {
    const hs = textHandleSize();
    ctx.save();
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = Math.max(1.5, maskCanvas.width / 900);
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    ctx.setLineDash([]);
    ctx.fillStyle = "#22d3ee";
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    for (const [cx, cy] of [
      [box.x, box.y],
      [box.x + box.w, box.y],
      [box.x + box.w, box.y + box.h],
      [box.x, box.y + box.h],
    ]) {
      ctx.beginPath();
      ctx.rect(cx - hs / 2, cy - hs / 2, hs, hs);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
  function drawTextInto(ctx, settings, box, forFinal) {
    const text = settings.text;
    if (!String(text || "").trim()) return;
    const pad = 8;
    ctx.save();
    ctx.font = textFontString(settings.size, settings.weight, settings.family);
    try {
      ctx.letterSpacing = `${settings.letterSpacing || 0}px`;
    } catch (e) {
      /* ignore */
    }
    ctx.fillStyle = settings.ink;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    const blur = (settings.softness / 100) * 1.1;
    if (blur > 0.05) {
      try {
        ctx.filter = `blur(${blur}px)`;
      } catch (e) {
        /* ignore */
      }
    }
    if (!forFinal) ctx.globalAlpha = 1 - (settings.softness / 100) * 0.08;
    const lines = String(text).split("\n");
    const lineHeight = settings.size * 1.28;
    lines.forEach((line, i) => {
      ctx.fillText(line, box.x + pad, box.y + pad + i * lineHeight);
    });
    ctx.restore();
  }
  function renderTextPreview() {
    if (!textActive || !textSession) return;
    const ctx = maskCanvas.getContext("2d");
    ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    const settings = getTextSettings();
    const box = textSession.box;
    if (settings.coverBg && String(settings.text || "").trim()) {
      const bounds = { x0: box.x, y0: box.y, x1: box.x + box.w, y1: box.y + box.h };
      const field = textSession.paper.field(bounds);
      const pattern = ctx.createPattern(field.tile, "no-repeat");
      pattern.setTransform(
        new DOMMatrix()
          .translate(field.x - field.width / 24, field.y - field.height / 24)
          .scale(field.width / 24, field.height / 24),
      );
      ctx.save();
      ctx.fillStyle = pattern;
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.restore();
      field.tile.width = field.tile.height = 1;
    }
    drawTextInto(ctx, settings, box, false);
    if (!textSession.hideBox) drawTextBoxChrome(ctx, box);
    if (textSession.sampleRect) {
      const r = textSession.sampleRect;
      ctx.save();
      ctx.strokeStyle = "#fbbf24";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.restore();
    }
    if (textSession.targetRect) {
      const r = textSession.targetRect;
      ctx.save();
      ctx.strokeStyle = "#a78bfa";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.restore();
    }
  }
  function requestTextRender() {
    if (textFrame !== null) return;
    textFrame = requestAnimationFrame(() => {
      textFrame = null;
      renderTextPreview();
    });
  }
  function syncTextApplyButton() {
    $("btn-apply-text").disabled = !String($("text-content-input").value || "").trim() || busy;
  }
  function autoFitTextBox() {
    if (!textSession) return;
    const settings = getTextSettings();
    if (!settings.autoFit || !String(settings.text || "").trim()) return;
    const fitted = fitTextFontSize(
      settings.text,
      textSession.box,
      settings.weight,
      settings.family,
      settings.letterSpacing,
    );
    if (fitted && fitted !== settings.size) {
      $("text-font-size").value = String(fitted);
      $("text-font-size-value").textContent = `${fitted}px`;
    }
  }
  function sizeBoxToText() {
    if (!textSession) return;
    const settings = getTextSettings();
    const layout = measureTextLayout(
      settings.text || "Text",
      settings.size,
      settings.weight,
      settings.family,
      settings.letterSpacing,
      1e9,
    );
    const pad = 16;
    const box = textSession.box;
    box.w = clampNum(Math.ceil(layout.maxWidth + pad), 40, maskCanvas.width);
    box.h = clampNum(Math.ceil(layout.totalHeight + pad), 24, maskCanvas.height);
    box.x = clampNum(box.x, 0, Math.max(0, maskCanvas.width - box.w));
    box.y = clampNum(box.y, 0, Math.max(0, maskCanvas.height - box.h));
    requestTextRender();
  }
  function autoSampleText() {
    if (!textSession) return;
    const W = finalCanvas.width,
      H = finalCanvas.height;
    const center = { x: W * 0.18, y: H * 0.28, w: W * 0.64, h: H * 0.44 };
    let style = sampleTextStyle(center);
    if (!style) style = sampleTextStyle({ x: W * 0.05, y: H * 0.05, w: W * 0.9, h: H * 0.9 });
    if (style) {
      setTextControls(style);
      $("text-match-badge").textContent =
        `Matched ${style.fontSize}px ${TEXT_FONT_LABELS[style.fontFamily] || "Sans"} ${style.fontWeight} · ${style.inkColor}`;
      $("text-hint").textContent =
        "Matched to nearby text. Use “⊕ Sample text” to sample any line, or drag the box handles to fit.";
    } else {
      $("text-match-badge").textContent = "Defaults · no text found";
      $("text-hint").textContent =
        "No nearby text detected. Type your text, or use “⊕ Sample text” and drag over any printed line.";
    }
  }
  function openText() {
    if (
      busy ||
      saving ||
      eraseActive ||
      textActive ||
      signatureActive ||
      filterSession ||
      !finalCanvas.width ||
      !finalCanvas.height
    )
      return;
    maskCanvas.width = finalCanvas.width;
    maskCanvas.height = finalCanvas.height;
    const W = finalCanvas.width,
      H = finalCanvas.height;
    const size = Number($("text-font-size").value) || 28;
    textSession = {
      box: {
        x: Math.round(W * 0.2),
        y: Math.round(H * 0.42),
        w: Math.round(W * 0.6),
        h: Math.round(size * 2.4),
      },
      paper: PaperMatch.create(finalCanvas),
      zoom: 1,
      panX: 0,
      panY: 0,
      pointers: new Map(),
      gesture: null,
      drag: null,
      sampling: false,
      targetMode: false,
      sampleRect: null,
      targetRect: null,
      hideBox: false,
    };
    textActive = true;
    drawing = null;
    $("text-panel").hidden = false;
    document.body.classList.add("text-editing");
    $("btn-sample-text-style").setAttribute("aria-pressed", "false");
    $("btn-draw-text-box").setAttribute("aria-pressed", "false");
    $("btn-preview-text-clean").setAttribute("aria-pressed", "false");
    $("btn-preview-text-clean").textContent = "Hide box";
    document.body.classList.remove("sampling-mode");
    autoSampleText();
    autoFitTextBox();
    syncTextApplyButton();
    requestAnimationFrame(() => {
      positionTextEditor();
      renderTextPreview();
    });
  }
  function closeText() {
    if (!textActive) return;
    textActive = false;
    textSession = null;
    if (textFrame !== null) cancelAnimationFrame(textFrame);
    textFrame = null;
    document.body.classList.remove("text-editing", "sampling-mode");
    $("text-panel").hidden = true;
    surface.style.transform = "";
    maskCanvas.width = maskCanvas.height = 1;
  }
  function applyText() {
    if (!textActive || !textSession || busy) return;
    const settings = getTextSettings();
    if (!String(settings.text || "").trim()) return;
    const box = { ...textSession.box };
    const paper = textSession.paper;
    rememberEdit();
    const ctx = finalCanvas.getContext("2d");
    if (settings.coverBg) {
      const bounds = { x0: box.x, y0: box.y, x1: box.x + box.w, y1: box.y + box.h };
      const field = paper.field(bounds);
      const pattern = ctx.createPattern(field.tile, "no-repeat");
      pattern.setTransform(
        new DOMMatrix()
          .translate(field.x - field.width / 24, field.y - field.height / 24)
          .scale(field.width / 24, field.height / 24),
      );
      ctx.save();
      ctx.fillStyle = pattern;
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.restore();
      field.tile.width = field.tile.height = 1;
    }
    drawTextInto(ctx, settings, box, true);
    copy(finalCanvas, bufferCanvas);
    currentFilter = "original";
    currentFilterSettings = FilterProcessor.defaults("original");
    syncFilters(currentFilter);
    markDirty();
    closeText();
  }
  $("btn-open-text").addEventListener("click", openText);
  $("btn-cancel-text").addEventListener("click", closeText);
  $("btn-apply-text").addEventListener("click", applyText);
  $("btn-fit-box-to-text").addEventListener("click", sizeBoxToText);
  $("btn-sample-text-style").addEventListener("click", () => {
    if (!textSession || busy) return;
    textSession.sampling = !textSession.sampling;
    if (textSession.sampling) textSession.targetMode = false;
    $("btn-sample-text-style").setAttribute("aria-pressed", String(textSession.sampling));
    $("btn-draw-text-box").setAttribute("aria-pressed", String(textSession.targetMode));
    document.body.classList.toggle("sampling-mode", textSession.sampling);
    $("text-hint").textContent = textSession.sampling
      ? "Drag over existing document text to sample its size, font and ink color."
      : "Sampling cancelled. Drag the box to move it, or drag a corner to resize.";
    requestTextRender();
  });
  $("btn-draw-text-box").addEventListener("click", () => {
    if (!textSession || busy) return;
    textSession.targetMode = !textSession.targetMode;
    if (textSession.targetMode) textSession.sampling = false;
    $("btn-draw-text-box").setAttribute("aria-pressed", String(textSession.targetMode));
    $("btn-sample-text-style").setAttribute("aria-pressed", String(textSession.sampling));
    document.body.classList.toggle("sampling-mode", textSession.sampling);
    $("text-hint").textContent = textSession.targetMode
      ? "Drag a target box on the document where the text must fit."
      : "Target box cancelled. Drag the box to move it, or drag a corner to resize.";
    requestTextRender();
  });
  $("btn-preview-text-clean").addEventListener("click", () => {
    if (!textSession || busy) return;
    textSession.hideBox = !textSession.hideBox;
    $("btn-preview-text-clean").setAttribute("aria-pressed", String(textSession.hideBox));
    $("btn-preview-text-clean").textContent = textSession.hideBox ? "Show box" : "Hide box";
    requestTextRender();
  });
  function zoomText(value) {
    if (!textSession || busy) return;
    textSession.zoom = clampNum(value, 1, 4);
    updateTextTransform();
  }
  $("btn-text-zoom-in").addEventListener("click", () => zoomText((textSession?.zoom || 1) + 0.25));
  $("btn-text-zoom-out").addEventListener("click", () => zoomText((textSession?.zoom || 1) - 0.25));
  $("btn-text-zoom-fit").addEventListener("click", () => {
    if (!textSession || busy) return;
    textSession.panX = textSession.panY = 0;
    zoomText(1);
  });
  $("text-content-input").addEventListener("input", () => {
    syncTextApplyButton();
    autoFitTextBox();
    requestTextRender();
  });
  ["text-font-family", "text-font-weight", "text-ink-color", "text-letter-spacing", "text-scan-softness", "text-cover-bg"].forEach(
    (id) => {
      $(id).addEventListener("input", () => {
        autoFitTextBox();
        requestTextRender();
      });
      $(id).addEventListener("change", () => {
        autoFitTextBox();
        requestTextRender();
      });
    },
  );
  $("text-font-size").addEventListener("input", () => {
    $("text-font-size-value").textContent = `${$("text-font-size").value}px`;
    requestTextRender();
  });
  $("text-auto-fit").addEventListener("change", () => {
    autoFitTextBox();
    requestTextRender();
  });
  function textPinchMetrics() {
    const [a, b] = [...textSession.pointers.values()];
    return {
      distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
    };
  }
  editorStage.addEventListener("pointerdown", (event) => {
    if (!textActive || !textSession || busy || event.button !== 0) return;
    event.preventDefault();
    const session = textSession;
    session.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    editorStage.setPointerCapture(event.pointerId);
    if (session.pointers.size >= 2) {
      session.drag = null;
      session.sampleRect = null;
      session.targetRect = null;
      if (!session.gesture)
        session.gesture = {
          ...textPinchMetrics(),
          zoom: session.zoom,
          panX: session.panX,
          panY: session.panY,
        };
      requestTextRender();
      return;
    }
    if (session.gesture) return;
    const point = maskPoint(event);
    const box = session.box;
    const corner = textCornerAt(point, box);
    const inside =
      point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h;
    if (session.sampling) {
      session.drag = { mode: "sample", start: point, current: point };
      session.sampleRect = { x: point.x, y: point.y, w: 0, h: 0 };
    } else if (corner) {
      session.drag = { mode: "resize", corner, start: point, orig: { ...box } };
    } else if (inside) {
      session.drag = { mode: "move", start: point, orig: { ...box } };
    } else if (session.targetMode) {
      session.drag = { mode: "target", start: point, current: point };
      session.targetRect = { x: point.x, y: point.y, w: 0, h: 0 };
    } else {
      session.drag = {
        mode: "pan",
        start: { x: event.clientX, y: event.clientY },
        panX: session.panX,
        panY: session.panY,
        orig: { ...box },
        moved: false,
      };
    }
    requestTextRender();
  });
  editorStage.addEventListener("pointermove", (event) => {
    if (!textActive || !textSession || busy || !textSession.pointers.has(event.pointerId)) return;
    const session = textSession;
    session.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (session.gesture) {
      if (session.pointers.size < 2) return;
      const metric = textPinchMetrics(),
        origin = session.gesture;
      session.zoom = clampNum((origin.zoom * metric.distance) / origin.distance, 1, 4);
      session.panX = origin.panX + metric.x - origin.x;
      session.panY = origin.panY + metric.y - origin.y;
      updateTextTransform();
      return;
    }
    const drag = session.drag;
    if (!drag) return;
    const point = maskPoint(event);
    const box = session.box;
    if (drag.mode === "sample") {
      drag.current = point;
      session.sampleRect = {
        x: Math.min(drag.start.x, point.x),
        y: Math.min(drag.start.y, point.y),
        w: Math.abs(point.x - drag.start.x),
        h: Math.abs(point.y - drag.start.y),
      };
    } else if (drag.mode === "target") {
      drag.current = point;
      session.targetRect = {
        x: Math.min(drag.start.x, point.x),
        y: Math.min(drag.start.y, point.y),
        w: Math.abs(point.x - drag.start.x),
        h: Math.abs(point.y - drag.start.y),
      };
    } else if (drag.mode === "move") {
      box.x = clampNum(drag.orig.x + point.x - drag.start.x, 0, Math.max(0, maskCanvas.width - box.w));
      box.y = clampNum(drag.orig.y + point.y - drag.start.y, 0, Math.max(0, maskCanvas.height - box.h));
    } else if (drag.mode === "resize") {
      const orig = drag.orig;
      let nx = orig.x,
        ny = orig.y,
        nw = orig.w,
        nh = orig.h;
      if (drag.corner === "br") {
        nw = point.x - orig.x;
        nh = point.y - orig.y;
      } else if (drag.corner === "tr") {
        nw = point.x - orig.x;
        nh = orig.y + orig.h - point.y;
        ny = point.y;
      } else if (drag.corner === "bl") {
        nw = orig.x + orig.w - point.x;
        nh = point.y - orig.y;
        nx = point.x;
      } else {
        nw = orig.x + orig.w - point.x;
        nh = orig.y + orig.h - point.y;
        nx = point.x;
        ny = point.y;
      }
      nw = Math.max(30, nw);
      nh = Math.max(20, nh);
      if (drag.corner === "tl" || drag.corner === "bl") nx = orig.x + orig.w - nw;
      if (drag.corner === "tl" || drag.corner === "tr") ny = orig.y + orig.h - nh;
      box.x = clampNum(nx, 0, Math.max(0, maskCanvas.width - nw));
      box.y = clampNum(ny, 0, Math.max(0, maskCanvas.height - nh));
      box.w = nw;
      box.h = nh;
    } else if (drag.mode === "pan") {
      const dx = event.clientX - drag.start.x,
        dy = event.clientY - drag.start.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (session.zoom > 1) {
        session.panX = drag.panX + dx;
        session.panY = drag.panY + dy;
        updateTextTransform();
      } else {
        const rect = maskCanvas.getBoundingClientRect();
        const sx = maskCanvas.width / Math.max(1, rect.width),
          sy = maskCanvas.height / Math.max(1, rect.height);
        box.x = clampNum(drag.orig.x + dx * sx, 0, Math.max(0, maskCanvas.width - box.w));
        box.y = clampNum(drag.orig.y + dy * sy, 0, Math.max(0, maskCanvas.height - box.h));
      }
    }
    requestTextRender();
  });
  function endTextPointer(event) {
    if (!textActive || !textSession?.pointers.has(event.pointerId)) return;
    const session = textSession;
    const drag = session.drag;
    if (drag && event.type === "pointerup" && !session.gesture) {
      if (drag.mode === "sample" && session.sampleRect) {
        let rect = { ...session.sampleRect };
        if (rect.w < 8 || rect.h < 8)
          rect = { x: rect.x - 30, y: rect.y - 14, w: 60, h: 28 };
        const style = sampleTextStyle(rect);
        if (style) {
          setTextControls(style);
          $("text-match-badge").textContent =
            `Sampled ${style.fontSize}px ${TEXT_FONT_LABELS[style.fontFamily] || "Sans"} ${style.fontWeight} · ${style.inkColor}`;
          $("text-hint").textContent =
            "Sampled from your selection. Drag the box to position, or drag a corner to resize.";
          autoFitTextBox();
        } else {
          $("text-hint").textContent =
            "No text found in that selection. Drag over a printed line and try again.";
        }
        session.sampling = false;
        $("btn-sample-text-style").setAttribute("aria-pressed", "false");
        document.body.classList.remove("sampling-mode");
        session.sampleRect = null;
      } else if (drag.mode === "target" && session.targetRect) {
        const rect = session.targetRect;
        if (rect.w >= 24 && rect.h >= 14) {
          session.box = {
            x: clampNum(Math.round(rect.x), 0, maskCanvas.width - 1),
            y: clampNum(Math.round(rect.y), 0, maskCanvas.height - 1),
            w: Math.min(Math.round(rect.w), maskCanvas.width - session.box.x),
            h: Math.min(Math.round(rect.h), maskCanvas.height - session.box.y),
          };
          autoFitTextBox();
          $("text-hint").textContent =
            "Target box set. Text auto-fitted inside. Drag to move, or drag a corner to resize.";
        }
        session.targetMode = false;
        $("btn-draw-text-box").setAttribute("aria-pressed", "false");
        session.targetRect = null;
      } else if (drag.mode === "resize" || drag.mode === "move") {
        autoFitTextBox();
      }
      session.drag = null;
    }
    session.pointers.delete(event.pointerId);
    if (!session.pointers.size) session.gesture = null;
    if (editorStage.hasPointerCapture(event.pointerId))
      editorStage.releasePointerCapture(event.pointerId);
    requestTextRender();
  }
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((type) =>
    editorStage.addEventListener(type, endTextPointer),
  );
  editorStage.addEventListener(
    "wheel",
    (event) => {
      if (!textActive || !textSession || !event.ctrlKey) return;
      event.preventDefault();
      zoomText(textSession.zoom + (event.deltaY < 0 ? 0.15 : -0.15));
    },
    { passive: false },
  );
  // Signature: drawpad + scan/upload -> B&W -> crop popup -> transparent
  // alpha matting -> pre-scan multiply placement with session reuse.
  let sigSession = null,
    sigFrame = null,
    savedSignature = null;
  let sigDrawStrokes = [],
    sigDrawCurrent = null;
  let sigSourceImage = null,
    sigBwCanvas = null,
    sigCropBox = null,
    sigCropDrag = null,
    sigCropConfirmed = false,
    sigAdvancing = false;
  function updateSigTransform() {
    if (!sigSession) return;
    const session = sigSession;
    if (session.zoom <= 1) {
      session.panX = 0;
      session.panY = 0;
    } else {
      const maxX =
        Math.max(0, (surface.offsetWidth * session.zoom - editorStage.clientWidth) / 2) +
        editorStage.clientWidth * 0.2;
      const maxY =
        Math.max(0, (surface.offsetHeight * session.zoom - editorStage.clientHeight) / 2) +
        editorStage.clientHeight * 0.2;
      session.panX = clampNum(session.panX, -maxX, maxX);
      session.panY = clampNum(session.panY, -maxY, maxY);
    }
    surface.style.transform = `translate(${session.panX}px, ${session.panY}px) scale(${session.zoom})`;
    $("sig-zoom").value = `${Math.round(session.zoom * 100)}%`;
  }
  function positionSigEditor() {
    if (!signatureActive || $("signature-panel").hidden) return;
    const height = $("signature-panel").getBoundingClientRect().height;
    const top = Math.max(
      70,
      document.querySelector(".navbar").getBoundingClientRect().bottom + 8,
    );
    document.body.style.setProperty("--erase-sheet-height", `${height + 12}px`);
    document.body.style.setProperty("--erase-editor-top", `${top}px`);
    updateSigTransform();
  }
  if (typeof ResizeObserver !== "undefined")
    new ResizeObserver(positionSigEditor).observe($("signature-panel"));
  window.addEventListener("resize", positionSigEditor);
  function sigDarknessAlpha(darkness) {
    return 0.5 + (clampNum(darkness, 40, 100) / 100) * 0.5;
  }
  function getTintedSignature(session) {
    const key = session.ink;
    if (session.tintedCache[key]) return session.tintedCache[key];
    const source = session.image;
    const tinted = document.createElement("canvas");
    tinted.width = source.width;
    tinted.height = source.height;
    const ctx = tinted.getContext("2d");
    ctx.drawImage(source, 0, 0);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = SIG_INK_COLORS[key] || SIG_INK_COLORS.black;
    ctx.fillRect(0, 0, tinted.width, tinted.height);
    session.tintedCache[key] = tinted;
    return tinted;
  }
  function drawSignatureInto(ctx, session, box, forFinal) {
    const tinted = getTintedSignature(session);
    const cx = box.x + box.w / 2,
      cy = box.y + box.h / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(((session.rotate || 0) * Math.PI) / 180);
    ctx.globalAlpha = sigDarknessAlpha(session.darkness) * (forFinal ? 0.97 : 1);
    if (forFinal) ctx.globalCompositeOperation = "multiply";
    try {
      ctx.filter = "blur(0.45px)";
    } catch (e) {
      /* ignore */
    }
    ctx.drawImage(tinted, -box.w / 2, -box.h / 2, box.w, box.h);
    ctx.restore();
  }
  function renderSigPreview() {
    if (!signatureActive || !sigSession) return;
    const ctx = maskCanvas.getContext("2d");
    ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    drawSignatureInto(ctx, sigSession, sigSession.box, false);
    if (!sigSession.hideBox) drawTextBoxChrome(ctx, sigSession.box);
  }
  function requestSigRender() {
    if (sigFrame !== null) return;
    sigFrame = requestAnimationFrame(() => {
      sigFrame = null;
      renderSigPreview();
    });
  }
  function syncSigInkButtons() {
    document.querySelectorAll(".sig-ink-btn").forEach((button) => {
      const active = sigSession && button.dataset.ink === sigSession.ink;
      button.classList.toggle("active", !!active);
      button.setAttribute("aria-pressed", String(!!active));
    });
  }
  function defaultSigBox(image) {
    const W = maskCanvas.width,
      H = maskCanvas.height;
    const aspect = image.height / Math.max(1, image.width);
    const w = Math.min(Math.round(W * 0.38), 560);
    const h = Math.max(24, Math.round(w * aspect));
    return {
      x: clampNum(Math.round((W - w) / 2), 0, Math.max(0, W - w)),
      y: clampNum(Math.round(H * 0.62), 0, Math.max(0, H - h)),
      w,
      h,
    };
  }
  function startSigPlacement(cleanCanvas, reused = false) {
    const image = clone(cleanCanvas);
    const box = defaultSigBox(image);
    sigSession = {
      image,
      ink: savedSignature?.ink || "black",
      darkness: savedSignature?.darkness ?? 88,
      rotate: savedSignature?.rotate ?? 0,
      baseW: box.w,
      baseH: box.h,
      box,
      zoom: 1,
      panX: 0,
      panY: 0,
      pointers: new Map(),
      gesture: null,
      drag: null,
      hideBox: false,
      tintedCache: {},
    };
    $("sig-scale-slider").value = "100";
    $("sig-darkness-slider").value = String(sigSession.darkness);
    $("sig-rotate-slider").value = String(sigSession.rotate);
    syncSigInkButtons();
    $("btn-preview-sig-clean").setAttribute("aria-pressed", "false");
    $("btn-preview-sig-clean").textContent = "Hide box";
    $("sig-hint").textContent = reused
      ? "Reusing your saved signature. Drag to position, drag a corner to resize — or use “Draw / Scan / Upload” for a new one."
      : "Drag the signature to position it or drag a corner handle to resize. Blended into paper texture so it looks signed before scanning.";
    $("signature-panel").hidden = false;
    document.body.classList.add("sig-editing");
    requestAnimationFrame(() => {
      positionSigEditor();
      renderSigPreview();
    });
  }
  function closeSig() {
    if (!signatureActive) return;
    signatureActive = false;
    sigSession = null;
    if (sigFrame !== null) cancelAnimationFrame(sigFrame);
    sigFrame = null;
    document.body.classList.remove("sig-editing");
    $("signature-panel").hidden = true;
    surface.style.transform = "";
    maskCanvas.width = maskCanvas.height = 1;
    for (const dialog of [$("signature-source-modal"), $("signature-crop-modal")])
      if (dialog.open) dialog.close();
  }
  function applySignature() {
    if (!signatureActive || !sigSession || busy) return;
    const session = sigSession;
    const box = { ...session.box };
    rememberEdit();
    const ctx = finalCanvas.getContext("2d");
    drawSignatureInto(ctx, session, box, true);
    copy(finalCanvas, bufferCanvas);
    savedSignature = {
      canvas: clone(session.image),
      ink: session.ink,
      darkness: session.darkness,
      rotate: session.rotate,
    };
    currentFilter = "original";
    currentFilterSettings = FilterProcessor.defaults("original");
    syncFilters(currentFilter);
    markDirty();
    closeSig();
  }
  function openSignature() {
    if (
      busy ||
      saving ||
      eraseActive ||
      textActive ||
      signatureActive ||
      filterSession ||
      !finalCanvas.width ||
      !finalCanvas.height
    )
      return;
    signatureActive = true;
    maskCanvas.width = finalCanvas.width;
    maskCanvas.height = finalCanvas.height;
    if (savedSignature) {
      startSigPlacement(savedSignature.canvas, true);
    } else {
      sigSession = null;
      openSigSourceModal();
    }
  }
  $("btn-open-signature").addEventListener("click", openSignature);
  $("btn-cancel-signature").addEventListener("click", closeSig);
  $("btn-apply-signature").addEventListener("click", applySignature);
  $("btn-change-signature").addEventListener("click", () => {
    if (busy) return;
    openSigSourceModal();
  });
  $("btn-preview-sig-clean").addEventListener("click", () => {
    if (!sigSession || busy) return;
    sigSession.hideBox = !sigSession.hideBox;
    $("btn-preview-sig-clean").setAttribute("aria-pressed", String(sigSession.hideBox));
    $("btn-preview-sig-clean").textContent = sigSession.hideBox ? "Show box" : "Hide box";
    requestSigRender();
  });
  function zoomSig(value) {
    if (!sigSession || busy) return;
    sigSession.zoom = clampNum(value, 1, 4);
    updateSigTransform();
  }
  $("btn-sig-zoom-in").addEventListener("click", () => zoomSig((sigSession?.zoom || 1) + 0.25));
  $("btn-sig-zoom-out").addEventListener("click", () => zoomSig((sigSession?.zoom || 1) - 0.25));
  $("btn-sig-zoom-fit").addEventListener("click", () => {
    if (!sigSession || busy) return;
    sigSession.panX = sigSession.panY = 0;
    zoomSig(1);
  });
  document.querySelectorAll(".sig-ink-btn").forEach((button) => {
    button.addEventListener("click", () => {
      if (!sigSession || busy) return;
      sigSession.ink = button.dataset.ink || "black";
      syncSigInkButtons();
      requestSigRender();
    });
  });
  $("sig-scale-slider").addEventListener("input", () => {
    if (!sigSession || busy) return;
    const scale = Number($("sig-scale-slider").value) || 100;
    const box = sigSession.box;
    const cx = box.x + box.w / 2,
      cy = box.y + box.h / 2;
    box.w = clampNum(Math.round(sigSession.baseW * (scale / 100)), 30, maskCanvas.width);
    box.h = clampNum(Math.round(sigSession.baseH * (scale / 100)), 16, maskCanvas.height);
    box.x = clampNum(Math.round(cx - box.w / 2), 0, Math.max(0, maskCanvas.width - box.w));
    box.y = clampNum(Math.round(cy - box.h / 2), 0, Math.max(0, maskCanvas.height - box.h));
    requestSigRender();
  });
  $("sig-darkness-slider").addEventListener("input", () => {
    if (!sigSession || busy) return;
    sigSession.darkness = Number($("sig-darkness-slider").value) || 88;
    requestSigRender();
  });
  $("sig-rotate-slider").addEventListener("input", () => {
    if (!sigSession || busy) return;
    sigSession.rotate = Number($("sig-rotate-slider").value) || 0;
    requestSigRender();
  });
  $("btn-reset-sig-transform").addEventListener("click", () => {
    if (!sigSession || busy) return;
    sigSession.darkness = 88;
    sigSession.rotate = 0;
    $("sig-darkness-slider").value = "88";
    $("sig-rotate-slider").value = "0";
    $("sig-scale-slider").value = "100";
    sigSession.box = defaultSigBox(sigSession.image);
    sigSession.baseW = sigSession.box.w;
    sigSession.baseH = sigSession.box.h;
    requestSigRender();
  });
  function sigPinchMetrics() {
    const [a, b] = [...sigSession.pointers.values()];
    return {
      distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
    };
  }
  editorStage.addEventListener("pointerdown", (event) => {
    if (!signatureActive || !sigSession || busy || event.button !== 0) return;
    event.preventDefault();
    const session = sigSession;
    session.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    editorStage.setPointerCapture(event.pointerId);
    if (session.pointers.size >= 2) {
      session.drag = null;
      if (!session.gesture)
        session.gesture = {
          ...sigPinchMetrics(),
          zoom: session.zoom,
          panX: session.panX,
          panY: session.panY,
        };
      requestSigRender();
      return;
    }
    if (session.gesture) return;
    const point = maskPoint(event);
    const box = session.box;
    const corner = textCornerAt(point, box);
    const inside =
      point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h;
    if (corner) session.drag = { mode: "resize", corner, start: point, orig: { ...box } };
    else if (inside) session.drag = { mode: "move", start: point, orig: { ...box } };
    else
      session.drag = {
        mode: "pan",
        start: { x: event.clientX, y: event.clientY },
        panX: session.panX,
        panY: session.panY,
        orig: { ...box },
      };
    requestSigRender();
  });
  editorStage.addEventListener("pointermove", (event) => {
    if (!signatureActive || !sigSession || busy || !sigSession.pointers.has(event.pointerId)) return;
    const session = sigSession;
    session.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (session.gesture) {
      if (session.pointers.size < 2) return;
      const metric = sigPinchMetrics(),
        origin = session.gesture;
      session.zoom = clampNum((origin.zoom * metric.distance) / origin.distance, 1, 4);
      session.panX = origin.panX + metric.x - origin.x;
      session.panY = origin.panY + metric.y - origin.y;
      updateSigTransform();
      return;
    }
    const drag = session.drag;
    if (!drag) return;
    const point = maskPoint(event);
    const box = session.box;
    if (drag.mode === "move") {
      box.x = clampNum(drag.orig.x + point.x - drag.start.x, 0, Math.max(0, maskCanvas.width - box.w));
      box.y = clampNum(drag.orig.y + point.y - drag.start.y, 0, Math.max(0, maskCanvas.height - box.h));
    } else if (drag.mode === "resize") {
      const orig = drag.orig;
      const oldDiag = Math.max(1, Math.hypot(orig.w, orig.h));
      const newDiag = Math.hypot(point.x - (orig.x + orig.w / 2), point.y - (orig.y + orig.h / 2)) * 2;
      const factor = clampNum(newDiag / oldDiag, 0.15, 4);
      const cx = orig.x + orig.w / 2,
        cy = orig.y + orig.h / 2;
      box.w = clampNum(Math.round(orig.w * factor), 30, maskCanvas.width);
      box.h = clampNum(Math.round(orig.h * factor), 16, maskCanvas.height);
      box.x = clampNum(Math.round(cx - box.w / 2), 0, Math.max(0, maskCanvas.width - box.w));
      box.y = clampNum(Math.round(cy - box.h / 2), 0, Math.max(0, maskCanvas.height - box.h));
      $("sig-scale-slider").value = String(
        clampNum(Math.round((box.w / Math.max(1, session.baseW)) * 100), 15, 250),
      );
    } else if (drag.mode === "pan") {
      const dx = event.clientX - drag.start.x,
        dy = event.clientY - drag.start.y;
      if (session.zoom > 1) {
        session.panX = drag.panX + dx;
        session.panY = drag.panY + dy;
        updateSigTransform();
      } else {
        const rect = maskCanvas.getBoundingClientRect();
        const sx = maskCanvas.width / Math.max(1, rect.width),
          sy = maskCanvas.height / Math.max(1, rect.height);
        box.x = clampNum(drag.orig.x + dx * sx, 0, Math.max(0, maskCanvas.width - box.w));
        box.y = clampNum(drag.orig.y + dy * sy, 0, Math.max(0, maskCanvas.height - box.h));
      }
    }
    requestSigRender();
  });
  function endSigPointer(event) {
    if (!signatureActive || !sigSession?.pointers.has(event.pointerId)) return;
    const session = sigSession;
    if (event.type === "pointerup") session.drag = null;
    session.pointers.delete(event.pointerId);
    if (!session.pointers.size) session.gesture = null;
    if (editorStage.hasPointerCapture(event.pointerId))
      editorStage.releasePointerCapture(event.pointerId);
    requestSigRender();
  }
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((type) =>
    editorStage.addEventListener(type, endSigPointer),
  );
  editorStage.addEventListener(
    "wheel",
    (event) => {
      if (!signatureActive || !sigSession || !event.ctrlKey) return;
      event.preventDefault();
      zoomSig(sigSession.zoom + (event.deltaY < 0 ? 0.15 : -0.15));
    },
    { passive: false },
  );
  // Signature source modal: drawpad.
  function sigPadPoint(event) {
    const pad = $("sig-draw-canvas");
    const rect = pad.getBoundingClientRect();
    return {
      x: clampNum(((event.clientX - rect.left) * pad.width) / Math.max(1, rect.width), 0, pad.width),
      y: clampNum(((event.clientY - rect.top) * pad.height) / Math.max(1, rect.height), 0, pad.height),
    };
  }
  function redrawSigPad() {
    const pad = $("sig-draw-canvas");
    const ctx = pad.getContext("2d");
    ctx.clearRect(0, 0, pad.width, pad.height);
    ctx.strokeStyle = "#1f2430";
    ctx.lineCap = ctx.lineJoin = "round";
    for (const stroke of sigDrawStrokes) {
      if (!stroke.points.length) continue;
      ctx.lineWidth = stroke.width;
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let i = 1; i < stroke.points.length; i++)
        ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      ctx.stroke();
    }
    if (sigDrawCurrent && sigDrawCurrent.points.length) {
      ctx.lineWidth = sigDrawCurrent.width;
      ctx.beginPath();
      ctx.moveTo(sigDrawCurrent.points[0].x, sigDrawCurrent.points[0].y);
      for (let i = 1; i < sigDrawCurrent.points.length; i++)
        ctx.lineTo(sigDrawCurrent.points[i].x, sigDrawCurrent.points[i].y);
      ctx.stroke();
    }
    $("btn-sig-use-drawn").disabled = !sigDrawStrokes.length;
  }
  function openSigSourceModal() {
    sigDrawStrokes = [];
    sigDrawCurrent = null;
    redrawSigPad();
    const dialog = $("signature-source-modal");
    if (!dialog.open) dialog.showModal();
  }
  // A dialog closing on its own (X, Esc) aborts the flow; closing it to hand
  // over to the next dialog must not.
  function closeSigDialog(dialog) {
    if (!dialog.open) return;
    sigAdvancing = true;
    dialog.close();
  }
  $("sig-source-close").addEventListener("click", () => $("signature-source-modal").close());
  $("signature-source-modal").addEventListener("close", () => {
    if (sigAdvancing) {
      sigAdvancing = false;
      return;
    }
    if (signatureActive && !sigSession) closeSig();
  });
  $("sig-draw-canvas").addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const pad = $("sig-draw-canvas");
    pad.setPointerCapture(event.pointerId);
    sigDrawCurrent = {
      width: Number($("sig-pen-width").value) || 3,
      points: [sigPadPoint(event)],
    };
    redrawSigPad();
  });
  $("sig-draw-canvas").addEventListener("pointermove", (event) => {
    if (!sigDrawCurrent) return;
    const samples =
      typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    for (const sample of samples.length ? samples : [event]) {
      const point = sigPadPoint(sample);
      const points = sigDrawCurrent.points;
      const prev = points[points.length - 1];
      if (Math.hypot(point.x - prev.x, point.y - prev.y) >= 1.5) points.push(point);
    }
    redrawSigPad();
  });
  function endSigPadStroke(event) {
    if (!sigDrawCurrent) return;
    if (event.type === "pointerup" && sigDrawCurrent.points.length >= 2)
      sigDrawStrokes.push(sigDrawCurrent);
    sigDrawCurrent = null;
    redrawSigPad();
  }
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((type) =>
    $("sig-draw-canvas").addEventListener(type, endSigPadStroke),
  );
  $("btn-sig-draw-undo").addEventListener("click", () => {
    sigDrawStrokes.pop();
    redrawSigPad();
  });
  $("btn-sig-draw-clear").addEventListener("click", () => {
    sigDrawStrokes = [];
    sigDrawCurrent = null;
    redrawSigPad();
  });
  function inkBoundsFromAlpha(source, alphaThreshold = 10) {
    const w = source.width,
      h = source.height;
    const ctx = source.getContext("2d", { willReadFrequently: true });
    const data = ctx.getImageData(0, 0, w, h).data;
    let minX = w,
      minY = h,
      maxX = -1,
      maxY = -1;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > alphaThreshold) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    if (maxX < 0) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }
  $("btn-sig-use-drawn").addEventListener("click", () => {
    const pad = $("sig-draw-canvas");
    const bounds = inkBoundsFromAlpha(pad, 10);
    if (!bounds) return;
    const padPx = 10;
    const x = clampNum(bounds.x - padPx, 0, pad.width - 1);
    const y = clampNum(bounds.y - padPx, 0, pad.height - 1);
    const w = Math.min(bounds.w + padPx * 2, pad.width - x);
    const h = Math.min(bounds.h + padPx * 2, pad.height - y);
    const clean = document.createElement("canvas");
    clean.width = Math.max(2, w);
    clean.height = Math.max(2, h);
    clean.getContext("2d").drawImage(pad, x, y, w, h, 0, 0, clean.width, clean.height);
    savedSignature = { canvas: clone(clean), ink: "black", darkness: 88, rotate: 0 };
    startSigPlacement(clean);
    closeSigDialog($("signature-source-modal"));
  });
  $("btn-sig-scan").addEventListener("click", () => $("sig-scan-input").click());
  $("btn-sig-upload").addEventListener("click", () => $("sig-upload-input").click());
  async function handleSigFile(input) {
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    try {
      const dataUrl = await readFile(file);
      const image = await loadImage(dataUrl);
      openSigCrop(image);
    } catch (error) {
      fail("Could not load that signature image.", error);
    }
  }
  $("sig-scan-input").addEventListener("change", (event) => handleSigFile(event.target));
  $("sig-upload-input").addEventListener("change", (event) => handleSigFile(event.target));
  // Signature B&W conversion + crop popup + background removal.
  function convertSignatureToBw(source, threshold) {
    const srcW = source.naturalWidth || source.width,
      srcH = source.naturalHeight || source.height;
    const scale = Math.min(1, 1600 / Math.max(srcW, srcH));
    const w = Math.max(2, Math.round(srcW * scale)),
      h = Math.max(2, Math.round(srcH * scale));
    const work = document.createElement("canvas");
    work.width = w;
    work.height = h;
    const wctx = work.getContext("2d", { willReadFrequently: true });
    wctx.fillStyle = "#ffffff";
    wctx.fillRect(0, 0, w, h);
    wctx.drawImage(source, 0, 0, w, h);
    const imageData = wctx.getImageData(0, 0, w, h);
    const data = imageData.data;
    // Coarse illumination field from a heavily downscaled copy.
    const smallW = Math.max(2, Math.min(96, Math.round(w / 12)));
    const smallH = Math.max(2, Math.min(96, Math.round(h / 12)));
    const small = document.createElement("canvas");
    small.width = smallW;
    small.height = smallH;
    const sctx = small.getContext("2d", { willReadFrequently: true });
    sctx.drawImage(work, 0, 0, smallW, smallH);
    const smallData = sctx.getImageData(0, 0, smallW, smallH).data;
    const bg = new Float32Array(smallW * smallH);
    for (let i = 0; i < smallW * smallH; i++) {
      const o = i * 4;
      bg[i] = 0.2126 * smallData[o] + 0.7152 * smallData[o + 1] + 0.0722 * smallData[o + 2];
    }
    const cutoff = clampNum(Number(threshold) || 55, 10, 90);
    for (let y = 0; y < h; y++) {
      const fy = clampNum(((y + 0.5) * smallH) / h - 0.5, 0, smallH - 1);
      const y0 = Math.floor(fy),
        y1 = Math.min(y0 + 1, smallH - 1),
        wy = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = clampNum(((x + 0.5) * smallW) / w - 0.5, 0, smallW - 1);
        const x0 = Math.floor(fx),
          x1 = Math.min(x0 + 1, smallW - 1),
          wx = fx - x0;
        const paper =
          bg[y0 * smallW + x0] * (1 - wx) * (1 - wy) +
          bg[y0 * smallW + x1] * wx * (1 - wy) +
          bg[y1 * smallW + x0] * (1 - wx) * wy +
          bg[y1 * smallW + x1] * wx * wy;
        const o = (y * w + x) * 4;
        const lum = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
        const darkness = paper - lum;
        const gray =
          darkness <= cutoff ? 255 : Math.max(0, Math.round(255 - (darkness - cutoff) * 2.2));
        data[o] = data[o + 1] = data[o + 2] = gray;
        data[o + 3] = 255;
      }
    }
    wctx.putImageData(imageData, 0, 0);
    return work;
  }
  function findInkBounds(bwCanvas, grayThreshold = 200) {
    const w = bwCanvas.width,
      h = bwCanvas.height;
    const data = bwCanvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    let minX = w,
      minY = h,
      maxX = -1,
      maxY = -1;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4] < grayThreshold) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    if (maxX < 0) return null;
    const pad = 10;
    return {
      x: clampNum(minX - pad, 0, w - 1),
      y: clampNum(minY - pad, 0, h - 1),
      w: Math.min(maxX - minX + 1 + pad * 2, w - clampNum(minX - pad, 0, w - 1)),
      h: Math.min(maxY - minY + 1 + pad * 2, h - clampNum(minY - pad, 0, h - 1)),
    };
  }
  function cleanSignatureFromBw(bwCanvas, crop) {
    const clean = document.createElement("canvas");
    clean.width = Math.max(2, Math.round(crop.w));
    clean.height = Math.max(2, Math.round(crop.h));
    const ctx = clean.getContext("2d");
    const srcCtx = bwCanvas.getContext("2d", { willReadFrequently: true });
    const srcData = srcCtx.getImageData(
      Math.round(crop.x),
      Math.round(crop.y),
      clean.width,
      clean.height,
    ).data;
    const out = ctx.createImageData(clean.width, clean.height);
    for (let i = 0; i < clean.width * clean.height; i++) {
      const gray = srcData[i * 4];
      let alpha = Math.round((255 - gray) * 1.35);
      if (alpha < 12) alpha = 0;
      out.data[i * 4] = 0;
      out.data[i * 4 + 1] = 0;
      out.data[i * 4 + 2] = 0;
      out.data[i * 4 + 3] = clampNum(alpha, 0, 255);
    }
    ctx.putImageData(out, 0, 0);
    return clean;
  }
  function updateSigCropBoxUI() {
    if (!sigBwCanvas || !sigCropBox) return;
    const box = $("sig-crop-box");
    box.style.left = `${(sigCropBox.x / sigBwCanvas.width) * 100}%`;
    box.style.top = `${(sigCropBox.y / sigBwCanvas.height) * 100}%`;
    box.style.width = `${(sigCropBox.w / sigBwCanvas.width) * 100}%`;
    box.style.height = `${(sigCropBox.h / sigBwCanvas.height) * 100}%`;
  }
  function updateSigCleanPreview() {
    if (!sigBwCanvas || !sigCropBox) return;
    const clean = cleanSignatureFromBw(sigBwCanvas, sigCropBox);
    const preview = $("sig-clean-preview-canvas");
    const scale = Math.min(1, 600 / Math.max(clean.width, clean.height));
    preview.width = Math.max(2, Math.round(clean.width * scale));
    preview.height = Math.max(2, Math.round(clean.height * scale));
    preview.getContext("2d").drawImage(clean, 0, 0, preview.width, preview.height);
    clean.width = clean.height = 1;
  }
  function refreshSigBw() {
    if (!sigSourceImage) return;
    const threshold = Number($("sig-bw-threshold").value) || 55;
    $("sig-bw-threshold-val").textContent = `${threshold}%`;
    sigBwCanvas = convertSignatureToBw(sigSourceImage, threshold);
    const canvas = $("sig-crop-canvas");
    canvas.width = sigBwCanvas.width;
    canvas.height = sigBwCanvas.height;
    canvas.getContext("2d").drawImage(sigBwCanvas, 0, 0);
    if (sigCropBox) {
      sigCropBox.x = clampNum(sigCropBox.x, 0, sigBwCanvas.width - 10);
      sigCropBox.y = clampNum(sigCropBox.y, 0, sigBwCanvas.height - 10);
      sigCropBox.w = clampNum(sigCropBox.w, 20, sigBwCanvas.width - sigCropBox.x);
      sigCropBox.h = clampNum(sigCropBox.h, 20, sigBwCanvas.height - sigCropBox.y);
    }
    updateSigCropBoxUI();
    updateSigCleanPreview();
  }
  function openSigCrop(image) {
    sigSourceImage = image;
    sigCropConfirmed = false;
    closeSigDialog($("signature-source-modal"));
    refreshSigBw();
    sigCropBox = findInkBounds(sigBwCanvas) || {
      x: 0,
      y: 0,
      w: sigBwCanvas.width,
      h: sigBwCanvas.height,
    };
    updateSigCropBoxUI();
    updateSigCleanPreview();
    const dialog = $("signature-crop-modal");
    if (!dialog.open) dialog.showModal();
  }
  $("sig-crop-close").addEventListener("click", () => $("signature-crop-modal").close());
  $("signature-crop-modal").addEventListener("close", () => {
    if (sigAdvancing) {
      sigAdvancing = false;
      return;
    }
    if (sigCropConfirmed) return;
    if (signatureActive && !sigSession) openSigSourceModal();
  });
  $("btn-sig-crop-back").addEventListener("click", () => {
    $("signature-crop-modal").close();
  });
  $("btn-sig-crop-autofit").addEventListener("click", () => {
    if (!sigBwCanvas) return;
    sigCropBox = findInkBounds(sigBwCanvas) || sigCropBox;
    updateSigCropBoxUI();
    updateSigCleanPreview();
  });
  $("btn-sig-crop-full").addEventListener("click", () => {
    if (!sigBwCanvas) return;
    sigCropBox = { x: 0, y: 0, w: sigBwCanvas.width, h: sigBwCanvas.height };
    updateSigCropBoxUI();
    updateSigCleanPreview();
  });
  $("sig-bw-threshold").addEventListener("input", refreshSigBw);
  $("btn-sig-crop-confirm").addEventListener("click", () => {
    if (!sigBwCanvas || !sigCropBox) return;
    const clean = cleanSignatureFromBw(sigBwCanvas, sigCropBox);
    if (!inkBoundsFromAlpha(clean, 12)) {
      notice("No signature ink found in the crop. Adjust the crop or B&W contrast.", true);
      clean.width = clean.height = 1;
      return;
    }
    savedSignature = { canvas: clone(clean), ink: "black", darkness: 88, rotate: 0 };
    sigCropConfirmed = true;
    startSigPlacement(clean);
    closeSigDialog($("signature-crop-modal"));
  });
  function sigCropPoint(event) {
    const canvas = $("sig-crop-canvas");
    const rect = canvas.getBoundingClientRect();
    return {
      x: clampNum(((event.clientX - rect.left) * canvas.width) / Math.max(1, rect.width), 0, canvas.width),
      y: clampNum(((event.clientY - rect.top) * canvas.height) / Math.max(1, rect.height), 0, canvas.height),
    };
  }
  $("sig-crop-box").addEventListener("pointerdown", (event) => {
    if (!sigCropBox || !sigBwCanvas) return;
    event.preventDefault();
    const box = $("sig-crop-box");
    box.setPointerCapture(event.pointerId);
    const corner = event.target.dataset?.corner || null;
    sigCropDrag = {
      mode: corner ? "resize" : "move",
      corner,
      start: sigCropPoint(event),
      orig: { ...sigCropBox },
    };
  });
  $("sig-crop-box").addEventListener("pointermove", (event) => {
    if (!sigCropDrag || !sigCropBox || !sigBwCanvas) return;
    const point = sigCropPoint(event);
    const dx = point.x - sigCropDrag.start.x,
      dy = point.y - sigCropDrag.start.y;
    const orig = sigCropDrag.orig;
    const W = sigBwCanvas.width,
      H = sigBwCanvas.height;
    if (sigCropDrag.mode === "move") {
      sigCropBox.x = clampNum(orig.x + dx, 0, W - orig.w);
      sigCropBox.y = clampNum(orig.y + dy, 0, H - orig.h);
    } else {
      let { x, y, w, h } = orig;
      if (sigCropDrag.corner === "br") {
        w = orig.w + dx;
        h = orig.h + dy;
      } else if (sigCropDrag.corner === "tr") {
        w = orig.w + dx;
        h = orig.h - dy;
        y = orig.y + dy;
      } else if (sigCropDrag.corner === "bl") {
        w = orig.w - dx;
        h = orig.h + dy;
        x = orig.x + dx;
      } else {
        w = orig.w - dx;
        h = orig.h - dy;
        x = orig.x + dx;
        y = orig.y + dy;
      }
      w = clampNum(w, 20, W);
      h = clampNum(h, 20, H);
      if (sigCropDrag.corner === "tl" || sigCropDrag.corner === "bl") x = orig.x + orig.w - w;
      if (sigCropDrag.corner === "tl" || sigCropDrag.corner === "tr") y = orig.y + orig.h - h;
      sigCropBox.x = clampNum(x, 0, W - w);
      sigCropBox.y = clampNum(y, 0, H - h);
      sigCropBox.w = w;
      sigCropBox.h = h;
    }
    updateSigCropBoxUI();
    updateSigCleanPreview();
  });
  function endSigCropDrag(event) {
    if (!sigCropDrag) return;
    sigCropDrag = null;
    if ($("sig-crop-box").hasPointerCapture(event.pointerId))
      $("sig-crop-box").releasePointerCapture(event.pointerId);
  }
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((type) =>
    $("sig-crop-box").addEventListener(type, endSigCropDrag),
  );
  // Shared Escape handling for the two new editors (dialogs handle their own).
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const tag = String(event.target?.tagName || "").toLowerCase();
    if (["textarea", "input", "select"].includes(tag)) return;
    if ($("signature-source-modal").open || $("signature-crop-modal").open) return;
    if (textActive && !busy) {
      event.preventDefault();
      closeText();
    } else if (signatureActive && !busy) {
      event.preventDefault();
      closeSig();
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
    if (busy || saving || eraseActive || textActive || signatureActive) return;
    try {
      const existing = documentPages.find((page) => page.id === activePageId);
      const page = {
        stage1Version: 1,
        stage2Version: 1,
        stage3Version: 1,
        stage32Version: 1,
        ...(currentSourceIsPdf || existing?.fromPdf ? { fromPdf: true } : {}),
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
      currentSourceIsPdf = !!page.fromPdf;
      recropReturnView = null;
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
      (dirty ||
        !storageAvailable ||
        (eraseActive && eraseCommands().length) ||
        (textActive && textSession?.text?.trim()) ||
        signatureActive) &&
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
      (eraseActive && eraseCommands().length) ||
      (textActive && textSession?.text?.trim()) ||
      signatureActive
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
      busy ||
      saving ||
      eraseActive ||
      textActive ||
      signatureActive ||
      filterSession ||
      shareSession ||
      drawing
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
