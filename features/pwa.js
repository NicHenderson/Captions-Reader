/* =====================================================================
   Captions Reader — features/pwa.js
   FUNCIONALIDAD: aplicación instalable que funciona sin conexión (PWA).

   · Registra el Service Worker (sw.js) para usar la app sin conexión.
     Solo al servirse por http/https (p. ej. GitHub Pages): abierta con
     file:// la app funciona igual, pero sin modo offline ni instalación.
   · Botón "Instalar app" cuando el navegador lo permite.
   · "Abrir con…" desde el sistema operativo (File Handling API): con la
     app instalada (Chrome/Edge de escritorio), un .srt se abre en ella.
   ===================================================================== */

"use strict";

(() => {
  // La versión es la misma "?v=N" con la que index.html carga este script.
  const VERSION = new URL(document.currentScript.src).searchParams.get("v") || "dev";
  const installButton = document.getElementById("installBtn");

  /* ---------------- Modo sin conexión ---------------- */
  const canUseServiceWorker =
    "serviceWorker" in navigator && /^https?:$/.test(window.location.protocol);

  if (canUseServiceWorker) {
    // Primera visita: aún no hay Service Worker controlando la página.
    const firstInstall = !navigator.serviceWorker.controller;

    window.addEventListener("load", () => {
      navigator.serviceWorker.register(`sw.js?v=${VERSION}`).catch((error) => {
        console.warn("Captions Reader: no se pudo activar el modo sin conexión.", error);
      });
    });

    if (firstInstall) {
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        showToast("Listo: Captions Reader ya funciona sin conexión.");
      }, { once: true });
    }
  }

  /* ---------------- Instalar ---------------- */
  let installPrompt = null;

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault(); // se usa nuestro botón en lugar del aviso del navegador
    installPrompt = event;
    installButton.hidden = false;
  });

  installButton.addEventListener("click", async () => {
    if (!installPrompt) return;
    installButton.hidden = true;
    installPrompt.prompt();
    try {
      await installPrompt.userChoice;
    } finally {
      installPrompt = null;
    }
  });

  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    installButton.hidden = true;
    showToast("Instalada. Ya puedes abrir archivos .srt con Captions Reader.");
  });

  /* ---------------- "Abrir con…" (File Handling API) ---------------- */
  if ("launchQueue" in window) {
    window.launchQueue.setConsumer(async (launchParams) => {
      const [handle] = launchParams.files || [];
      if (!handle) return;
      try {
        handleFile(await handle.getFile());
      } catch (error) {
        console.warn("Captions Reader: no se pudo abrir el archivo del sistema.", error);
        showError("No se pudo abrir el archivo. Prueba a arrastrarlo aquí.");
      }
    });
  }
})();
