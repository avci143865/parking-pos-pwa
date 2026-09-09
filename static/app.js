const $ = (id) => document.getElementById(id);

const DAMASCUS_TZ = "Asia/Damascus";
const TOKEN_KEY = "parking_access_token";

/** آخر تحميل لسجل التذاكر (للمعاينة السريعة) */
let ticketLogCache = [];
/** آخر تحميل لأدوار الخروج (لتصدير المدير) */
let fifoDashboardCache = null;
/** صفحة بروفايلات المركبات الحالية (من الخادم) */
let vehicleProfileListCache = [];
/** نص البحث في صفحة إدارة المركبات */
let profilesSearchQuery = "";
/** فلاتر قائمة المركبات */
let profilesFilters = { vehicle_type: "", partnership_company: "", has_photo: "" };
/** ترقيم صفحات بروفايلات المركبات */
let profilesPage = 1;
const PROFILES_PAGE_SIZE = 50;
let profilesListMeta = { total: 0, page: 1, total_pages: 1 };
let profilesFilterOptions = null;
let profilesListLoading = false;
/** معرّف البروفايل المعروض في نافذة البطاقة (للتنزيل) */
let vehicleCardProfileId = null;
/** بروفايل مرتبط بإيصال الدخول المعروض حاليًا (لزر بطاقة المركبة) */
let receiptModalProfileRef = null;
/** admin | employee_in | employee_out | employee | null */
let currentRole = null;
/** اسم المستخدم الحالي */
let currentUsername = null;
/** صلاحيات الجلسة الحالية */
let canCheckIn = false;
let canCheckOut = false;

function permissionsForRole(role) {
  return {
    canCheckIn: role === "admin" || role === "employee_in" || role === "employee",
    canCheckOut: role === "admin" || role === "employee_out" || role === "employee",
  };
}

function roleLabel(role) {
  switch (role) {
    case "admin":
      return "مدير";
    case "employee_in":
      return "موظف إدخال";
    case "employee_out":
      return "موظف إخراج";
    default:
      return "موظف";
  }
}

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  currentRole = null;
  currentUsername = null;
  canCheckIn = false;
  canCheckOut = false;
}

function showLoginView() {
  $("view-login").classList.remove("hidden");
  $("app-shell").classList.add("hidden");
}

function showAppShell() {
  $("view-login").classList.add("hidden");
  $("app-shell").classList.remove("hidden");
}

function applyRoleUI(me) {
  currentRole = me.role;
  currentUsername = me.username;
  const perms =
    me.can_check_in != null && me.can_check_out != null
      ? { canCheckIn: me.can_check_in, canCheckOut: me.can_check_out }
      : permissionsForRole(me.role);
  canCheckIn = perms.canCheckIn;
  canCheckOut = perms.canCheckOut;
  const isAdmin = me.role === "admin";
  $("nav-settings").classList.toggle("hidden", !isAdmin);
  $("nav-stats").classList.toggle("hidden", !isAdmin);
  $("fifo-admin-export")?.classList.toggle("hidden", !isAdmin);
  $("user-banner").textContent = `${me.username} · ${roleLabel(me.role)}`;
  updateDeskLayout();
}

function setDeskModeChip(mode) {
  const pageChip = $("desk-page-mode-chip");
  const scanChip = $("desk-scan-mode-chip");
  const pageIcon = $("desk-page-mode-icon");
  const scanIcon = $("desk-scan-mode-icon");
  const pageLabel = $("desk-page-mode-label");
  const focused = mode === "checkin" || mode === "checkout";

  pageChip?.classList.toggle("hidden", !focused);
  scanChip?.classList.toggle("hidden", !focused);
  pageChip?.classList.toggle("desk-mode-checkin", mode === "checkin");
  pageChip?.classList.toggle("desk-mode-checkout", mode === "checkout");
  scanChip?.classList.toggle("desk-mode-checkin", mode === "checkin");
  scanChip?.classList.toggle("desk-mode-checkout", mode === "checkout");

  if (mode === "checkin") {
    if (pageIcon) pageIcon.textContent = "↓";
    if (scanIcon) scanIcon.textContent = "↓";
    if (pageLabel) pageLabel.textContent = "وضع الإدخال";
  } else if (mode === "checkout") {
    if (pageIcon) pageIcon.textContent = "↑";
    if (scanIcon) scanIcon.textContent = "↑";
    if (pageLabel) pageLabel.textContent = "وضع الإخراج";
  }
}
async function downloadVehicleCardsZipByType(vehicleType, count) {
  if (typeof JSZip === "undefined") {
    alert("مكتبة JSZip غير محمّلة.");
    return;
  }

  if (typeof html2canvas === "undefined") {
    alert("مكتبة html2canvas غير محمّلة.");
    return;
  }

  await loadProfilesFilterMeta();
  const type = String(vehicleType || profilesFilters.vehicle_type || "").trim();
  if (!type) {
    alert("اختر نوع المركبة أولًا.");
    return;
  }
  const limit = Math.min(Math.max(Number(count) || 500, 1), 5000);
  const statusEl = $("profiles-bulk-card-status");
  const setStatus = (msg) => {
    if (statusEl) statusEl.textContent = msg;
  };
  const pageSize = 100;
  const rows = [];
  let page = 1;
  let total = null;

  setStatus("جاري تحميل بيانات المركبات…");
  while (rows.length < limit) {
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(Math.min(pageSize, limit - rows.length)),
      vehicle_type: type,
    });
    const data = await api(`/api/vehicle-profiles?${params.toString()}`);
    const items = Array.isArray(data?.items) ? data.items : [];
    if (total == null) total = Number(data?.total) || 0;
    rows.push(...items);
    setStatus(`تم تحميل ${rows.length} من ${Math.min(limit, total || limit)}…`);
    if (!items.length || page >= (data?.total_pages || 1)) break;
    page += 1;
  }

  const selectedRows = rows.slice(0, limit);
  if (!selectedRows.length) {
    alert("لا توجد مركبات من هذا النوع.");
    setStatus("");
    return;
  }

  const zip = new JSZip();

  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.left = "-99999px";
  host.style.top = "0";
  document.body.appendChild(host);

  try {
    for (const [idx, row] of selectedRows.entries()) {
      setStatus(`جاري إنشاء البطاقة ${idx + 1} من ${selectedRows.length}…`);
      host.innerHTML = buildVehicleCardHtml(row);
      renderQrIntoHost(host.querySelector("#vehicle-card-qr-host"), vehicleQrPayload(row), 200);

      const card = host.querySelector(".driver-card");
      const canvas = await html2canvas(card, {
        scale: 2,
        useCORS: true,
        logging: false,
        backgroundColor: getVehicleCardCanvasBackground(card),
        onclone: prepareVehicleCardCloneForExport,
      });

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (blob) {
        const plate = String(row.license_plate || "plate").replace(/[^\w\u0600-\u06FF-]+/g, "_");
        zip.file(`vehicle-card-${row.id}-${plate}.png`, blob);
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }

    setStatus("جاري ضغط الملف…");
    const zipBlob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(zipBlob);

    const a = document.createElement("a");
    a.href = url;
    const slug = type.replace(/[^\w\u0600-\u06FF-]+/g, "_");
    a.download = `vehicle-cards-${slug}-${selectedRows.length}.zip`;
    a.click();

    URL.revokeObjectURL(url);
    setStatus(`تم تجهيز ${selectedRows.length} بطاقة.`);
  } finally {
    host.remove();
  }
}
function updateDeskLayout() {
  const desk = $("view-desk");
  if (!desk) return;

  const focusedSingle = (canCheckIn || canCheckOut) && canCheckIn !== canCheckOut;
  desk.classList.toggle("desk-view--focused", focusedSingle);
  desk.classList.toggle("desk-view--checkin", canCheckIn && !canCheckOut);
  desk.classList.toggle("desk-view--checkout", canCheckOut && !canCheckIn);
  desk.classList.toggle("desk-view--full", canCheckIn && canCheckOut);

  document.querySelector(".panel-checkin")?.classList.toggle("hidden", !canCheckIn);
  document.querySelector(".panel-checkout")?.classList.toggle("hidden", !canCheckOut);

  const showScan = canCheckIn || canCheckOut;
  const scanEl = $("desk-vehicle-scan");
  scanEl?.classList.toggle("hidden", !showScan);
  scanEl?.classList.toggle("desk-scan-checkin", canCheckIn && !canCheckOut);
  scanEl?.classList.toggle("desk-scan-checkout", canCheckOut && !canCheckIn);
  scanEl?.classList.toggle("desk-scan-full", canCheckIn && canCheckOut);

  const mainRow = $("desk-main-row");
  mainRow?.classList.toggle("desk-main-row--single", canCheckIn !== canCheckOut);

  const title = $("vehicle-scan-title");
  const lead = $("vehicle-scan-lead");
  const pageTitle = $("desk-page-title");
  const tagline = desk.querySelector(".header-tagline");
  const navDesk = $("nav-desk");

  if (canCheckIn && !canCheckOut) {
    if (title) title.textContent = "مسح بطاقة المركبة للدخول";
    if (lead) {
      lead.textContent =
        "امسح بطاقة مركبة غير موجودة داخل الموقف. لا يمكن استخدام هذا الحساب لمسح مركبات بالداخل.";
    }
    if (pageTitle) pageTitle.textContent = "مكتب الإدخال";
    if (tagline) tagline.textContent = "تسجيل دخول المركبات وإصدار الإيصالات";
    if (navDesk) navDesk.textContent = "الإدخال";
    setDeskModeChip("checkin");
  } else if (canCheckOut && !canCheckIn) {
    if (title) title.textContent = "مسح بطاقة المركبة للخروج";
    if (lead) {
      lead.textContent =
        "امسح بطاقة مركبة داخل الموقف لإتمام الخروج. لا يمكن استخدام هذا الحساب لمسح مركبات بالخارج.";
    }
    if (pageTitle) pageTitle.textContent = "مكتب الإخراج";
    if (tagline) tagline.textContent = "إتمام خروج المركبات وحساب الرسوم";
    if (navDesk) navDesk.textContent = "الإخراج";
    setDeskModeChip("checkout");
  } else {
    if (title) title.textContent = "مسح بطاقة المركبة (QR)";
    if (lead) lead.textContent = "امسح بطاقة المركبة عبر الكاميرا.";
    if (pageTitle) pageTitle.textContent = "مكتب الحجز";
    if (tagline) tagline.textContent = "دخول وخروج من مكان واحد";
    if (navDesk) navDesk.textContent = "الإدخال والإخراج";
    setDeskModeChip("full");
  }

  if (!showScan) {
    stopVehicleQrScanner().catch(() => {});
  }
}

/** يفسر التواريخ القادمة من الخادم كـ UTC (naive ISO) ثم يعرضها بتوقيت دمشق. */
function parseServerUtc(iso) {
  if (iso == null || iso === "") return new Date(NaN);
  const s = String(iso).trim();
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s);
  return new Date(`${s}Z`);
}

