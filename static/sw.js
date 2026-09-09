const CACHE_NAME = "parking-pos-v20260910-8";
const PRECACHE = [
  "/",
  "/CarRegistration",
  "/manifest.webmanifest",
  "/static/theme.js?v=20260910-8",
  "/static/styles.css?v=20260910-8",
  "/static/app.js?v=20260910-8",
  "/static/pos-pwa.js?v=20260910-8",
  "/static/vendor/html5-qrcode.min.js?v=20260910-8",
  "/static/vendor/qrcode.min.js?v=20260910-8",
  "/static/vendor/html2canvas.min.js?v=20260910-8",
  "/static/vendor/jszip.min.js?v=20260910-8",
  "/static/pwa-icon-192.png",
  "/static/pwa-icon-512.png",
  "/static/pwa-maskable-192.png",
  "/static/pwa-maskable-512.png",
  "/static/logo.png",
  "/static/favicon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname.startsWith("/uploads/")) return;

  if (url.pathname === "/sw.js") {
    event.respondWith(fetch(req));
    return;
  }

  const isDocument =
    req.mode === "navigate" ||
    (req.headers.get("accept") || "").includes("text/html");

  if (isDocument) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          // Cache each document under its own URL AND keep "/" fresh for the app shell.
          caches.open(CACHE_NAME).then((c) => {
            c.put(req, copy.clone()).catch(() => {});
            if (url.pathname === "/" || url.pathname === "/index.html") {
              c.put("/", copy).catch(() => {});
            }
          }).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match("/")))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const fetched = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetched;
    })
  );
});
