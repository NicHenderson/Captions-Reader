/* =====================================================================
   Captions Reader — sw.js (Service Worker)
   Permite usar la app SIN CONEXIÓN una vez visitada.

   La versión llega en la URL del registro (sw.js?v=N, la pone
   features/pwa.js con el mismo número que los "?v=N" de index.html), así
   solo hay que subir el número en index.html al publicar cambios.

   Estrategias:
     · Página (navegación): primero la RED, con la copia guardada como
       respaldo. Así nunca se queda servida una versión vieja del HTML
       (evita el problema de mezclar HTML nuevo con CSS/JS antiguos).
     · CSS/JS versionados, iconos y manifiesto: primero la CACHÉ. Es seguro
       porque cada versión tiene su propia URL (?v=N).
     · Fuentes de Google: caché con actualización en segundo plano
       (stale-while-revalidate).
   ===================================================================== */

"use strict";

const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const APP_CACHE = `captions-reader-app-${VERSION}`;
const FONT_CACHE = "captions-reader-fonts";
const NAVIGATION_TIMEOUT_MS = 4000; // con red muy lenta, se usa la copia

// Archivos que llevan "?v=N" en index.html.
const VERSIONED_FILES = [
  "styles.css",
  "captions-core.js",
  "app.js",
  "features/recents.js",
  "features/playback.js",
  "features/transcript.js",
  "features/pwa.js",
];

const STATIC_FILES = [
  "./",
  "manifest.webmanifest",
  "CaptionsReader-Icon.ico",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
];

const PRECACHE = [
  ...STATIC_FILES,
  ...VERSIONED_FILES.map((file) => `${file}?v=${VERSION}`),
];

const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

/* ---------------- Instalación: guarda la app completa ---------------- */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

/* ---------------- Activación: borra versiones anteriores ---------------- */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith("captions-reader-app-") && key !== APP_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

/* ---------------- Peticiones ---------------- */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (request.mode === "navigate") {
    event.respondWith(networkFirstPage(request));
  } else if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(request, FONT_CACHE));
  } else if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request));
  }
  // Cualquier otra petición sigue su camino normal.
});

/** Página: red primero (con tiempo límite) y la copia guardada si falla. */
async function networkFirstPage(request) {
  const cache = await caches.open(APP_CACHE);
  const scopeUrl = self.registration.scope; // ".../Captions-Reader/"
  try {
    const response = await withTimeout(fetch(request), NAVIGATION_TIMEOUT_MS);
    if (response.ok) cache.put(scopeUrl, response.clone());
    return response;
  } catch (_) {
    const cached = await cache.match(request, { ignoreSearch: true }) || await cache.match(scopeUrl);
    if (cached) return cached;
    throw _;
  }
}

/** Caché primero; si no está, red (y se guarda para la próxima vez). */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(APP_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

/** Responde con la copia guardada (si hay) y la actualiza en segundo plano. */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const refresh = fetch(request)
    .then((response) => {
      // Las respuestas de otro origen sin CORS son "opaque" (status 0): válidas.
      if (response.ok || response.type === "opaque") cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached || refresh;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Tiempo de espera agotado")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}