function formatDamascusDateTime(iso) {
  const d = parseServerUtc(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ar-SY", {
    numberingSystem: "latn",
    timeZone: DAMASCUS_TZ,
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function sypOldEquivalent(amountNew) {
  const n = Number(amountNew);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function formatSypDualLine(amountNew) {
  const oldEq = sypOldEquivalent(amountNew);
  const nf = new Intl.NumberFormat("ar-SY", { numberingSystem: "latn" });
  return `${nf.format(amountNew)} ل.س جديدة — ${nf.format(oldEq)} ل.س قديمة`;
}

function formatDailyRate(sypNewPerDay) {
  return `${formatSypDualLine(sypNewPerDay)} لليوم`;
}

function formatStayDuration(hours) {
  if (hours == null || !Number.isFinite(Number(hours))) return "—";
  const totalMinutes = Math.max(0, Math.round(Number(hours) * 60));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h > 0 && m > 0) return `${h} ساعة و ${m} دقيقة`;
  if (h > 0) return h === 1 ? "ساعة واحدة" : `${h} ساعات`;
  if (m > 0) return m === 1 ? "دقيقة واحدة" : `${m} دقائق`;
  return "أقل من دقيقة";
}

function formatSypAmountDue(amountNew) {
  return formatSypDualLine(amountNew);
}

function formatBillingHours(h) {
  if (h == null || !Number.isFinite(Number(h))) return "—";
  const n = Number(h);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

async function api(path, options = {}) {
  const skipAuth = path === "/api/auth/login";
  const { headers: optHeaders, ...rest } = options;
  const headers = {
    "Content-Type": "application/json",
    ...(optHeaders || {}),
  };
  if (!skipAuth) {
    const t = getToken();
    if (t) headers["Authorization"] = `Bearer ${t}`;
  }
  const res = await fetch(path, {
    ...rest,
    headers,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (res.status === 401 && !skipAuth) {
    clearAuth();
    showLoginView();
    const err = new Error("انتهت الجلسة. سجّل الدخول مجددًا.");
    err.code = 401;
    throw err;
  }
  if (!res.ok) {
    let msg;
    if (Array.isArray(data?.detail)) {
      msg = data.detail.map((d) => d.msg || JSON.stringify(d)).join("؛ ");
    } else if (data?.detail != null && typeof data.detail === "object" && !Array.isArray(data.detail)) {
      msg = data.detail.message || JSON.stringify(data.detail);
    } else if (data?.detail != null) {
      msg = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
    } else if (typeof data === "string") {
      msg = data;
    } else {
      msg = res.statusText;
    }
    const err = new Error(msg);
    err.status = res.status;
    if (data?.detail != null && typeof data.detail === "object" && !Array.isArray(data.detail)) {
      err.fifoDetail = data.detail;
    }
    throw err;
  }
  return data;
}

async function refreshStats() {
  const s = await api("/api/settings");
  $("cap").textContent = s.total_slots;
  $("avail").textContent = s.available_slots;
  $("rate").textContent = formatDailyRate(s.price_per_hour_cents);
  $("total-slots").value = s.total_slots;
  $("price-hour").value = String(s.price_per_hour_cents);
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function printIssuerFooterHtml() {
  if (!currentRole) return "";
  return `<p class="print-issuer-footer">${roleLabel(currentRole)}</p>`;
}

function renderQrIntoHost(hostEl, text, pixelSize = 200) {
  if (!hostEl) return;
  hostEl.innerHTML = "";
  if (!text || typeof QRCode === "undefined") {
    hostEl.innerHTML = '<p class="muted">تعذّر إنشاء رمز QR.</p>';
    return;
  }
  try {
    const level =
      QRCode.CorrectLevel != null ? QRCode.CorrectLevel.H : undefined;
    new QRCode(hostEl, {
      text,
      width: pixelSize,
      height: pixelSize,
      colorDark: "#000000",
      colorLight: "#ffffff",
      ...(level !== undefined ? { correctLevel: level } : {}),
    });
  } catch (e) {
    console.error(e);
    hostEl.innerHTML = '<p class="muted">تعذّر إنشاء رمز QR.</p>';
  }
}

function buildCheckoutResultHtml(data) {
  const nf = new Intl.NumberFormat("ar-SY", { numberingSystem: "latn" });
  const newAmt = data.amount_due_cents;
  const oldAmt = sypOldEquivalent(newAmt);
  const days = data.days_billed ?? 1;
  const rateLine = formatSypDualLine(data.daily_rate_cents);
  const daysLabel = days === 1 ? "يوم واحد" : `${days} أيام`;
  const entered = formatDamascusDateTime(data.entered_at);
  const exited = formatDamascusDateTime(data.exited_at);
  let fifoExtra = "";
  if (data.fifo_queue_number != null || data.fifo_truck_type) {
    const qNum = data.fifo_queue_number != null ? String(data.fifo_queue_number) : "—";
    const qType = data.fifo_truck_type ? escapeHtml(data.fifo_truck_type) : "—";
    fifoExtra += `<div><dt>نوع الشاحنة</dt><dd>${escapeHtml(data.vehicle_type || data.fifo_truck_type || "—")}</dd></div>`;
    fifoExtra += `<div><dt>دور الخروج</dt><dd>${escapeHtml(qNum)} (${qType})</dd></div>`;
  }
  if (data.driver_name || data.partnership_company) {
    fifoExtra += `<div><dt>السائق</dt><dd>${escapeHtml(data.driver_name || "—")}</dd></div>`;
    fifoExtra += `<div><dt>الشركة</dt><dd>${escapeHtml(data.partnership_company || "—")}</dd></div>`;
  }
  return `
    <div id="checkout-invoice-slip" class="checkout-invoice-slip thermal-slip" role="document" aria-label="فاتورة الموقف">
      <header class="invoice-header">
        <h3 class="invoice-title">فاتورة الخروج</h3>
        <p class="invoice-code" dir="ltr">${escapeHtml(data.receipt_code)}</p>
      </header>
      <dl class="invoice-meta">
        ${fifoExtra}
        <div><dt>وقت الدخول</dt><dd>${escapeHtml(entered)}</dd></div>
        <div><dt>وقت الخروج</dt><dd>${escapeHtml(exited)}</dd></div>
        <div><dt>اللوحة</dt><dd>${escapeHtml(data.license_plate)}</dd></div>
        <div><dt>المكان</dt><dd>${escapeHtml(String(data.slot_number))}</dd></div>
        <div><dt>أيام محسوبة</dt><dd>${escapeHtml(daysLabel)}</dd></div>
        <div><dt>السعر / يوم</dt><dd>${escapeHtml(rateLine)}</dd></div>
      </dl>
      <div class="invoice-total-block">
        <p class="invoice-total-label">الإجمالي المستحق</p>
        <p class="invoice-total-new">${nf.format(newAmt)} <span>ل.س جديدة</span></p>
        <p class="invoice-total-old">${nf.format(oldAmt)} <span>ل.س قديمة</span></p>
      </div>
      <p class="invoice-farewell">رافقتكم السلامة</p>
      ${printIssuerFooterHtml()}
    </div>`;
}

function renderReceiptQr(receiptCode) {
  const qrEl = $("receipt-qr-host");
  const plainEl = $("receipt-code-plain");
  if (plainEl) plainEl.textContent = receiptCode;
  renderQrIntoHost(qrEl, receiptCode, 168);
}

/**
 * @param {object} p
 * @param {string} p.receipt_code
 * @param {string} p.license_plate
 * @param {number} p.slot_number
 * @param {string} p.entered_at ISO
 * @param {string|null} [p.exited_at]
 * @param {number|null} [p.amount_due_cents]
 * @param {number|null} [p.hours_billed]
 */
function buildReceiptSlipHtml(p) {
  const entered = formatDamascusDateTime(p.entered_at);
  let extra = "";
  if (p.exited_at) {
    const ex = formatDamascusDateTime(p.exited_at);
    let pay = "";
    if (p.amount_due_cents != null) {
      pay = `<dt>المستحق</dt><dd>${escapeHtml(formatSypAmountDue(p.amount_due_cents))}</dd>`;
    }
    let hrs = "";
    if (p.hours_billed != null) {
      const d = Number(p.hours_billed);
      const daysTxt = d === 1 ? "يوم واحد" : `${formatBillingHours(d)} أيام`;
      hrs = `<dt>أيام محسوبة</dt><dd>${escapeHtml(daysTxt)}</dd>`;
    }
    extra = `
      <div class="receipt-exit-block">
        <p class="receipt-exit-title">خرجت من الموقف</p>
        <dl class="receipt-meta receipt-meta-exit">
          <dt>وقت الخروج</dt><dd>${escapeHtml(ex)}</dd>
          ${hrs}
          ${pay}
        </dl>
      </div>`;
  }
  return `
    <div id="receipt-slip" class="receipt-slip thermal-slip">
      <div class="receipt-slip-inner">
        <h3>إيصال موقف</h3>
        <p class="hint-scan">امسح الرمز عند الخروج لتسريع إجراءات الدفع.</p>
        <div class="codes-row codes-row-qr-only">
          <div class="qr-host" id="receipt-qr-host" aria-label="رمز QR للإيصال"></div>
          <div class="receipt-code-block">
            <span class="receipt-code-label">رمز الإيصال</span>
            <div class="receipt-code-plain" id="receipt-code-plain"></div>
          </div>
        </div>
        <dl class="receipt-meta">
          <dt>المكان</dt><dd>${escapeHtml(String(p.slot_number))}</dd>
          <dt>اللوحة</dt><dd>${escapeHtml(p.license_plate)}</dd>
          <dt>وقت الدخول</dt><dd>${escapeHtml(entered)}</dd>
          ${p.fifo_queue_number != null ? `<dt>دور الخروج</dt><dd>${escapeHtml(String(p.fifo_queue_number))} (${escapeHtml(p.fifo_truck_type || p.vehicle_type || "—")})</dd>` : ""}
        </dl>
        ${extra}
        ${printIssuerFooterHtml()}
      </div>
    </div>`;
}

let html5QrScanner = null;
const QR_CAMERA_STORAGE_KEY = "parking.qrCameraId";
let vehicleFlowPrimaryHandler = null;
let profilePhotoBlobUrl = null;

function vehicleFlowModalIsHidden() {
  const m = $("vehicle-flow-modal");
  return m.classList.contains("hidden") || m.hasAttribute("hidden");
}

function clearProfilePhotoBlob() {
  if (profilePhotoBlobUrl) {
    URL.revokeObjectURL(profilePhotoBlobUrl);
    profilePhotoBlobUrl = null;
  }
}

function closeVehicleFlowModal() {
  clearProfilePhotoBlob();
  vehicleFlowPrimaryHandler = null;
  const modal = $("vehicle-flow-modal");
  delete modal.dataset.publicToken;
  modal.classList.add("hidden");
  modal.setAttribute("hidden", "");
  $("vehicle-flow-modal-body").innerHTML = "";
  $("vehicle-flow-primary").classList.add("hidden");
  if (
    checkoutModalIsHidden() &&
    modalIsHidden() &&
    messageModalIsHidden() &&
    vehicleCardModalIsHidden()
  ) {
    document.body.classList.remove("modal-open");
  }
  window.ParkingPos?.maybeResumeCamera();
}

function openVehicleFlowModal({ title, bodyHtml, primaryLabel, showPrimary, onPrimary }) {
  if (!checkoutModalIsHidden()) closeCheckoutResultModal();
  if (!modalIsHidden()) closeReceiptModal();
  if (!messageModalIsHidden()) closeMessageModal();
  if (!vehicleCardModalIsHidden()) closeVehicleCardModal();
  clearProfilePhotoBlob();
  vehicleFlowPrimaryHandler = onPrimary || null;
  $("vehicle-flow-modal-title").textContent = title;
  $("vehicle-flow-modal-body").innerHTML = bodyHtml;
  const btn = $("vehicle-flow-primary");
  btn.textContent = primaryLabel || "متابعة";
  btn.classList.toggle("hidden", !showPrimary);
  const modal = $("vehicle-flow-modal");
  modal.classList.remove("hidden");
  modal.removeAttribute("hidden");
  document.body.classList.add("modal-open");
  if (showPrimary) btn.focus();
  else $("vehicle-flow-cancel").focus();
}

function extractScanToken(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const hashMatch = s.match(/[#&?]scan=([^&\s#]+)/i);
  if (hashMatch) {
    try {
      return decodeURIComponent(hashMatch[1]);
    } catch {
      return hashMatch[1];
    }
  }
  const uuidMatch = s.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  );
  if (uuidMatch) return uuidMatch[0];
  return s;
}

function captureVehicleScanFromHash() {
  const h = location.hash || "";
  if (!h.startsWith("#scan=")) return;
  const token = extractScanToken(h);
  history.replaceState(null, "", location.pathname + location.search);
  if (token) sessionStorage.setItem("pendingVehicleScan", token);
}

function consumePendingVehicleScan() {
  const token = sessionStorage.getItem("pendingVehicleScan");
  if (!token) return;
  sessionStorage.removeItem("pendingVehicleScan");
  setView("desk");
  setTimeout(() => {
    processVehicleScan(token).catch((e) => alert(e.message));
  }, 350);
}

async function fetchProfilePhotoHtml(profileId, hasPhoto) {
  if (!hasPhoto) return "";
  const t = getToken();
  if (!t) return "";
  const res = await fetch(`/api/vehicle-profiles/${profileId}/photo`, {
    headers: { Authorization: `Bearer ${t}` },
  });
  if (!res.ok) return '<p class="muted small-print">تعذّر تحميل الصورة.</p>';
  const blob = await res.blob();
  clearProfilePhotoBlob();
  profilePhotoBlobUrl = URL.createObjectURL(blob);
  return `<div class="profile-photo-wrap"><img class="profile-photo-preview" src="${profilePhotoBlobUrl}" alt="" /></div>`;
}

function dlValue(v) {
  return v && String(v).trim() ? escapeHtml(String(v).trim()) : "—";
}

function normalizeVehicleProfileRow(p) {
  if (!p) return null;
  const id = p.id ?? p.profile_id;
  if (id == null) return null;
  return {
    id,
    public_token: p.public_token ?? p.publicToken ?? "",
    license_plate: p.license_plate ?? p.licensePlate ?? "",
    vehicle_make: p.vehicle_make ?? p.vehicleMake ?? null,
    vehicle_type: p.vehicle_type ?? p.vehicleType ?? null,
    vehicle_color: p.vehicle_color ?? p.vehicleColor ?? null,
    driver_name: p.driver_name ?? p.driverName ?? null,
    owner_name: p.owner_name ?? p.ownerName ?? null,
    partnership_company: p.partnership_company ?? p.partnershipCompany ?? null,
    mechanical_number: p.mechanical_number ?? p.mechanicalNumber ?? "",
    qr_payload: p.qr_payload ?? p.qrPayload ?? "",
  };
}

function cardFieldHtml(label, value, wide = false) {
  const raw = value != null ? String(value).trim() : "";
  if (!raw) return "";
  const cls = wide ? ' class="driver-card-dl-value-wide"' : "";
  return `<div><dt>${escapeHtml(label)}</dt><dd${cls}>${escapeHtml(raw)}</dd></div>`;
}

function getVehicleCardCanvasBackground(card) {
  const fallback = typeof getAppTheme === "function" && getAppTheme() === "light" ? "#f8fafc" : "#0f141c";
  if (!card) return fallback;
  return (
    getComputedStyle(card).getPropertyValue("--driver-card-canvas-bg").trim() ||
    fallback
  );
}

function buildVehicleCardHtml(p) {
  const row = normalizeVehicleProfileRow(p);
  if (!row) return "";
  const optionalFields = [
    cardFieldHtml("الطراز", row.vehicle_make),
    cardFieldHtml("النوع", row.vehicle_type),
    cardFieldHtml("اللون", row.vehicle_color),
    cardFieldHtml("اسم السائق", row.driver_name),
    cardFieldHtml("اسم المالك", row.owner_name),
    cardFieldHtml("الشركة التضامنية", row.partnership_company),
    cardFieldHtml("رقم الميكانيك", row.mechanical_number, true),
  ].join("");
  return `
    <div class="vehicle-card-preview-shell">
    <article class="driver-card" aria-label="بطاقة المركبة">
      <div class="driver-card-shine" aria-hidden="true"></div>
      <div class="driver-card-inner">
        <header class="driver-card-head">
          <img src="/static/logo.png" alt="" class="driver-card-logo" width="40" height="40" />
          <h2 class="driver-card-title">بطاقة المركبة</h2>
        </header>
        <div class="driver-card-grid">
          <dl class="driver-card-dl">
            <div><dt>رقم البروفايل</dt><dd>#${escapeHtml(String(row.id))}</dd></div>
            <div><dt>اللوحة</dt><dd class="driver-card-dl-value-wide">${dlValue(row.license_plate)}</dd></div>
            ${optionalFields}
          </dl>
          <div class="driver-card-qr-panel">
            <p class="driver-card-qr-caption">امسح من تطبيق الموقف</p>
            <div id="vehicle-card-qr-host"></div>
          </div>
        </div>
      </div>
    </article>
    </div>`;
}

function prepareVehicleCardCloneForExport(clonedDoc) {
  const clonedCard = clonedDoc.querySelector(".driver-card");
  if (!clonedCard) return;
  clonedCard.style.fontFamily = '"Segoe UI", Tahoma, "Arabic UI Text", Arial, sans-serif';
  clonedCard.style.direction = "rtl";
  clonedCard.style.width = "680px";
  clonedCard.style.maxWidth = "680px";
  clonedCard.querySelectorAll(
    ".driver-card-dl dt, .driver-card-dl dd, .driver-card-title, .driver-card-seq, .driver-card-qr-caption"
  ).forEach((el) => {
    el.style.letterSpacing = "normal";
    el.style.textTransform = "none";
    el.style.fontFamily = '"Segoe UI", Tahoma, "Arabic UI Text", Arial, sans-serif';
  });
}

function vehicleQrPayload(profileRow) {
  if (!profileRow) return "";
  const token = String(profileRow.public_token || "").trim();
  if (token) return token;
  const legacy = String(profileRow.qr_payload || "").trim();
  return extractScanToken(legacy) || legacy;
}

function renderVehicleCardQr(qrPayload) {
  renderQrIntoHost($("vehicle-card-qr-host"), qrPayload, 200);
}

function vehicleCardModalIsHidden() {
  const m = $("vehicle-card-modal");
  return !m || m.classList.contains("hidden") || m.hasAttribute("hidden");
}

function closeVehicleCardModal() {
  const modal = $("vehicle-card-modal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("hidden", "");
  $("vehicle-card-modal-host").innerHTML = "";
  vehicleCardProfileId = null;
  if (
    checkoutModalIsHidden() &&
    modalIsHidden() &&
    messageModalIsHidden() &&
    vehicleFlowModalIsHidden()
  ) {
    document.body.classList.remove("modal-open");
  }
  window.ParkingPos?.maybeResumeCamera();
}

function openVehicleCardModal(profileRow) {
  const cached =
    profileRow?.id != null
      ? vehicleProfileListCache.find((x) => x.id === profileRow.id)
      : null;
  const merged = normalizeVehicleProfileRow(
    cached ? { ...cached, ...profileRow } : profileRow
  );
  if (!merged) return;
  if (!checkoutModalIsHidden()) closeCheckoutResultModal();
  if (!modalIsHidden()) closeReceiptModal();
  if (!messageModalIsHidden()) closeMessageModal();
  if (!vehicleFlowModalIsHidden()) closeVehicleFlowModal();

  vehicleCardProfileId = merged.id;
  $("vehicle-card-modal-title").textContent = `بطاقة المركبة #${merged.id}`;
  $("vehicle-card-modal-host").innerHTML = buildVehicleCardHtml(merged);
  renderVehicleCardQr(vehicleQrPayload(merged));

  const modal = $("vehicle-card-modal");
  modal.classList.remove("hidden");
  modal.removeAttribute("hidden");
  document.body.classList.add("modal-open");
  $("vehicle-card-dismiss").focus();
}

async function downloadVehicleCardPng() {
  if (typeof html2canvas === "undefined") {
    alert("تعذّر تحميل أداة تصدير البطاقة. تحقق من الاتصال وأعد تحميل الصفحة.");
    return;
  }
  const card = $("vehicle-card-modal-host")?.querySelector(".driver-card");
  if (!card) return;
  const btn = $("vehicle-card-download");
  const prevLabel = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "جارٍ إنشاء الصورة…";
  }
  try {
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }
    const canvas = await html2canvas(card, {
      scale: 2,
      useCORS: true,
      logging: false,
      backgroundColor: getVehicleCardCanvasBackground(card),
      ignoreElements: (node) =>
        node.classList && node.classList.contains("driver-card-shine"),
      onclone: prepareVehicleCardCloneForExport,
    });
    const pid = vehicleCardProfileId != null ? String(vehicleCardProfileId) : "vehicle";
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `parking-vehicle-card-${pid}.png`;
    a.click();
  } catch (ex) {
    alert(ex.message || "تعذّر تصدير البطاقة. جرّب متصفحًا آخر أو صوّر الشاشة.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = prevLabel;
    }
  }
}

function buildVehicleProfileDl(p) {
  const field = (v) => (v ? escapeHtml(v) : "—");
  return `
    <dl class="checkout-result-dl profile-flow-dl">
      <div><dt>رقم البروفايل</dt><dd>${escapeHtml(String(p.id))}</dd></div>
      <div><dt>اللوحة</dt><dd>${escapeHtml(p.license_plate)}</dd></div>
      <div><dt>الطراز</dt><dd>${field(p.vehicle_make)}</dd></div>
      <div><dt>النوع</dt><dd>${field(p.vehicle_type)}</dd></div>
      <div><dt>اللون</dt><dd>${field(p.vehicle_color)}</dd></div>
      <div><dt>اسم السائق</dt><dd>${field(p.driver_name)}</dd></div>
      <div><dt>اسم المالك</dt><dd>${field(p.owner_name)}</dd></div>
      <div><dt>الشركة التضامنية</dt><dd>${field(p.partnership_company)}</dd></div>
      <div><dt>رقم الميكانيك</dt><dd>${field(p.mechanical_number)}</dd></div>
    </dl>`;
}

async function deleteVehicleProfile(row, force = false) {
  if (currentRole !== "admin") {
    alert("إزالة المركبة متاحة للمدير فقط.");
    return;
  }
  const plate = row.license_plate || "هذه المركبة";
  if (!force) {
    if (
      !confirm(
        `هل تريد إزالة المركبة «${plate}» من النظام؟\nلا يمكن التراجع عن هذا الإجراء.`
      )
    ) {
      return;
    }
  }
  try {
    const q = force ? "?force=true" : "";
    await api(`/api/admin/vehicle-profiles/${row.id}${q}`, { method: "DELETE" });
    profilesFilterOptions = null;
    await refreshVehicleProfiles();
    await refreshDeskData();
    alert(force ? "تم إغلاق الجلسة وحذف المركبة." : "تمت إزالة المركبة.");
  } catch (e) {
    if (!force && e.status === 400 && /داخل الموقف|أكمِل الخروج|الحذف الإجباري/.test(e.message)) {
      if (
        confirm(
          `${e.message}\n\nهل تريد إغلاق الجلسة تلقائيًا ثم حذف البروفايل؟`
        )
      ) {
        return deleteVehicleProfile(row, true);
      }
      return;
    }
    alert(e.message);
  }
}

function buildFifoBlockedHtml(fifo, session) {
  const vehQ = session?.fifo_queue_number ?? fifo?.fifo_queue_number ?? "—";
  const allowed = fifo?.current_allowed_queue_number ?? "—";
  const truck = fifo?.fifo_truck_type ?? session?.fifo_truck_type ?? "—";
  return `
    <div class="fifo-blocked panel-elevated-inner" role="alert">
      <p class="fifo-blocked-title">المركبة في الانتظار</p>
      <dl class="checkout-result-dl fifo-blocked-dl">
        <div><dt>نوع الشاحنة</dt><dd>${escapeHtml(truck)}</dd></div>
        <div><dt>دور المركبة</dt><dd>${escapeHtml(String(vehQ))}</dd></div>
        <div><dt>الدور المسموح بالخروج</dt><dd class="fifo-allowed-num">${escapeHtml(String(allowed))}</dd></div>
        <div><dt>عدد المنتظرين</dt><dd>${escapeHtml(String(fifo?.waiting_count ?? "—"))}</dd></div>
      </dl>
    </div>`;
}

function buildFifoSessionExtra(active, fifo) {
  const entered = formatDamascusDateTime(active.entered_at);
  const qNum = active.fifo_queue_number != null ? String(active.fifo_queue_number) : "—";
  const truck = active.fifo_truck_type || fifo?.fifo_truck_type || "—";
  const statusLabel = fifo?.can_exit ? "قيد الخروج" : "في الانتظار";
  return `
    <div class="vehicle-flow-session panel-elevated-inner">
      <p class="checkout-micro muted">المركبة داخل الموقف حاليًا.</p>
      <dl class="checkout-result-dl">
        <div><dt>وقت الدخول (دمشق)</dt><dd>${escapeHtml(entered)}</dd></div>
        <div><dt>المكان</dt><dd>${escapeHtml(String(active.slot_number))}</dd></div>
        <div><dt>رمز الإيصال</dt><dd dir="ltr">${escapeHtml(active.receipt_code)}</dd></div>
        <div><dt>نوع الشاحنة</dt><dd>${escapeHtml(truck)}</dd></div>
        <div><dt>دور الخروج</dt><dd>${escapeHtml(qNum)}</dd></div>
        <div><dt>حالة الطابور</dt><dd>${escapeHtml(statusLabel)}</dd></div>
      </dl>
    </div>`;
}

async function showVehicleFlowFromScan(publicToken, data) {
  const modalEl = $("vehicle-flow-modal");
  if (modalEl) modalEl.dataset.publicToken = publicToken;
  const photoHtml = await fetchProfilePhotoHtml(data.profile.id, data.profile.has_photo);
  const body = `${photoHtml}${buildVehicleProfileDl(data.profile)}`;
  if (data.inside && data.active_session) {
    const fifo = data.fifo || {};
    const canExit = fifo.can_exit !== false;
    const extra = buildFifoSessionExtra(data.active_session, fifo);
    if (canExit && canCheckOut) {
      openVehicleFlowModal({
        title: "خروج المركبة — قيد الخروج",
        bodyHtml:
          body +
          extra +
          `<p class="checkout-micro muted">يمكن إتمام الخروج — المركبة ضمن المطلوب (قيد الخروج).</p>`,
        primaryLabel: "إتمام الخروج وحساب الرسوم",
        showPrimary: true,
        onPrimary: async () => {
          try {
            const out = await api("/api/employee/vehicle-check-out", {
              method: "POST",
              body: JSON.stringify({ public_token: publicToken }),
            });
            closeVehicleFlowModal();
            openCheckoutResultModal(out);
            await refreshDeskData();
            if (!$("view-tickets").classList.contains("hidden")) await refreshTickets();
            if (!$("view-fifo").classList.contains("hidden")) await refreshFifoDashboard();
          } catch (e) {
            if (e.fifoDetail) {
              openMessageModal(
                "ليس دور هذه المركبة حالياً",
                buildFifoBlockedHtml(e.fifoDetail, data.active_session),
                true
              );
            } else {
              alert(e.message);
            }
          }
        },
      });
    } else if (canExit && !canCheckOut) {
      openVehicleFlowModal({
        title: "المركبة داخل الموقف",
        bodyHtml:
          body +
          extra +
          `<p class="checkout-micro muted">هذا الحساب لا يملك صلاحية إخراج المركبات. استخدم حساب موظف الإخراج.</p>`,
        primaryLabel: "",
        showPrimary: false,
        onPrimary: null,
      });
    } else {
      openVehicleFlowModal({
        title: "لا يمكن الخروج الآن",
        bodyHtml: body + extra + buildFifoBlockedHtml(fifo, data.active_session),
        primaryLabel: "",
        showPrimary: false,
        onPrimary: null,
      });
    }
  } else if (canCheckIn) {
    openVehicleFlowModal({
      title: "دخول المركبة",
      bodyHtml: `${body}<p class="checkout-micro muted">المركبة غير مسجّلة داخل الموقف. يمكن إصدار إيصال دخول.</p>`,
      primaryLabel: "إصدار إيصال الدخول",
      showPrimary: true,
      onPrimary: async () => {
        try {
          const cin = await api("/api/employee/vehicle-check-in", {
            method: "POST",
            body: JSON.stringify({ public_token: publicToken }),
          });
          closeVehicleFlowModal();
          openReceiptModal({
            receipt_code: cin.receipt_code,
            license_plate: cin.license_plate,
            slot_number: cin.slot_number,
            entered_at: cin.entered_at,
            exited_at: null,
            amount_due_cents: null,
            hours_billed: null,
            profile_id: cin.profile_id ?? data.profile?.id ?? null,
            public_token: publicToken,
            vehicle_make: data.profile?.vehicle_make ?? cin.vehicle_make ?? null,
            vehicle_type: data.profile?.vehicle_type ?? cin.vehicle_type ?? null,
            vehicle_color: data.profile?.vehicle_color ?? cin.vehicle_color ?? null,
            driver_name: data.profile?.driver_name ?? cin.driver_name ?? null,
            owner_name: data.profile?.owner_name ?? cin.owner_name ?? null,
            partnership_company:
              data.profile?.partnership_company ?? cin.partnership_company ?? null,
            mechanical_number:
              data.profile?.mechanical_number ?? cin.mechanical_number ?? null,
            registration_order: cin.registration_order ?? null,
            qr_payload: cin.qr_payload ?? publicToken,
            fifo_queue_number: cin.fifo_queue_number ?? null,
            fifo_truck_type: cin.fifo_truck_type ?? null,
          });
          await refreshDeskData();
          if (!$("view-tickets").classList.contains("hidden")) await refreshTickets();
          if (!$("view-fifo").classList.contains("hidden")) await refreshFifoDashboard();
        } catch (e) {
          if (e.status === 409) openMessageModal("تعذّر الدخول", e.message);
          else alert(e.message);
        }
      },
    });
  } else {
    openVehicleFlowModal({
      title: "بيانات المركبة",
      bodyHtml: `${body}<p class="checkout-micro muted">المركبة غير داخل الموقف. هذا الحساب لا يملك صلاحية إدخال المركبات.</p>`,
      primaryLabel: "",
      showPrimary: false,
      onPrimary: null,
    });
  }
}

function collectFifoLanes(data) {
  const requested = [];
  const exiting = [];
  const done = [];
  for (const q of data?.queues || []) {
    for (const it of q.items || []) {
      const row = { ...it, truck_type: it.fifo_truck_type || q.truck_type };
      if (it.queue_status === "ready_exit") {
        if (it.is_current_turn) exiting.push(row);
        else requested.push(row);
      } else {
        requested.push(row);
      }
    }
  }
  for (const it of data?.exited_recent || []) {
    done.push({ ...it, truck_type: it.fifo_truck_type || "—" });
  }
  const sortByQueue = (a, b) =>
    (a.fifo_queue_number ?? 0) - (b.fifo_queue_number ?? 0) ||
    String(a.truck_type).localeCompare(String(b.truck_type), "ar");
  requested.sort(sortByQueue);
  exiting.sort(sortByQueue);
  done.sort((a, b) => new Date(b.exited_at) - new Date(a.exited_at));
  return { requested, exiting, done };
}

function updateFifoHeroStats(data) {
  const { requested, exiting, done } = collectFifoLanes(data);
  const setCount = (id, n) => {
    const el = $(id);
    if (el) el.textContent = String(n);
  };
  setCount("fifo-count-requested", requested.length);
  setCount("fifo-count-exiting", exiting.length);
  setCount("fifo-count-done", done.length);
  const updatedEl = $("fifo-stat-updated");
  if (updatedEl) {
    updatedEl.textContent = `آخر تحديث: ${new Date().toLocaleTimeString("ar-SY", {
      timeZone: DAMASCUS_TZ,
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  }
}

async function refreshFifoDashboard() {
  const host = $("fifo-queues-host");
  if (!host) return;
  host.classList.add("fifo-loading");
  const q = ($("fifo-search")?.value || "").trim();
  const params = q ? `?q=${encodeURIComponent(q)}` : "";
  try {
    const data = await api(`/api/fifo/dashboard${params}`);
    fifoDashboardCache = data;
    updateFifoHeroStats(data);
    renderFifoQueues(data);
    renderFifoAdminExport(data);
  } finally {
    host.classList.remove("fifo-loading");
  }
}

function renderFifoAdminExport(data) {
  const section = $("fifo-admin-export");
  const tbody = $("fifo-admin-export-body");
  if (!section || !tbody) return;
  const isAdmin = currentRole === "admin";
  section.classList.toggle("hidden", !isAdmin);
  if (!isAdmin) return;
  const queues = (data?.queues || []).filter((q) => (q.waiting_count || 0) > 0);
  if (!queues.length) {
    tbody.innerHTML =
      '<tr><td colspan="4" class="muted fifo-admin-empty">لا توجد مركبات في الطوابير حاليًا.</td></tr>';
    return;
  }
  tbody.innerHTML = queues
    .map((q) => {
      const type = q.truck_type || "";
      const max = q.waiting_count || 0;
      return `<tr>
        <td>${escapeHtml(type)}</td>
        <td>${escapeHtml(String(max))}</td>
        <td>
          <input
            type="number"
            class="checkin-detail-input fifo-admin-limit-input"
            min="1"
            max="10000"
            value="${max}"
            data-waiting="${max}"
            data-truck-type="${escapeHtml(type)}"
            aria-label="عدد ${escapeHtml(type)}"
          />
        </td>
        <td>
          <button type="button" class="btn btn-sm fifo-admin-export-one" data-truck-type="${escapeHtml(type)}">
            تنزيل صورة
          </button>
        </td>
      </tr>`;
    })
    .join("");
}

function collectFifoExportLimits({ capToWaiting = true } = {}) {
  const limits = {};
  document.querySelectorAll(".fifo-admin-limit-input").forEach((inp) => {
    const t = inp.getAttribute("data-truck-type") || "";
    const max = parseInt(inp.getAttribute("data-waiting") || inp.getAttribute("max") || "0", 10);
    let v = parseInt(inp.value, 10);
    if (!t || !Number.isFinite(v) || v <= 0) return;
    if (capToWaiting && Number.isFinite(max) && max > 0) v = Math.min(v, max);
    limits[t] = v;
  });
  return limits;
}

async function releaseFifoForExport(limits) {
  return api("/api/admin/fifo/release", {
    method: "POST",
    body: JSON.stringify({ limits }),
  });
}

async function applyFifoReleaseFromForm(triggerBtn = null) {
  const limits = collectFifoExportLimits({ capToWaiting: false });
  if (!Object.keys(limits).length) {
    alert("أدخل عددًا صالحًا أكبر من صفر في عمود «العدد المطلوب».");
    return;
  }
  const msgEl = $("fifo-admin-export-msg");
  const btn = triggerBtn || $("fifo-admin-release");
  const prevText = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "جارٍ التحرير…";
  }
  if (msgEl) msgEl.textContent = "";
  try {
    const data = await releaseFifoForExport(limits);
    const parts = Object.entries(data.released || {}).map(([t, n]) => `${t}: ${n}`);
    if (msgEl) {
      msgEl.textContent = parts.length
        ? `تم التحديث: ${parts.join("؛ ")} — راجع أعمدة تم الطلب / قيد الخروج.`
        : "تم.";
    }
    if (!$("view-fifo").classList.contains("hidden")) await refreshFifoDashboard();
  } finally {
    if (btn) {
      btn.disabled = false;
      if (prevText != null) btn.textContent = prevText;
    }
  }
}

function fifoQueueStatusLabel(it) {
  if (it.queue_status === "ready_exit") {
    return it.is_current_turn ? "قيد الخروج (الأول)" : "قيد الخروج";
  }
  return "في الانتظار";
}

function fifoExportStatusLabel(it) {
  return fifoQueueStatusLabel(it);
}

function sliceFifoQueuesForExport(queues, truckType, limit) {
  let list = queues || [];
  if (truckType) {
    list = list.filter((q) => q.truck_type === truckType);
  }
  if (!limit || limit <= 0) return list;
  return list.map((q) => ({
    ...q,
    items: (q.items || []).slice(0, limit),
    waiting_count: Math.min(q.waiting_count || 0, limit),
  }));
}

function buildFifoQueuesFromLimits(allQueues, limits) {
  const byType = new Map((allQueues || []).map((q) => [q.truck_type, q]));
  const out = [];
  for (const [type, lim] of Object.entries(limits)) {
    const q = byType.get(type);
    if (!q || !(q.items || []).length) continue;
    out.push(...sliceFifoQueuesForExport([q], null, lim));
  }
  return out;
}

const FIFO_EXPORT_COLUMNS = [
  { label: "رقم الدور", cellClass: "fifo-export-num" },
  { label: "اللوحة", cellClass: "fifo-export-plate" },
  { label: "السائق", cellClass: "" },
  { label: "الشركة", cellClass: "" },
  { label: "النوع", cellClass: "" },
  { label: "الحالة", cellClass: "" },
];

function createFifoExportHeaderRow() {
  const tr = document.createElement("tr");
  tr.className = "fifo-export-head-row";
  for (const col of FIFO_EXPORT_COLUMNS) {
    const td = document.createElement("td");
    td.className = `fifo-export-th${col.cellClass ? ` ${col.cellClass}` : ""}`;
    td.setAttribute("dir", "rtl");
    td.textContent = col.label;
    tr.appendChild(td);
  }
  return tr;
}

function prepareFifoExportCloneForCapture(clonedDoc) {
  clonedDoc.querySelectorAll(".fifo-export-sheet, .fifo-export-table").forEach((el) => {
    el.setAttribute("dir", "rtl");
  });
  clonedDoc.querySelectorAll(".fifo-export-th, .fifo-export-head-row td").forEach((el) => {
    el.setAttribute("dir", "rtl");
    el.style.direction = "rtl";
    el.style.unicodeBidi = "isolate";
    el.style.textAlign = "right";
  });
}

function buildFifoExportElement(queues, title) {
  const root = document.createElement("div");
  root.className = "fifo-export-sheet";
  root.setAttribute("dir", "rtl");
  const exportedAt = new Date().toLocaleString("ar-SY", {
    timeZone: DAMASCUS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  root.innerHTML = `
    <header class="fifo-export-header">
      <h1>${escapeHtml(title)}</h1>
      <p class="fifo-export-meta">تاريخ التصدير: ${escapeHtml(exportedAt)} (دمشق)</p>
    </header>`;

  if (!queues.length) {
    const p = document.createElement("p");
    p.className = "fifo-export-empty";
    p.textContent = "لا توجد مركبات في الطابور المطلوب.";
    root.appendChild(p);
    return root;
  }

  for (const q of queues) {
    const section = document.createElement("section");
    section.className = "fifo-export-queue";
    const allowed =
      q.current_allowed_queue_number != null ? String(q.current_allowed_queue_number) : "—";
    const waiting = q.waiting_count ?? (q.items || []).length;
    section.innerHTML = `<h2 class="fifo-export-queue-title">نوع الشاحنة: ${escapeHtml(q.truck_type || "—")} | منتظر: ${escapeHtml(String(waiting))} | الدور المسموح: ${escapeHtml(allowed)}</h2>`;

    const items = q.items || [];
    if (!items.length) {
      const p = document.createElement("p");
      p.className = "fifo-export-empty";
      p.textContent = "لا توجد مركبات في هذا الطابور.";
      section.appendChild(p);
    } else {
      const rows = items
        .map((it) => {
          const turn = it.queue_status === "ready_exit";
          const status = fifoExportStatusLabel(it);
          return `<tr class="${turn ? "fifo-export-row-turn" : ""}">
            <td class="fifo-export-num">${escapeHtml(String(it.fifo_queue_number ?? "—"))}</td>
            <td class="fifo-export-plate">${escapeHtml(it.license_plate || "—")}</td>
            <td>${escapeHtml(it.driver_name || "—")}</td>
            <td>${escapeHtml(it.partnership_company || "—")}</td>
            <td>${escapeHtml(it.fifo_truck_type || q.truck_type || "—")}</td>
            <td>${escapeHtml(status)}</td>
          </tr>`;
        })
        .join("");
      const table = document.createElement("table");
      table.className = "fifo-export-table";
      table.setAttribute("dir", "rtl");
      const tbody = document.createElement("tbody");
      tbody.appendChild(createFifoExportHeaderRow());
      tbody.insertAdjacentHTML("beforeend", rows);
      table.appendChild(tbody);
      section.appendChild(table);
    }
    root.appendChild(section);
  }
  return root;
}

async function captureFifoExportPng(element) {
  if (typeof html2canvas === "undefined") {
    throw new Error("تعذّر تحميل أداة التصدير. تحقق من الاتصال وأعد تحميل الصفحة.");
  }
  if (document.fonts?.ready) await document.fonts.ready;
  const bg =
    getComputedStyle(document.documentElement).getPropertyValue("--bg-elevated").trim() ||
    "#0f141c";
  const canvas = await html2canvas(element, {
    scale: 2,
    useCORS: true,
    logging: false,
    backgroundColor: bg,
    onclone: prepareFifoExportCloneForCapture,
  });
  return canvas;
}

function triggerPngDownload(canvas, filename) {
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = filename.endsWith(".png") ? filename : `${filename}.png`;
  a.click();
}

async function fetchFifoQueuesForExport() {
  const data = await api("/api/fifo/dashboard");
  return data.queues || [];
}

async function downloadFifoImage(truckType, triggerBtn = null, { limit = null, limits = null } = {}) {
  const exportBtn = triggerBtn || $("fifo-export-all-image");
  const prevHtml = exportBtn?.innerHTML;
  const prevText = exportBtn?.textContent;
  const msgEl = $("fifo-admin-export-msg");
  if (exportBtn) {
    exportBtn.disabled = true;
    if (triggerBtn && !exportBtn.querySelector(".fifo-btn-label")) {
      exportBtn.textContent = "…";
    } else if (!triggerBtn) {
      exportBtn.innerHTML = '<span class="fifo-btn-label">جارٍ التصدير…</span>';
    }
  }
  if (msgEl) msgEl.textContent = "";
  let host = null;
  try {
    const allQueues = await fetchFifoQueuesForExport();
    let queues;
    let title;
    if (limits && Object.keys(limits).length) {
      queues = buildFifoQueuesFromLimits(allQueues, limits);
      title = "أدوار الخروج — أنواع محددة";
    } else if (truckType) {
      queues = sliceFifoQueuesForExport(allQueues, truckType, limit);
      title =
        limit && queues[0]
          ? `أدوار الخروج — ${truckType} (أول ${queues[0].items?.length || limit})`
          : `أدوار الخروج — ${truckType}`;
    } else {
      queues = allQueues;
      title = "أدوار الخروج — جميع الأنواع";
    }
    if (!queues.length) {
      throw new Error("لا توجد مركبات في الطابور المطلوب.");
    }
    const sheet = buildFifoExportElement(queues, title);
    host = document.createElement("div");
    host.className = "fifo-export-capture-host";
    host.appendChild(sheet);
    document.body.appendChild(host);
    const canvas = await captureFifoExportPng(sheet);
    const slug = truckType
      ? String(truckType).replace(/[^\w\u0600-\u06FF-]+/g, "_")
      : limits
        ? "selected"
        : "all";
    const suffix = limit ? `-first-${limit}` : "";
    triggerPngDownload(canvas, `fifo-${slug}${suffix}.png`);
    if (msgEl) msgEl.textContent = "تم تنزيل الصورة.";
  } finally {
    if (host?.parentNode) host.parentNode.removeChild(host);
    if (exportBtn) {
      exportBtn.disabled = false;
      if (prevHtml != null && exportBtn.querySelector(".fifo-btn-label")) {
        exportBtn.innerHTML = prevHtml;
      } else if (prevText != null) {
        exportBtn.textContent = prevText;
      }
    }
  }
}

async function downloadAdminFifoExport(truckType, limit, triggerBtn = null) {
  await releaseFifoForExport({ [truckType]: limit });
  if (!$("view-fifo").classList.contains("hidden")) await refreshFifoDashboard();
  const waiting = fifoDashboardCache?.queues?.find((q) => q.truck_type === truckType)?.waiting_count;
  const imageLimit =
    Number.isFinite(waiting) && waiting > 0 ? Math.min(limit, waiting) : limit;
  return downloadFifoImage(truckType, triggerBtn, { limit: imageLimit });
}

async function downloadAdminFifoBatchImages(triggerBtn = null) {
  const limits = collectFifoExportLimits({ capToWaiting: false });
  const types = Object.keys(limits);
  if (!types.length) {
    alert("حدّد عددًا واحدًا على الأقل في الجدول.");
    return;
  }
  await releaseFifoForExport(limits);
  if (!$("view-fifo").classList.contains("hidden")) await refreshFifoDashboard();
  const imageLimits = collectFifoExportLimits({ capToWaiting: true });
  return downloadFifoImage(null, triggerBtn || $("fifo-admin-export-batch"), {
    limits: imageLimits,
  });
}

function renderFifoQueues(data) {
  const host = $("fifo-queues-host");
  if (!host) return;
  const queues = data.queues || [];
  if (!queues.length) {
    host.innerHTML = `
      <div class="fifo-empty-state">
        <div class="fifo-empty-icon" aria-hidden="true">⏳</div>
        <p class="fifo-empty-title">لا توجد مركبات في الطوابير</p>
        <p class="muted fifo-empty-hint">عند دخول شاحنة يظهر دورها هنا تلقائيًا حسب نوعها.</p>
      </div>`;
    return;
  }
  host.innerHTML = `<div class="fifo-grid">${queues.map(renderFifoTypeCard).join("")}</div>`;
  host.querySelectorAll(".fifo-export-type").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = btn.getAttribute("data-truck-type") || "";
      downloadFifoImage(t, btn).catch((e) => alert(e.message));
    });
  });
}

function renderFifoTypeCard(q) {
  const allowed =
    q.current_allowed_queue_number != null ? String(q.current_allowed_queue_number) : "—";
  const items = q.items || [];
  const listHtml = items.length
    ? items.map((it) => renderFifoQueueItem(it)).join("")
    : '<p class="muted fifo-no-results">لا نتائج مطابقة للبحث</p>';
  return `
    <article class="fifo-card">
      <header class="fifo-card-header">
        <div class="fifo-card-title-wrap">
          <span class="fifo-card-badge">${escapeHtml(q.truck_type)}</span>
          <h3 class="fifo-card-title">طابور ${escapeHtml(q.truck_type)}</h3>
        </div>
        <button type="button" class="btn btn-sm-pad btn-ghost fifo-export-type" data-truck-type="${escapeHtml(q.truck_type)}" title="تنزيل صورة">صورة</button>
      </header>
      <div class="fifo-card-metrics">
        <div class="fifo-metric">
          <span class="fifo-metric-label">في الانتظار</span>
          <span class="fifo-metric-value">${escapeHtml(String(q.waiting_in_queue_count ?? 0))}</span>
        </div>
        <div class="fifo-metric fifo-metric-highlight">
          <span class="fifo-metric-label">قيد الخروج</span>
          <span class="fifo-metric-value fifo-allowed-num">${escapeHtml(String(q.ready_exit_count ?? 0))}</span>
        </div>
        <div class="fifo-metric">
          <span class="fifo-metric-label">أول قيد الخروج</span>
          <span class="fifo-metric-value">${escapeHtml(allowed)}</span>
        </div>
      </div>
      <ol class="fifo-queue-list">${listHtml}</ol>
    </article>`;
}

function renderFifoQueueItem(it) {
  const ready = it.queue_status === "ready_exit";
  const statusClass = ready ? "fifo-queue-item-current" : "fifo-queue-item-wait";
  const statusLabel = fifoQueueStatusLabel(it);
  return `
    <li class="fifo-queue-item ${statusClass}">
      <div class="fifo-queue-num">${escapeHtml(String(it.fifo_queue_number))}</div>
      <div class="fifo-queue-body">
        <div class="fifo-queue-row-top">
          <span class="fifo-queue-plate" dir="ltr">${escapeHtml(it.license_plate)}</span>
          <span class="fifo-queue-status">${escapeHtml(statusLabel)}</span>
        </div>
        <div class="fifo-queue-meta">
          <span>${escapeHtml(it.driver_name || "—")}</span>
          <span class="fifo-queue-dot">·</span>
          <span>${escapeHtml(it.partnership_company || "—")}</span>
        </div>
        <time class="fifo-queue-time">${escapeHtml(formatDamascusDateTime(it.entered_at))}</time>
      </div>
    </li>`;
}

async function processVehicleScan(raw) {
  const token = extractScanToken(raw);
  if (!token) {
    alert("لم يُستخرج رمز صالح من المسح.");
    return;
  }
  if (!canCheckIn && !canCheckOut) {
    openMessageModal("غير مسموح", "لا تملك صلاحية مسح بطاقات المركبات.", true);
    return;
  }
  try {
    window.ParkingPos?.markWantResume();
    await stopVehicleQrScanner();
    const data = await api(`/api/employee/vehicle-scan/${encodeURIComponent(token)}`);
    await showVehicleFlowFromScan(token, data);
  } catch (e) {
    if (e.status === 403) {
      openMessageModal("مسح غير مسموح", e.message, true);
    } else {
      alert(e.message);
    }
  }
}

async function stopVehicleQrScanner() {
  window.ParkingPos?.stopNativeCamera();
  if (html5QrScanner) {
    try {
      await html5QrScanner.stop();
      html5QrScanner.clear();
    } catch {
      /* ignore */
    }
    html5QrScanner = null;
  }
  window.__parkingQrActive = false;
  $("vehicle-qr-start")?.classList.remove("hidden");
  $("vehicle-qr-stop")?.classList.add("hidden");
}

function getSelectedQrCameraConfig() {
  const cameraId = ($("vehicle-qr-camera")?.value || "").trim();
  if (cameraId) return cameraId;
  return { facingMode: "environment" };
}

async function populateVehicleQrCameras() {
  const sel = $("vehicle-qr-camera");
  if (!sel || typeof Html5Qrcode === "undefined") return;
  const saved = localStorage.getItem(QR_CAMERA_STORAGE_KEY) || "";
  try {
    const cameras = await Html5Qrcode.getCameras();
    sel.innerHTML = "";
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "الكاميرا الافتراضية (خلفية)";
    sel.appendChild(defaultOpt);
    cameras.forEach((cam, i) => {
      const opt = document.createElement("option");
      opt.value = cam.id;
      opt.textContent = cam.label || `كاميرا ${i + 1}`;
      sel.appendChild(opt);
    });
    if (saved && [...sel.options].some((o) => o.value === saved)) {
      sel.value = saved;
    }
  } catch {
    sel.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "الكاميرا الافتراضية (خلفية)";
    sel.appendChild(opt);
  }
}

async function startVehicleQrScanner() {
  if (!canCheckIn && !canCheckOut) {
    openMessageModal("غير مسموح", "لا تملك صلاحية تشغيل ماسح QR.", true);
    return;
  }
  const hostId = "vehicle-qr-reader-host";
  await stopVehicleQrScanner();
  window.__parkingQrActive = true;
  $("vehicle-qr-start")?.classList.add("hidden");
  $("vehicle-qr-stop")?.classList.remove("hidden");
  try {
    if (window.ParkingPos?.nativeDetectorAvailable()) {
      try {
        await window.ParkingPos.startNativeCameraScan(hostId);
        window.ParkingPos.setWantResume(true);
        return;
      } catch {
        window.ParkingPos.stopNativeCamera();
      }
    }
    if (typeof Html5Qrcode === "undefined") {
      throw new Error("مكتبة مسح QR غير محمّلة.");
    }
    const reader = new Html5Qrcode(hostId);
    html5QrScanner = reader;
    await reader.start(
      getSelectedQrCameraConfig(),
      {
        fps: 20,
        disableFlip: false,
        qrbox: (viewfinderWidth, viewfinderHeight) => {
          const edge = Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.82);
          const size = Math.max(180, edge);
          return { width: size, height: size };
        },
        videoConstraints: getSelectedQrCameraConfig(),
      },
      (decodedText) => {
        if (window.ParkingPos) window.ParkingPos.handleDecodedScan(decodedText);
        else processVehicleScan(decodedText).catch((err) => alert(err.message));
      },
      () => {}
    );
    window.ParkingPos?.setWantResume(true);
    window.ParkingPos?.requestWakeLock();
  } catch (e) {
    html5QrScanner = null;
    window.ParkingPos?.stopNativeCamera();
    window.__parkingQrActive = false;
    $("vehicle-qr-start")?.classList.remove("hidden");
    $("vehicle-qr-stop")?.classList.add("hidden");
    throw e;
  }
}

function wireVehicleFlowModal() {
  $("vehicle-flow-cancel").addEventListener("click", () => {
    closeVehicleFlowModal();
  });
  $("vehicle-flow-modal-close").addEventListener("click", () => {
    closeVehicleFlowModal();
  });
  $("vehicle-flow-modal-backdrop").addEventListener("click", () => {
    closeVehicleFlowModal();
  });
  $("vehicle-flow-primary").addEventListener("click", () => {
    if (typeof vehicleFlowPrimaryHandler === "function") {
      vehicleFlowPrimaryHandler();
    }
  });
}

function wireVehicleScanDesk() {
  populateVehicleQrCameras().catch(() => {});
  $("vehicle-qr-camera")?.addEventListener("change", () => {
    const id = ($("vehicle-qr-camera")?.value || "").trim();
    if (id) localStorage.setItem(QR_CAMERA_STORAGE_KEY, id);
    else localStorage.removeItem(QR_CAMERA_STORAGE_KEY);
    if (window.__parkingQrActive) {
      stopVehicleQrScanner()
        .then(() => startVehicleQrScanner())
        .catch((e) => alert(e.message));
    }
  });
  $("vehicle-qr-start")?.addEventListener("click", () => {
    startVehicleQrScanner().catch((e) =>
      alert(e.message || "تعذّر تشغيل الكاميرا. جرّب اختيار كاميرا أخرى.")
    );
  });
  $("vehicle-qr-stop")?.addEventListener("click", () => {
    window.ParkingPos?.setWantResume(false);
    stopVehicleQrScanner().catch(() => {});
  });
  const link = $("driver-register-link");
  if (link) link.href = `${window.location.origin}/CarRegistration`;
  $("copy-driver-link")?.addEventListener("click", async () => {
    const url = `${window.location.origin}/CarRegistration`;
    try {
      await navigator.clipboard.writeText(url);
      alert("تم نسخ الرابط.");
    } catch {
      alert(url);
    }
  });
}

function resolveProfileForReceipt(session) {
  if (!session) return null;
  const profileId = session.profile_id;
  if (profileId != null) {
    const cached = vehicleProfileListCache.find((x) => x.id === profileId);
    if (cached) return cached;
    const token = String(session.public_token || "").trim();
    if (token) {
      return {
        id: profileId,
        public_token: token,
        license_plate: session.license_plate || "",
        vehicle_make: session.vehicle_make ?? null,
        vehicle_type: session.vehicle_type ?? null,
        vehicle_color: session.vehicle_color ?? null,
        driver_name: session.driver_name ?? null,
        owner_name: session.owner_name ?? null,
        partnership_company: session.partnership_company ?? null,
        mechanical_number: session.mechanical_number || "",
        registration_order: session.registration_order ?? null,
        qr_payload: session.qr_payload || token,
        has_photo: false,
      };
    }
  }
  const plate = String(session.license_plate || "").trim();
  if (plate) {
    const byPlate = vehicleProfileListCache.find(
      (x) => (x.license_plate || "").toLowerCase() === plate.toLowerCase()
    );
    if (byPlate) return byPlate;
  }
  return null;
}

function syncReceiptCardButton() {
  const btn = $("receipt-modal-card");
  if (!btn) return;
  const show = !!receiptModalProfileRef;
  btn.classList.toggle("hidden", !show);
}

function goToVehicleCardFromReceipt() {
  if (!receiptModalProfileRef) {
    alert("لا يوجد بروفايل مركبة مرتبط بهذا الإيصال.");
    return;
  }
  const profile = receiptModalProfileRef;
  closeReceiptModal();
  openVehicleCardModal(profile);
}

function clearThermalPrintMode() {
  document.body.classList.remove("print-receipt-slip", "print-checkout-slip");
}

function runBrowserPrint(mode) {
  window.ParkingPos?.applyPaperClass();
  clearThermalPrintMode();
  document.body.classList.add(
    mode === "checkout" ? "print-checkout-slip" : "print-receipt-slip"
  );
  const cleanup = () => clearThermalPrintMode();
  window.addEventListener("afterprint", cleanup, { once: true });
  setTimeout(cleanup, 4000);
  window.print();
}

function printThermalSlip(mode) {
  if (window.ParkingPos) {
    window.ParkingPos.printThermal(mode, runBrowserPrint);
    return;
  }
  runBrowserPrint(mode);
}

function openReceiptModal(session) {
  if (!checkoutModalIsHidden()) closeCheckoutResultModal();
  if (!messageModalIsHidden()) closeMessageModal();
  if (!vehicleFlowModalIsHidden()) closeVehicleFlowModal();
  if (!vehicleCardModalIsHidden()) closeVehicleCardModal();
  receiptModalProfileRef = resolveProfileForReceipt(session);
  const modal = $("receipt-modal");
  const body = $("receipt-modal-body");
  body.innerHTML = buildReceiptSlipHtml(session);
  modal.classList.remove("hidden");
  modal.removeAttribute("hidden");
  document.body.classList.add("modal-open");
  renderReceiptQr(session.receipt_code);
  syncReceiptCardButton();
  $("receipt-modal-close").focus();
  window.ParkingPos?.maybeAutoPrint("receipt", runBrowserPrint);
}

function closeReceiptModal() {
  const modal = $("receipt-modal");
  modal.classList.add("hidden");
  modal.setAttribute("hidden", "");
  $("receipt-modal-body").innerHTML = "";
  receiptModalProfileRef = null;
  syncReceiptCardButton();
  if (
    checkoutModalIsHidden() &&
    messageModalIsHidden() &&
    vehicleFlowModalIsHidden() &&
    vehicleCardModalIsHidden()
  ) {
    document.body.classList.remove("modal-open");
  }
  window.ParkingPos?.maybeResumeCamera();
}

function checkoutModalIsHidden() {
  const m = $("checkout-result-modal");
  return m.classList.contains("hidden") || m.hasAttribute("hidden");
}

function messageModalIsHidden() {
  const m = $("message-modal");
  return m.classList.contains("hidden") || m.hasAttribute("hidden");
}

function closeMessageModal() {
  const modal = $("message-modal");
  modal.classList.add("hidden");
  modal.setAttribute("hidden", "");
  if (
    checkoutModalIsHidden() &&
    modalIsHidden() &&
    vehicleFlowModalIsHidden() &&
    vehicleCardModalIsHidden()
  ) {
    document.body.classList.remove("modal-open");
  }
}

function openMessageModal(title, message, asHtml = false) {
  if (!checkoutModalIsHidden()) closeCheckoutResultModal();
  if (!modalIsHidden()) closeReceiptModal();
  if (!vehicleFlowModalIsHidden()) closeVehicleFlowModal();
  if (!vehicleCardModalIsHidden()) closeVehicleCardModal();
  $("message-modal-title").textContent = title;
  const bodyEl = $("message-modal-body");
  if (asHtml) bodyEl.innerHTML = message;
  else bodyEl.textContent = message;
  const modal = $("message-modal");
  modal.classList.remove("hidden");
  modal.removeAttribute("hidden");
  document.body.classList.add("modal-open");
  $("message-modal-dismiss").focus();
}

function wireMessageModal() {
  $("message-modal-close").addEventListener("click", closeMessageModal);
  $("message-modal-dismiss").addEventListener("click", closeMessageModal);
  $("message-modal-backdrop").addEventListener("click", closeMessageModal);
}

function openCheckoutResultModal(data) {
  if (!modalIsHidden()) closeReceiptModal();
  if (!messageModalIsHidden()) closeMessageModal();
  if (!vehicleFlowModalIsHidden()) closeVehicleFlowModal();
  if (!vehicleCardModalIsHidden()) closeVehicleCardModal();
  const modal = $("checkout-result-modal");
  $("checkout-result-modal-body").innerHTML = buildCheckoutResultHtml(data);
  modal.classList.remove("hidden");
  modal.removeAttribute("hidden");
  document.body.classList.add("modal-open");
  $("checkout-result-modal-dismiss").focus();
}

function closeCheckoutResultModal() {
  const modal = $("checkout-result-modal");
  modal.classList.add("hidden");
  modal.setAttribute("hidden", "");
  $("checkout-result-modal-body").innerHTML = "";
  if (
    modalIsHidden() &&
    messageModalIsHidden() &&
    vehicleFlowModalIsHidden() &&
    vehicleCardModalIsHidden()
  ) {
    document.body.classList.remove("modal-open");
  }
}

function wireCheckoutResultModal() {
  $("checkout-result-modal-close").addEventListener("click", closeCheckoutResultModal);
  $("checkout-result-modal-dismiss").addEventListener("click", closeCheckoutResultModal);
  $("checkout-result-modal-backdrop").addEventListener("click", closeCheckoutResultModal);
  $("checkout-result-modal-print")?.addEventListener("click", () =>
    printThermalSlip("checkout")
  );
}

function wireReceiptModal() {
  const printBtn = $("receipt-modal-print");
  const cardBtn = $("receipt-modal-card");
  const dismiss = $("receipt-modal-dismiss");
  const close = $("receipt-modal-close");
  const backdrop = $("receipt-modal-backdrop");
  printBtn.addEventListener("click", () => printThermalSlip("receipt"));
  cardBtn?.addEventListener("click", goToVehicleCardFromReceipt);
  dismiss.addEventListener("click", closeReceiptModal);
  close.addEventListener("click", closeReceiptModal);
  backdrop.addEventListener("click", closeReceiptModal);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!vehicleCardModalIsHidden()) {
      closeVehicleCardModal();
      return;
    }
    if (!vehicleFlowModalIsHidden()) {
      closeVehicleFlowModal();
      return;
    }
    if (!messageModalIsHidden()) {
      closeMessageModal();
      return;
    }
    if (!checkoutModalIsHidden()) {
      closeCheckoutResultModal();
      return;
    }
    if (!modalIsHidden()) closeReceiptModal();
  });
}

function modalIsHidden() {
  const m = $("receipt-modal");
  return m.classList.contains("hidden") || m.hasAttribute("hidden");
}

function setView(name) {
  if (name === "settings" && currentRole !== "admin") {
    name = "desk";
  }
  if (name === "stats" && currentRole !== "admin") {
    name = "desk";
  }
  const desk = $("view-desk");
  const tickets = $("view-tickets");
  const profiles = $("view-profiles");
  const fifo = $("view-fifo");
  const stats = $("view-stats");
  const settings = $("view-settings");
  const tabDesk = $("nav-desk");
  const tabTickets = $("nav-tickets");
  const tabProfiles = $("nav-profiles");
  const tabFifo = $("nav-fifo");
  const tabStats = $("nav-stats");
  const tabSettings = $("nav-settings");

  if (!desk || !tickets || !profiles || !fifo || !stats || !settings) return;
  if (!tabDesk || !tabTickets || !tabProfiles || !tabFifo || !tabStats || !tabSettings) return;

  const isDesk = name === "desk";
  const isTickets = name === "tickets";
  const isProfiles = name === "profiles";
  const isFifo = name === "fifo";
  const isStats = name === "stats";
  const isSettings = name === "settings";

  desk.classList.toggle("hidden", !isDesk);
  desk.toggleAttribute("hidden", !isDesk);
  tickets.classList.toggle("hidden", !isTickets);
  tickets.toggleAttribute("hidden", !isTickets);
  profiles.classList.toggle("hidden", !isProfiles);
  profiles.toggleAttribute("hidden", !isProfiles);
  fifo.classList.toggle("hidden", !isFifo);
  fifo.toggleAttribute("hidden", !isFifo);
  stats.classList.toggle("hidden", !isStats);
  stats.toggleAttribute("hidden", !isStats);
  settings.classList.toggle("hidden", !isSettings);
  settings.toggleAttribute("hidden", !isSettings);

  tabDesk.classList.toggle("active", isDesk);
  tabTickets.classList.toggle("active", isTickets);
  tabProfiles.classList.toggle("active", isProfiles);
  tabFifo.classList.toggle("active", isFifo);
  tabStats.classList.toggle("active", isStats);
  tabSettings.classList.toggle("active", isSettings);

  if (isDesk) {
    refreshDeskData().catch((e) => alert(e.message));
  } else if (isTickets) {
    refreshTickets().catch((e) => alert(e.message));
  } else if (isProfiles) {
    refreshVehicleProfiles().catch((e) => alert(e.message));
  } else if (isFifo) {
    refreshFifoDashboard().catch((e) => alert(e.message));
  } else if (isStats) {
    if (!$("stats-month").value) {
      $("stats-month").value = new Date()
        .toLocaleDateString("sv-SE", { timeZone: DAMASCUS_TZ })
        .slice(0, 7);
    }
    refreshMonthStats().catch((e) => alert(e.message));
  } else if (isSettings) {
    refreshDeskData()
      .then(() => loadAdminUsersForPassword())
      .catch((e) => alert(e.message));
  }
}

function wireNav() {
  $("nav-desk").addEventListener("click", () => setView("desk"));
  $("nav-tickets").addEventListener("click", () => setView("tickets"));
  $("nav-profiles")?.addEventListener("click", () => setView("profiles"));
  $("nav-fifo")?.addEventListener("click", () => setView("fifo"));
  $("nav-stats").addEventListener("click", () => setView("stats"));
  $("fifo-refresh")?.addEventListener("click", () => {
    refreshFifoDashboard().catch((e) => alert(e.message));
  });
  $("fifo-export-all-image")?.addEventListener("click", () => {
    downloadFifoImage("").catch((e) => alert(e.message));
  });
  $("fifo-admin-release")?.addEventListener("click", (e) => {
    applyFifoReleaseFromForm(e.currentTarget).catch((err) => alert(err.message));
  });
  $("fifo-admin-export-batch")?.addEventListener("click", (e) => {
    downloadAdminFifoBatchImages(e.currentTarget).catch((err) => alert(err.message));
  });
  $("fifo-admin-export-body")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".fifo-admin-export-one");
    if (!btn) return;
    const row = btn.closest("tr");
    const inp = row?.querySelector(".fifo-admin-limit-input");
    const truckType = btn.getAttribute("data-truck-type") || inp?.getAttribute("data-truck-type") || "";
    let limit = parseInt(inp?.value || "", 10);
    if (!truckType || !Number.isFinite(limit) || limit <= 0) {
      alert("أدخل عددًا صالحًا أكبر من صفر.");
      return;
    }
    downloadAdminFifoExport(truckType, limit, btn).catch((err) => alert(err.message));
  });
  let fifoSearchTimer = null;
  $("fifo-search")?.addEventListener("input", () => {
    clearTimeout(fifoSearchTimer);
    fifoSearchTimer = setTimeout(() => {
      refreshFifoDashboard().catch((e) => alert(e.message));
    }, 300);
  });
  $("nav-settings").addEventListener("click", () => setView("settings"));
  $("tickets-refresh").addEventListener("click", () => {
    refreshTickets().catch((e) => alert(e.message));
  });
  $("profiles-refresh")?.addEventListener("click", () => {
    profilesFilterOptions = null;
    refreshVehicleProfiles().catch((e) => alert(e.message));
  });
  $("stats-refresh").addEventListener("click", () => {
    refreshMonthStats().catch((e) => alert(e.message));
  });
  $("stats-month").addEventListener("change", () => {
    refreshMonthStats().catch((e) => alert(e.message));
  });
  $("stats-export-xlsx").addEventListener("click", () => {
    downloadMonthStatsExcel().catch((e) => alert(e.message));
  });
  $("tickets-body").addEventListener("click", onTicketsTableClick);
  $("profiles-body")?.addEventListener("click", onProfilesTableClick);
  let profilesSearchTimer = null;
  $("profiles-search")?.addEventListener("input", (e) => {
    profilesSearchQuery = e.target.value || "";
    profilesPage = 1;
    clearTimeout(profilesSearchTimer);
    profilesSearchTimer = setTimeout(() => {
      refreshVehicleProfiles().catch((err) => alert(err.message));
    }, 300);
  });
  const onFilterChange = () => {
    profilesFilters = {
      vehicle_type: $("profiles-filter-type")?.value || "",
      partnership_company: $("profiles-filter-company")?.value || "",
      has_photo: $("profiles-filter-photo")?.value || "",
    };
    profilesPage = 1;
    refreshVehicleProfiles().catch((err) => alert(err.message));
  };
  $("profiles-filter-type")?.addEventListener("change", onFilterChange);
  $("profiles-filter-company")?.addEventListener("change", onFilterChange);
  $("profiles-filter-photo")?.addEventListener("change", onFilterChange);
  $("profiles-bulk-card-type")?.addEventListener("focus", () => {
    loadProfilesFilterMeta().catch((err) => alert(err.message));
  });
  $("profiles-bulk-card-download")?.addEventListener("click", (e) => {
    const btn = e.currentTarget;
    const prevText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "جارٍ التجهيز…";
    downloadVehicleCardsZipByType(
      $("profiles-bulk-card-type")?.value || "",
      $("profiles-bulk-card-count")?.value || ""
    )
      .catch((err) => alert(err.message || "تعذّر تنزيل بطاقات المركبات."))
      .finally(() => {
        btn.disabled = false;
        btn.textContent = prevText;
      });
  });
  $("profiles-clear-filters")?.addEventListener("click", () => {
    profilesSearchQuery = "";
    profilesFilters = { vehicle_type: "", partnership_company: "", has_photo: "" };
    profilesPage = 1;
    const searchEl = $("profiles-search");
    if (searchEl) searchEl.value = "";
    const typeEl = $("profiles-filter-type");
    const companyEl = $("profiles-filter-company");
    const photoEl = $("profiles-filter-photo");
    if (typeEl) typeEl.value = "";
    if (companyEl) companyEl.value = "";
    if (photoEl) photoEl.value = "";
    refreshVehicleProfiles().catch((err) => alert(err.message));
  });
  $("profiles-prev")?.addEventListener("click", () => {
    if (profilesPage > 1) {
      profilesPage -= 1;
      refreshVehicleProfiles().catch((err) => alert(err.message));
    }
  });
  $("profiles-next")?.addEventListener("click", () => {
    if (profilesPage < profilesListMeta.total_pages) {
      profilesPage += 1;
      refreshVehicleProfiles().catch((err) => alert(err.message));
    }
  });
  $("btn-logout").addEventListener("click", () => {
    clearAuth();
    $("login-error").textContent = "";
    showLoginView();
  });
}

function onTicketsTableClick(e) {
  const copyBtn = e.target.closest(".copy-receipt-code");
  if (copyBtn) {
    e.preventDefault();
    const code = copyBtn.getAttribute("data-code") || "";
    if (!code) return;
    const label = copyBtn;
    const done = () => {
      const prev = label.textContent;
      label.textContent = "تم النسخ";
      setTimeout(() => {
        label.textContent = prev;
      }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(done).catch(() => {
        fallbackCopy(code, done);
      });
    } else {
      fallbackCopy(code, done);
    }
    return;
  }

  const previewBtn = e.target.closest(".preview-ticket");
  if (previewBtn) {
    const code = previewBtn.getAttribute("data-receipt") || "";
    const row = ticketLogCache.find(
      (x) => x.receipt_code.toLowerCase() === code.toLowerCase()
    );
    if (row) openReceiptModal(row);
    return;
  }

  const codeEl = e.target.closest(".ticket-code");
  if (codeEl) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(codeEl);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

function fallbackCopy(text, onOk) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand("copy");
    onOk();
  } catch {
    alert("تعذّر النسخ. انسخ الرمز يدويًا.");
  }
  document.body.removeChild(ta);
}

async function refreshMonthStats() {
  if (!$("stats-month").value) {
    $("stats-month").value = new Date()
      .toLocaleDateString("sv-SE", { timeZone: DAMASCUS_TZ })
      .slice(0, 7);
  }
  const v = $("stats-month").value;
  const [yStr, mStr] = v.split("-");
  const y = parseInt(yStr, 10);
  const m = parseInt(mStr, 10);
  const q = new URLSearchParams({ year: String(y), month: String(m) });
  const data = await api(`/api/stats/month?${q.toString()}`);
  const nf = new Intl.NumberFormat("ar-SY", { numberingSystem: "latn" });
  $("stats-total-entries").textContent = nf.format(data.total_entries);
  $("stats-total-count").textContent = nf.format(data.total_checkouts);
  $("stats-total-new").textContent = nf.format(data.total_revenue_syp_new);
  $("stats-total-old").textContent = nf.format(
    sypOldEquivalent(data.total_revenue_syp_new)
  );
  const tbody = $("stats-body");
  tbody.innerHTML = "";
  for (const row of data.days) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${nf.format(row.day)}</td>
      <td>${nf.format(row.entry_count)}</td>
      <td>${nf.format(row.checkout_count)}</td>
      <td>${nf.format(row.revenue_syp_new)}</td>
      <td>${nf.format(sypOldEquivalent(row.revenue_syp_new))}</td>`;
    tbody.appendChild(tr);
  }
}

async function downloadMonthStatsExcel() {
  if (!$("stats-month").value) {
    $("stats-month").value = new Date()
      .toLocaleDateString("sv-SE", { timeZone: DAMASCUS_TZ })
      .slice(0, 7);
  }
  const v = $("stats-month").value;
  const [yStr, mStr] = v.split("-");
  const y = parseInt(yStr, 10);
  const m = parseInt(mStr, 10);
  const t = getToken();
  if (!t) throw new Error("يجب تسجيل الدخول.");
  const url = `/api/stats/month/export?year=${encodeURIComponent(y)}&month=${encodeURIComponent(m)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${t}` } });
  if (res.status === 401) {
    clearAuth();
    showLoginView();
    throw new Error("انتهت الجلسة.");
  }
  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try {
      const j = JSON.parse(text);
      if (j.detail != null) {
        msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
      }
    } catch {
      /* ignore */
    }
    throw new Error(msg || "تعذّر تنزيل الملف.");
  }
  const blob = await res.blob();
  const a = document.createElement("a");
  const name = `parking-stats-${y}-${String(m).padStart(2, "0")}.xlsx`;
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function fillUserSelect(sel, users, prevValue) {
  if (!sel) return;
  sel.innerHTML = "";
  for (const u of users) {
    const opt = document.createElement("option");
    opt.value = u.username;
    opt.textContent = `${u.username} (${roleLabel(u.role)})`;
    sel.appendChild(opt);
  }
  if (prevValue && [...sel.options].some((o) => o.value === prevValue)) {
    sel.value = prevValue;
  } else if (currentUsername && [...sel.options].some((o) => o.value === currentUsername)) {
    sel.value = currentUsername;
  }
}

async function loadAdminUsersForPassword() {
  if (currentRole !== "admin") return;
  const selPw = $("admin-pw-user");
  const selRename = $("admin-rename-user");
  if (!selPw && !selRename) return;
  const users = await api("/api/admin/users");
  const prevPw = selPw ? selPw.value : "";
  const prevRn = selRename ? selRename.value : "";
  fillUserSelect(selPw, users, prevPw);
  fillUserSelect(selRename, users, prevRn);
}

function onProfilesTableClick(e) {
  const cardBtn = e.target.closest(".profile-row-card");
  if (cardBtn) {
    e.preventDefault();
    const id = parseInt(cardBtn.getAttribute("data-id") || "", 10);
    const row = vehicleProfileListCache.find((x) => x.id === id);
    if (row) openVehicleCardModal(row);
    return;
  }

  const scanRowBtn = e.target.closest(".profile-row-scan");
  if (scanRowBtn) {
    e.preventDefault();
    const t = scanRowBtn.getAttribute("data-token") || "";
    if (!t) return;
    processVehicleScan(t).catch((err) => alert(err.message));
    return;
  }

  const deleteBtn = e.target.closest(".profile-row-delete");
  if (deleteBtn) {
    e.preventDefault();
    const id = parseInt(deleteBtn.getAttribute("data-id") || "", 10);
    const row = vehicleProfileListCache.find((x) => x.id === id);
    if (row) deleteVehicleProfile(row).catch((err) => alert(err.message));
  }
}

function updateProfilesTotalStat() {
  const el = $("profiles-total");
  if (!el) return;
  const total = profilesFilterOptions?.total ?? profilesListMeta.total ?? 0;
  el.textContent = String(total);
}

function populateBulkCardTypeSelect(meta) {
  const sel = $("profiles-bulk-card-type");
  if (!sel) return;
  const previous = sel.value || profilesFilters.vehicle_type || "";
  const options = Array.isArray(meta?.vehicle_types) ? meta.vehicle_types : [];
  sel.innerHTML = '<option value="">اختر النوع</option>';
  for (const opt of options) {
    const value = String(opt.value || "").trim();
    if (!value) continue;
    const o = document.createElement("option");
    o.value = value;
    o.textContent = `${value} (${Number(opt.count) || 0})`;
    sel.appendChild(o);
  }
  if (previous && [...sel.options].some((o) => o.value === previous)) {
    sel.value = previous;
  }
}

function populateProfilesFilterSelects(meta) {
  const typeSel = $("profiles-filter-type");
  const companySel = $("profiles-filter-company");
  if (!typeSel || !companySel || !meta) return;
  const typeVal = profilesFilters.vehicle_type;
  const companyVal = profilesFilters.partnership_company;
  typeSel.innerHTML = '<option value="">الكل</option>';
  for (const opt of meta.vehicle_types || []) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = `${opt.value} (${opt.count})`;
    typeSel.appendChild(o);
  }
  typeSel.value = typeVal;
  populateBulkCardTypeSelect(meta);
  companySel.innerHTML = '<option value="">الكل</option>';
  for (const opt of meta.partnership_companies || []) {
    const o = document.createElement("option");
    o.value = opt.value;
    const label = opt.value.length > 42 ? `${opt.value.slice(0, 42)}…` : opt.value;
    o.textContent = `${label} (${opt.count})`;
    companySel.appendChild(o);
  }
  companySel.value = companyVal;
  const photoSel = $("profiles-filter-photo");
  if (photoSel) photoSel.value = profilesFilters.has_photo || "";
}

async function loadProfilesFilterMeta() {
  if (profilesFilterOptions) {
    populateProfilesFilterSelects(profilesFilterOptions);
    populateBulkCardTypeSelect(profilesFilterOptions);
    return profilesFilterOptions;
  }
  profilesFilterOptions = await api("/api/vehicle-profiles/meta");
  populateProfilesFilterSelects(profilesFilterOptions);
  populateBulkCardTypeSelect(profilesFilterOptions);
  updateProfilesTotalStat();
  return profilesFilterOptions;
}

function buildProfilesListParams() {
  const params = new URLSearchParams({
    page: String(profilesPage),
    page_size: String(PROFILES_PAGE_SIZE),
  });
  const q = profilesSearchQuery.trim();
  if (q) params.set("q", q);
  if (profilesFilters.vehicle_type) params.set("vehicle_type", profilesFilters.vehicle_type);
  if (profilesFilters.partnership_company) {
    params.set("partnership_company", profilesFilters.partnership_company);
  }
  if (profilesFilters.has_photo === "yes") params.set("has_photo", "true");
  else if (profilesFilters.has_photo === "no") params.set("has_photo", "false");
  return params;
}

function updateProfilesPaginationUi() {
  const summary = $("profiles-results-summary");
  const pageInfo = $("profiles-page-info");
  const prevBtn = $("profiles-prev");
  const nextBtn = $("profiles-next");
  const { total, page, total_pages } = profilesListMeta;
  if (summary) {
    if (!total) {
      summary.textContent = "لا توجد نتائج.";
    } else {
      const from = (page - 1) * PROFILES_PAGE_SIZE + 1;
      const to = Math.min(page * PROFILES_PAGE_SIZE, total);
      summary.textContent = `عرض ${from}–${to} من ${total} مركبة`;
    }
  }
  if (pageInfo) {
    pageInfo.textContent = total ? `صفحة ${page} من ${total_pages}` : "—";
  }
  if (prevBtn) prevBtn.disabled = page <= 1 || profilesListLoading;
  if (nextBtn) nextBtn.disabled = page >= total_pages || !total || profilesListLoading;
}

async function refreshVehicleProfiles() {
  const tbody = $("profiles-body");
  if (!tbody) return;
  if (profilesListLoading) return;
  profilesListLoading = true;
  updateProfilesPaginationUi();
  try {
    await loadProfilesFilterMeta();
    const data = await api(`/api/vehicle-profiles?${buildProfilesListParams()}`);
    vehicleProfileListCache = Array.isArray(data?.items) ? data.items : [];
    profilesListMeta = {
      total: Number(data?.total) || 0,
      page: Number(data?.page) || 1,
      total_pages: Number(data?.total_pages) || 1,
    };
    profilesPage = profilesListMeta.page;
    renderVehicleProfilesTable();
  } finally {
    profilesListLoading = false;
    updateProfilesPaginationUi();
  }
}

function renderVehicleProfilesTable() {
  const tbody = $("profiles-body");
  if (!tbody) return;
  updateProfilesTotalStat();
  updateProfilesPaginationUi();
  if (!vehicleProfileListCache.length) {
    const hasFilters =
      profilesSearchQuery.trim() ||
      profilesFilters.vehicle_type ||
      profilesFilters.partnership_company ||
      profilesFilters.has_photo;
    tbody.innerHTML = hasFilters
      ? '<tr><td colspan="13" class="muted">لا توجد نتائج مطابقة للبحث أو الفلاتر.</td></tr>'
      : '<tr><td colspan="13" class="muted">لا توجد بروفايلات مسجّلة بعد.</td></tr>';
    return;
  }
  tbody.innerHTML = "";
  for (const r of vehicleProfileListCache) {
    const tr = document.createElement("tr");
    const mk = r.vehicle_make ? escapeHtml(r.vehicle_make) : "—";
    const vtype = r.vehicle_type ? escapeHtml(r.vehicle_type) : "—";
    const cl = r.vehicle_color ? escapeHtml(r.vehicle_color) : "—";
    const mech = escapeHtml(r.mechanical_number);
    const driver = r.driver_name ? escapeHtml(r.driver_name) : "—";
    const owner = r.owner_name ? escapeHtml(r.owner_name) : "—";
    const company = r.partnership_company ? escapeHtml(r.partnership_company) : "—";
    const created = formatDamascusDateTime(r.created_at);
    const photoLabel = r.has_photo ? "نعم" : "لا";
    const seq = Number(r.registration_order);
    const seqDisplay = Number.isFinite(seq) ? escapeHtml(String(seq)) : "—";
    tr.innerHTML = `
      <td>${seqDisplay}</td>
      <td>${escapeHtml(String(r.id))}</td>
      <td>${escapeHtml(r.license_plate)}</td>
      <td>${mk}</td>
      <td>${vtype}</td>
      <td>${cl}</td>
      <td>${mech}</td>
      <td>${driver}</td>
      <td>${owner}</td>
      <td>${company}</td>
      <td>${photoLabel}</td>
      <td>${created}</td>
      <td class="profiles-actions-cell"></td>`;
    const cell = tr.querySelector(".profiles-actions-cell");
    const scanBtn = document.createElement("button");
    scanBtn.type = "button";
    scanBtn.className = "btn btn-sm profile-row-scan";
    scanBtn.textContent =
      canCheckIn && !canCheckOut ? "مسح دخول" : canCheckOut && !canCheckIn ? "مسح خروج" : "استعلام";
    scanBtn.setAttribute("data-token", r.public_token);
    const cardBtn = document.createElement("button");
    cardBtn.type = "button";
    cardBtn.className = "btn btn-sm profile-row-card";
    cardBtn.textContent = "البطاقة";
    cardBtn.dataset.id = String(r.id);
    cell.appendChild(scanBtn);
    cell.appendChild(document.createTextNode(" "));
    cell.appendChild(cardBtn);
    if (currentRole === "admin") {
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "btn btn-sm btn-danger profile-row-delete";
      deleteBtn.textContent = "إزالة";
      deleteBtn.dataset.id = String(r.id);
      cell.appendChild(document.createTextNode(" "));
      cell.appendChild(deleteBtn);
    }
    tbody.appendChild(tr);
  }
}

async function refreshTickets() {
  ticketLogCache = await api("/api/sessions/log?limit=300");
  const tbody = $("tickets-body");
  tbody.innerHTML = "";
  if (!ticketLogCache.length) {
    tbody.innerHTML =
      '<tr><td colspan="7" class="muted">لا توجد تذاكر بعد.</td></tr>';
    return;
  }
  for (const r of ticketLogCache) {
    const tr = document.createElement("tr");
    const entered = formatDamascusDateTime(r.entered_at);
    const inside = r.exited_at == null;
    const statusHtml = inside
      ? '<span class="badge badge-in">داخل الموقف</span>'
      : '<span class="badge badge-out">تم الخروج</span>';
    const exitedDisplay = r.exited_at
      ? formatDamascusDateTime(r.exited_at)
      : "—";
    const codeHtml = escapeHtml(r.receipt_code);
    tr.innerHTML = `
      <td>${escapeHtml(r.license_plate)}</td>
      <td class="ticket-code-cell">
        <div class="ticket-code-row">
          <code class="ticket-code" dir="ltr" title="انقر لتحديد الرمز">${codeHtml}</code>
          <button type="button" class="btn btn-sm copy-receipt-code" data-code="${codeHtml}">نسخ</button>
        </div>
      </td>
      <td>${entered}</td>
      <td>${statusHtml}</td>
      <td>${exitedDisplay}</td>
      <td>${r.slot_number}</td>
      <td><button type="button" class="btn btn-sm preview-ticket" data-receipt="${codeHtml}">معاينة</button></td>`;
    tbody.appendChild(tr);
  }
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("login-error");
  errEl.textContent = "";
  try {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: $("login-user").value.trim(),
        password: $("login-pass").value,
      }),
    });
    setToken(data.access_token);
    const me = await api("/api/auth/me");
    applyRoleUI(me);
    showAppShell();
    $("login-pass").value = "";
    setView("desk");
    await refreshDeskData();
    populateVehicleQrCameras().catch(() => {});
    consumePendingVehicleScan();
    window.ParkingPos?.tryAutoStartCamera();
  } catch (err) {
    errEl.textContent = err.message || "فشل تسجيل الدخول.";
  }
});

