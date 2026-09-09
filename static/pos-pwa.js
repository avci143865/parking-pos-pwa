(function parkingPosPwa(global) {
  const KEYS = {
    autoCamera: "parking.pos.autoCamera",
    // v2: الطباعة اليدوية هي الافتراضي — المستخدم يضغط زر الطباعة بنفسه.
    autoPrint: "parking.pos.autoPrint.v2",
    paperWidth: "parking.pos.paperWidth",
    hardwareScan: "parking.pos.hardwareScan",
    blePrinterId: "parking.pos.blePrinterId",
  };

  const BLE_CHUNK = 180;
  const ASSET = "20260910-8";

  const state = {
    deferredInstall: null,
    wantCameraResume: false,
    scanningBusy: false,
    lastScanToken: "",
    lastScanAt: 0,
    wedgeBuf: "",
    wedgeAt: 0,
    nativeStream: null,
    nativeRaf: 0,
    nativeVideo: null,
    wakeLock: null,
    bleDevice: null,
    bleChar: null,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function readBool(key, fallback) {
    const v = localStorage.getItem(key);
    if (v == null) return fallback;
    return v === "1" || v === "true";
  }

  function writeBool(key, value) {
    localStorage.setItem(key, value ? "1" : "0");
  }

  function getSettings() {
    const paper = localStorage.getItem(KEYS.paperWidth) === "58" ? "58" : "80";
    return {
      autoCamera: readBool(KEYS.autoCamera, true),
      autoPrint: readBool(KEYS.autoPrint, false),
      hardwareScan: readBool(KEYS.hardwareScan, true),
      paperWidth: paper,
    };
  }

  function applyPaperClass() {
    const paper = getSettings().paperWidth;
    document.documentElement.classList.toggle("print-width-58", paper === "58");
    document.documentElement.classList.toggle("print-width-80", paper !== "58");
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    const run = () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
    };
    // تسجيل مبكر (لا انتظار تحميل الصفحة كاملة) ليتعرف عليه PWABuilder والمتصفح فورًا.
    if (document.readyState === "complete" || document.readyState === "interactive") run();
    else document.addEventListener("DOMContentLoaded", run);
  }

  function installButtons() {
    return [$("pos-install-btn"), $("pos-install-btn-login")].filter(Boolean);
  }

  function showInstall(show) {
    installButtons().forEach((btn) => btn.classList.toggle("hidden", !show));
  }

  function wireInstall() {
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      state.deferredInstall = e;
      showInstall(true);
    });
    window.addEventListener("appinstalled", () => {
      state.deferredInstall = null;
      showInstall(false);
    });
    installButtons().forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (state.deferredInstall) {
          state.deferredInstall.prompt();
          await state.deferredInstall.userChoice.catch(() => {});
          state.deferredInstall = null;
          showInstall(false);
          return;
        }
        // Fallback for iOS Safari / browsers without beforeinstallprompt.
        const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent || "");
        alert(
          isIos
            ? "للتثبيت على iPhone: افتح بمتصفح Safari ثم مشاركة ← إضافة إلى الشاشة الرئيسية."
            : "للتثبيت: من قائمة المتصفح اختر تثبيت التطبيق / إضافة إلى الشاشة الرئيسية."
        );
      });
    });
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true;
    if (standalone) {
      showInstall(false);
    } else if (!state.deferredInstall) {
      // Show install buttons anyway so POS staff can discover manual install steps.
      // They stay visible until appinstalled; click shows guidance when no prompt is available.
      showInstall(true);
    }
  }

  function updateSecureHint() {
    const el = $("pos-secure-hint");
    if (!el) return;
    const ok = window.isSecureContext || location.hostname === "localhost" || location.hostname === "127.0.0.1";
    el.classList.toggle("hidden", ok);
  }

  function setPrinterStatus(text) {
    const el = $("pos-printer-status");
    if (el) el.textContent = text || "";
  }

  function syncPosControls() {
    const s = getSettings();
    const cam = $("pos-auto-camera");
    const print = $("pos-auto-print");
    const hw = $("pos-hardware-scan");
    const paper = $("pos-paper-width");
    if (cam) cam.checked = s.autoCamera;
    if (print) print.checked = s.autoPrint;
    if (hw) hw.checked = s.hardwareScan;
    if (paper) paper.value = s.paperWidth;
    applyPaperClass();
    updateSecureHint();
    if (state.bleDevice) {
      setPrinterStatus("طابعة بلوتوث: " + (state.bleDevice.name || "متصلة"));
    } else if (getNativePrinter()) {
      setPrinterStatus("طابعة الجهاز الداخلية جاهزة");
    } else {
      setPrinterStatus("الطباعة عبر نافذة النظام أو بلوتوث");
    }
  }

  function wireSettings() {
    $("pos-auto-camera")?.addEventListener("change", (e) => {
      writeBool(KEYS.autoCamera, e.target.checked);
    });
    $("pos-auto-print")?.addEventListener("change", (e) => {
      writeBool(KEYS.autoPrint, e.target.checked);
    });
    $("pos-hardware-scan")?.addEventListener("change", (e) => {
      writeBool(KEYS.hardwareScan, e.target.checked);
    });
    $("pos-paper-width")?.addEventListener("change", (e) => {
      localStorage.setItem(KEYS.paperWidth, e.target.value === "58" ? "58" : "80");
      applyPaperClass();
    });
    $("pos-pair-printer")?.addEventListener("click", () => {
      pairBlePrinter().catch((err) => {
        setPrinterStatus(err.message || "تعذّر ربط الطابعة");
      });
    });
  }

  function looksLikeVehicleToken(raw) {
    const s = String(raw || "").trim();
    if (!s) return false;
    if (/scan=/i.test(s)) return true;
    if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(s)) {
      return true;
    }
    return s.length >= 20 && /^[0-9A-Za-z._~-]+$/.test(s);
  }

  function isSensitiveField(el) {
    if (!el || !el.tagName) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      return ["password", "email", "number", "search", "tel", "url", "text"].includes(t);
    }
    return false;
  }

  function shouldIgnoreWedgeTarget(el) {
    if (!el) return false;
    const id = el.id || "";
    if (id === "login-pass" || id === "login-user") return true;
    if (id === "admin-pw-new" || id === "admin-rename-new") return true;
    if (id === "admin-wipe-confirm") return true;
    if (id === "notes") return true;
    return false;
  }

  function handleDecodedScan(raw) {
    const token = String(raw || "").trim();
    if (!token) return;
    const now = Date.now();
    if (token === state.lastScanToken && now - state.lastScanAt < 2500) return;
    if (state.scanningBusy) return;
    state.lastScanToken = token;
    state.lastScanAt = now;
    if (typeof navigator.vibrate === "function") {
      try {
        navigator.vibrate(35);
      } catch {
        /* ignore */
      }
    }
    if (typeof global.processVehicleScan === "function") {
      state.scanningBusy = true;
      Promise.resolve(global.processVehicleScan(token))
        .catch(() => {})
        .finally(() => {
          state.scanningBusy = false;
        });
    }
  }

  function onWedgeKeydown(e) {
    if (!getSettings().hardwareScan) return;
    if (e.isComposing) return;
    if (shouldIgnoreWedgeTarget(e.target)) return;

    const now = Date.now();
    if (now - state.wedgeAt > 140) state.wedgeBuf = "";
    const burst = state.wedgeBuf.length > 0 && now - state.wedgeAt < 80;
    state.wedgeAt = now;

    if (e.key === "Enter") {
      const buf = state.wedgeBuf.trim();
      state.wedgeBuf = "";
      if (buf.length >= 8 && looksLikeVehicleToken(buf)) {
        e.preventDefault();
        handleDecodedScan(buf);
      }
      return;
    }

    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const fastDump = burst || !isSensitiveField(e.target);
      if (!fastDump && isSensitiveField(e.target)) return;
      if (burst) e.preventDefault();
      state.wedgeBuf += e.key;
      if (state.wedgeBuf.length > 512) state.wedgeBuf = state.wedgeBuf.slice(-256);
    }
  }

  function wireHardwareScanner() {
    document.addEventListener("keydown", onWedgeKeydown, true);
  }

  function anyModalOpen() {
    return document.body.classList.contains("modal-open");
  }

  function markWantResume() {
    if (global.__parkingQrActive) state.wantCameraResume = true;
  }

  function setWantResume(value) {
    state.wantCameraResume = !!value;
  }

  let resumeTimer = 0;

  async function maybeResumeCamera() {
    window.clearTimeout(resumeTimer);
    resumeTimer = window.setTimeout(async () => {
      if (!state.wantCameraResume) return;
      if (anyModalOpen()) return;
      if (typeof global.startVehicleQrScanner !== "function") return;
      try {
        await global.startVehicleQrScanner();
      } catch {
        /* keep start button visible */
      }
    }, 160);
  }

  async function tryAutoStartCamera() {
    if (!getSettings().autoCamera) return;
    if (typeof global.startVehicleQrScanner !== "function") return;
    try {
      await global.startVehicleQrScanner();
      state.wantCameraResume = true;
    } catch {
      state.wantCameraResume = false;
    }
  }

  async function requestWakeLock() {
    try {
      if (!navigator.wakeLock) return;
      state.wakeLock = await navigator.wakeLock.request("screen");
      state.wakeLock.addEventListener("release", () => {
        state.wakeLock = null;
      });
    } catch {
      state.wakeLock = null;
    }
  }

  function releaseWakeLock() {
    const lock = state.wakeLock;
    state.wakeLock = null;
    if (lock) lock.release().catch(() => {});
  }

  function stopNativeCamera() {
    if (state.nativeRaf) {
      cancelAnimationFrame(state.nativeRaf);
      state.nativeRaf = 0;
    }
    if (state.nativeStream) {
      state.nativeStream.getTracks().forEach((t) => t.stop());
      state.nativeStream = null;
    }
    state.nativeVideo = null;
    releaseWakeLock();
  }

  function cameraConstraints() {
    const cameraId = ($("vehicle-qr-camera")?.value || "").trim();
    if (cameraId) {
      return {
        audio: false,
        video: {
          deviceId: { exact: cameraId },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      };
    }
    return {
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    };
  }

  function nativeDetectorAvailable() {
    return typeof global.BarcodeDetector === "function";
  }

  async function startNativeCameraScan(hostId) {
    if (!nativeDetectorAvailable()) throw new Error("no-barcode-detector");
    const host = $(hostId);
    if (!host) throw new Error("missing-host");
    stopNativeCamera();
    host.innerHTML = "";
    const video = document.createElement("video");
    video.setAttribute("playsinline", "true");
    video.setAttribute("muted", "true");
    video.autoplay = true;
    video.style.width = "100%";
    video.style.height = "100%";
    video.style.objectFit = "cover";
    host.appendChild(video);

    const stream = await navigator.mediaDevices.getUserMedia(cameraConstraints());
    state.nativeStream = stream;
    state.nativeVideo = video;
    video.srcObject = stream;
    await video.play();
    await requestWakeLock();

    const detector = new global.BarcodeDetector({ formats: ["qr_code"] });
    const tick = async () => {
      if (!state.nativeStream) return;
      try {
        if (video.readyState >= 2) {
          const codes = await detector.detect(video);
          const text = String(codes?.[0]?.rawValue || "").trim();
          if (text) handleDecodedScan(text);
        }
      } catch {
        /* keep looping */
      }
      state.nativeRaf = requestAnimationFrame(tick);
    };
    state.nativeRaf = requestAnimationFrame(tick);
  }

  function slipRoot(mode) {
    return mode === "checkout" ? $("checkout-invoice-slip") : $("receipt-slip");
  }

  function slipText(rootId) {
    const root = $(rootId);
    if (!root) return "";
    return (root.innerText || root.textContent || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join("\n");
  }

  function getNativePrinter() {
    const n = window.navigator || {};
    if (n.sunmiInnerPrinter) return { kind: "sunmi", api: n.sunmiInnerPrinter };
    if (window.sunmiInnerPrinter) return { kind: "sunmi", api: window.sunmiInnerPrinter };
    if (window.SunmiInnerPrinter) return { kind: "sunmi", api: window.SunmiInnerPrinter };
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.printer) {
      return { kind: "webkit", api: window.webkit.messageHandlers.printer };
    }
    if (window.Android && typeof window.Android.printText === "function") {
      return { kind: "android", api: window.Android };
    }
    if (window.Android && typeof window.Android.print === "function") {
      return { kind: "android-print", api: window.Android };
    }
    if (window.IminPrinter && typeof window.IminPrinter.printText === "function") {
      return { kind: "imin", api: window.IminPrinter };
    }
    return null;
  }

  function tryNativePrint(mode) {
    const printer = getNativePrinter();
    if (!printer) return false;
    const text =
      mode === "checkout" ? slipText("checkout-invoice-slip") : slipText("receipt-slip");
    if (!text) return false;
    try {
      if (printer.kind === "sunmi") {
        const p = printer.api;
        if (typeof p.printerInit === "function") p.printerInit();
        if (typeof p.printString === "function") p.printString(text + "\n\n");
        else if (typeof p.printText === "function") p.printText(text + "\n\n");
        if (typeof p.lineWrap === "function") p.lineWrap(3);
        if (typeof p.cutPaper === "function") p.cutPaper();
        return true;
      }
      if (printer.kind === "android") {
        printer.api.printText(text);
        return true;
      }
      if (printer.kind === "android-print") {
        printer.api.print(text);
        return true;
      }
      if (printer.kind === "imin") {
        printer.api.printText(text + "\n\n");
        return true;
      }
      if (printer.kind === "webkit") {
        printer.api.postMessage({ type: "printText", text });
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  function concatBytes(chunks) {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    chunks.forEach((c) => {
      out.set(c, o);
      o += c.length;
    });
    return out;
  }

  function canvasToEscPos(canvas) {
    const w = canvas.width;
    const h = canvas.height;
    const ctx = canvas.getContext("2d");
    const img = ctx.getImageData(0, 0, w, h);
    const widthBytes = Math.ceil(w / 8);
    const bits = new Uint8Array(widthBytes * h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = (y * w + x) * 4;
        const lum = img.data[i] * 0.299 + img.data[i + 1] * 0.587 + img.data[i + 2] * 0.114;
        if (lum < 168 && img.data[i + 3] > 40) {
          bits[y * widthBytes + (x >> 3)] |= 0x80 >> (x & 7);
        }
      }
    }
    const header = new Uint8Array([
      0x1b,
      0x40,
      0x1b,
      0x61,
      0x01,
      0x1d,
      0x76,
      0x30,
      0x00,
      widthBytes & 0xff,
      (widthBytes >> 8) & 0xff,
      h & 0xff,
      (h >> 8) & 0xff,
    ]);
    const tail = new Uint8Array([0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x00]);
    return concatBytes([header, bits, tail]);
  }

  async function slipToEscPos(mode) {
    const root = slipRoot(mode);
    if (!root || typeof html2canvas !== "function") return null;
    const targetW = getSettings().paperWidth === "58" ? 384 : 576;
    const canvas = await html2canvas(root, {
      backgroundColor: "#ffffff",
      scale: 2,
      useCORS: true,
    });
    const out = document.createElement("canvas");
    out.width = targetW;
    out.height = Math.max(8, Math.round((canvas.height * targetW) / canvas.width));
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, 0, 0, out.width, out.height);
    return canvasToEscPos(out);
  }

  async function writeBle(bytes) {
    if (!state.bleChar) return false;
    for (let i = 0; i < bytes.length; i += BLE_CHUNK) {
      const slice = bytes.slice(i, i + BLE_CHUNK);
      await state.bleChar.writeValueWithoutResponse(slice).catch(async () => {
        await state.bleChar.writeValue(slice);
      });
    }
    return true;
  }

  async function findWritableChar(server) {
    const services = await server.getPrimaryServices();
    for (const service of services) {
      const chars = await service.getCharacteristics();
      for (const ch of chars) {
        const props = ch.properties || {};
        if (props.writeWithoutResponse || props.write) return ch;
      }
    }
    return null;
  }

  async function pairBlePrinter() {
    if (!navigator.bluetooth) {
      throw new Error("هذا المتصفح لا يدعم طباعة بلوتوث. استخدم Brave أو Chrome.");
    }
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [
        "000018f0-0000-1000-8000-00805f9b34fb",
        "49535343-fe7d-4ae5-8fa9-9fafd205e455",
        "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
      ],
    });
    const server = await device.gatt.connect();
    const ch = await findWritableChar(server);
    if (!ch) throw new Error("لم يُعثر على قناة طباعة على الجهاز");
    state.bleDevice = device;
    state.bleChar = ch;
    try {
      localStorage.setItem(KEYS.blePrinterId, device.id || "");
    } catch {
      /* ignore */
    }
    device.addEventListener("gattserverdisconnected", () => {
      state.bleChar = null;
      setPrinterStatus("انقطع اتصال الطابعة");
    });
    setPrinterStatus("طابعة بلوتوث: " + (device.name || "متصلة"));
  }

  async function ensureBleConnected() {
    if (state.bleChar && state.bleDevice?.gatt?.connected) return true;
    if (!state.bleDevice) return false;
    const server = await state.bleDevice.gatt.connect();
    state.bleChar = await findWritableChar(server);
    return !!state.bleChar;
  }

  async function tryBlePrint(mode) {
    try {
      if (!(await ensureBleConnected())) return false;
      const bytes = await slipToEscPos(mode);
      if (!bytes) return false;
      return await writeBle(bytes);
    } catch {
      return false;
    }
  }

  async function printThermal(mode, printFn) {
    applyPaperClass();
    if (tryNativePrint(mode)) return;
    if (await tryBlePrint(mode)) return;
    if (typeof printFn === "function") printFn(mode);
  }

  function maybeAutoPrint(mode, printFn) {
    if (!getSettings().autoPrint) return;
    window.setTimeout(() => printThermal(mode, printFn), 420);
  }

  function wireLifecycle() {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        if (state.wantCameraResume) maybeResumeCamera();
        if (global.__parkingQrActive) requestWakeLock();
      }
    });
    window.addEventListener("focus", () => {
      if (state.wantCameraResume) maybeResumeCamera();
    });
  }

  function init() {
    applyPaperClass();
    registerServiceWorker();
    wireInstall();
    wireSettings();
    wireHardwareScanner();
    wireLifecycle();
    syncPosControls();
  }

  global.ParkingPos = {
    init,
    syncPosControls,
    getSettings,
    handleDecodedScan,
    markWantResume,
    setWantResume,
    maybeResumeCamera,
    tryAutoStartCamera,
    printThermal,
    maybeAutoPrint,
    applyPaperClass,
    startNativeCameraScan,
    stopNativeCamera,
    nativeDetectorAvailable,
    requestWakeLock,
    ASSET,
  };

  init();
})(window);