$("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("settings-msg");
  msg.textContent = "";
  try {
    await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        total_slots: parseInt($("total-slots").value, 10),
        price_per_hour_cents: Math.max(
          0,
          parseInt(String($("price-hour").value).trim(), 10) || 0
        ),
      }),
    });
    await refreshDeskData();
    msg.textContent = "تم حفظ الإعدادات.";
    msg.style.color = "var(--success)";
  } catch (err) {
    alert(err.message);
  }
});

$("checkin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const mechVal = ($("mech") && $("mech").value) ? $("mech").value.trim() : "";
  try {
    const data = await api("/api/check-in", {
      method: "POST",
      body: JSON.stringify({
        license_plate: $("plate").value,
        mechanical_number: mechVal || null,
        vehicle_make: $("make").value || null,
        vehicle_type: $("vehicle-type").value || null,
        vehicle_color: $("color").value || null,
        driver_name: $("driver-name").value || null,
        owner_name: $("owner-name").value || null,
        partnership_company: $("partnership-company").value || null,
        notes: $("notes").value || null,
      }),
    });
    openReceiptModal({
      receipt_code: data.receipt_code,
      license_plate: data.license_plate,
      slot_number: data.slot_number,
      entered_at: data.entered_at,
      exited_at: null,
      amount_due_cents: null,
      hours_billed: null,
      profile_id: data.profile_id ?? null,
      public_token: data.public_token ?? null,
      vehicle_make: data.vehicle_make || $("make").value.trim() || null,
      vehicle_type: data.vehicle_type || $("vehicle-type").value.trim() || null,
      vehicle_color: data.vehicle_color || $("color").value.trim() || null,
      driver_name: data.driver_name || $("driver-name").value.trim() || null,
      owner_name: data.owner_name || $("owner-name").value.trim() || null,
      partnership_company:
        data.partnership_company || $("partnership-company").value.trim() || null,
      mechanical_number: data.mechanical_number || mechVal || null,
      registration_order: data.registration_order ?? null,
      qr_payload: data.qr_payload ?? null,
      fifo_queue_number: data.fifo_queue_number ?? null,
      fifo_truck_type: data.fifo_truck_type ?? null,
    });
    $("plate").value = "";
    $("mech").value = "";
    $("make").value = "";
    $("vehicle-type").value = "";
    $("color").value = "";
    $("driver-name").value = "";
    $("owner-name").value = "";
    $("partnership-company").value = "";
    $("notes").value = "";
    await refreshDeskData();
    if (!$("view-tickets").classList.contains("hidden")) {
      await refreshTickets();
    }
    if (!$("view-fifo").classList.contains("hidden")) {
      await refreshFifoDashboard();
    }
    if (!$("view-profiles").classList.contains("hidden")) {
      await refreshVehicleProfiles();
    }
  } catch (err) {
    if (err.status === 409) {
      openMessageModal("تعذّر الدخول", err.message);
    } else {
      alert(err.message);
    }
  }
});

$("checkout-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const data = await api("/api/check-out", {
      method: "POST",
      body: JSON.stringify({ receipt_code: $("receipt").value.trim() }),
    });
    openCheckoutResultModal(data);
    $("receipt").value = "";
    await refreshDeskData();
    if (!$("view-tickets").classList.contains("hidden")) {
      await refreshTickets();
    }
    if (!$("view-fifo").classList.contains("hidden")) {
      await refreshFifoDashboard();
    }
    if (!$("view-stats").classList.contains("hidden")) {
      await refreshMonthStats();
    }
  } catch (err) {
    if (err.fifoDetail) {
      openMessageModal(
        "ليس دور هذه المركبة حالياً",
        buildFifoBlockedHtml(err.fifoDetail, {
          fifo_queue_number: err.fifoDetail.vehicle_queue_number,
          fifo_truck_type: err.fifoDetail.fifo_truck_type,
        }),
        true
      );
    } else {
      alert(err.message);
    }
  }
});

$("admin-password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("admin-pw-msg");
  msg.textContent = "";
  try {
    await api("/api/admin/users/password", {
      method: "PUT",
      body: JSON.stringify({
        username: $("admin-pw-user").value,
        new_password: $("admin-pw-new").value,
      }),
    });
    $("admin-pw-new").value = "";
    msg.textContent = "تم حفظ كلمة المرور للمستخدم المحدد.";
    msg.style.color = "var(--success)";
  } catch (err) {
    msg.textContent = err.message || "فشل الحفظ.";
    msg.style.color = "#f87171";
  }
});

$("admin-rename-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("admin-rename-msg");
  msg.textContent = "";
  try {
    const res = await api("/api/admin/users/username", {
      method: "PUT",
      body: JSON.stringify({
        current_username: $("admin-rename-user").value,
        new_username: $("admin-rename-new").value.trim(),
      }),
    });
    $("admin-rename-new").value = "";
    if (res.renamed_self) {
      msg.textContent = "تم تغيير اسمك. سجّل الدخول بالاسم الجديد.";
      msg.style.color = "var(--success)";
      clearAuth();
      showLoginView();
      $("login-error").textContent = "تم تغيير اسم المستخدم. سجّل الدخول بالاسم الجديد.";
      return;
    }
    msg.textContent = "تم تغيير اسم المستخدم.";
    msg.style.color = "var(--success)";
    await loadAdminUsersForPassword();
  } catch (err) {
    msg.textContent = err.message || "فشل التغيير.";
    msg.style.color = "#f87171";
  }
});

$("admin-wipe-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("admin-wipe-msg");
  msg.textContent = "";
  try {
    await api("/api/admin/database/wipe", {
      method: "POST",
      body: JSON.stringify({ confirmation: $("admin-wipe-confirm").value }),
    });
    $("admin-wipe-confirm").value = "";
    msg.textContent = "تم مسح جميع جلسات الموقف وإعادة الإعدادات الافتراضية.";
    msg.style.color = "var(--success)";
    await refreshDeskData();
    if (!$("view-tickets").classList.contains("hidden")) {
      await refreshTickets();
    }
    if (!$("view-stats").classList.contains("hidden")) {
      await refreshMonthStats();
    }
  } catch (err) {
    msg.textContent = err.message || "فشل المسح.";
    msg.style.color = "#f87171";
  }
});

async function refreshDeskData() {
  await refreshStats();
}

async function tryResumeSession() {
  if (!getToken()) return false;
  try {
    const me = await api("/api/auth/me");
    applyRoleUI(me);
    showAppShell();
    return true;
  } catch {
    clearAuth();
    showLoginView();
    return false;
  }
}

async function boot() {
  captureVehicleScanFromHash();
  showLoginView();
  const ok = await tryResumeSession();
  if (ok) {
    setView("desk");
    await refreshDeskData();
    populateVehicleQrCameras().catch(() => {});
    consumePendingVehicleScan();
    window.ParkingPos?.tryAutoStartCamera();
  }
}

wireCheckoutResultModal();
wireReceiptModal();
wireMessageModal();
wireVehicleFlowModal();
wireVehicleScanDesk();
wireNav();
initAppThemeToggle();

function wireVehicleCardModal() {
  $("vehicle-card-modal-close")?.addEventListener("click", closeVehicleCardModal);
  $("vehicle-card-dismiss")?.addEventListener("click", closeVehicleCardModal);
  $("vehicle-card-modal-backdrop")?.addEventListener("click", closeVehicleCardModal);
  $("vehicle-card-download")?.addEventListener("click", () => {
    downloadVehicleCardPng().catch(() => {});
  });
}

wireVehicleCardModal();

window.processVehicleScan = processVehicleScan;
window.startVehicleQrScanner = startVehicleQrScanner;
window.stopVehicleQrScanner = stopVehicleQrScanner;

boot().catch((err) => {
  console.error(err);
  alert(
    "تعذّر الاتصال بالخادم. شغّل الخادم ثم أعد المحاولة: python -m uvicorn app.main:app --reload"
  );
});
