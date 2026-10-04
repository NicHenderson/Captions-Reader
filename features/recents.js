/* =====================================================================
   Captions Reader — features/recents.js
   FUNCIONALIDAD: reanudar donde lo dejaste + lista de recientes.

   Guarda en IndexedDB (en el propio navegador, nada sale del equipo):
     · "texts":    { id, text }                  -> el .srt completo
     · "sessions": { id, name, title, total,     -> metadatos ligeros
                     index, createdAt, updatedAt }
   Separarlos permite guardar la posición en cada cambio de subtítulo sin
   reescribir el texto completo (que puede ocupar varios MB).

   Comportamiento:
     · Al abrir un archivo ya visto, salta a donde se quedó y lo avisa con
       un toast que permite "Empezar desde el principio".
     · En la zona de carga se listan los recientes: un clic lo reabre (sin
       volver a buscar el archivo) y la "×" lo quita de la lista.
     · Si IndexedDB no está disponible (p. ej. algunos modos privados), la
       funcionalidad se desactiva sin afectar al resto de la app.
   ===================================================================== */

"use strict";

(() => {
  const DB_NAME = "captions-reader";
  const DB_VERSION = 1;
  const MAX_RECENTS = 8;     // archivos que se conservan
  const SAVE_DELAY_MS = 400; // agrupa los guardados al navegar rápido

  const els = {
    section: document.getElementById("recents"),
    list: document.getElementById("recentsList"),
  };

  /* ---------------------------------------------------------------
     Acceso a IndexedDB (envuelto en promesas)
     --------------------------------------------------------------- */
  let dbPromise = null;

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (!("indexedDB" in window)) {
          reject(new Error("IndexedDB no está disponible"));
          return;
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore("texts", { keyPath: "id" });
          db.createObjectStore("sessions", { keyPath: "id" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      // Si falla, se recuerda el fallo (no se reintenta en cada acción).
      dbPromise.catch((error) => {
        console.warn("Captions Reader: recientes desactivados.", error);
      });
    }
    return dbPromise;
  }

  /**
   * Ejecuta "work" en una transacción y resuelve cuando ésta TERMINA
   * (así un guardado se considera hecho solo cuando está en disco).
   * @param {string[]} stores
   * @param {"readonly"|"readwrite"} mode
   * @param {(tx: IDBTransaction) => IDBRequest|void} work
   */
  async function transaction(stores, mode, work) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      const request = work(tx);
      tx.oncomplete = () => resolve(request ? request.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  const getSession = (id) =>
    transaction(["sessions"], "readonly", (tx) => tx.objectStore("sessions").get(id));
  const getAllSessions = () =>
    transaction(["sessions"], "readonly", (tx) => tx.objectStore("sessions").getAll());
  const getText = (id) =>
    transaction(["texts"], "readonly", (tx) => tx.objectStore("texts").get(id));
  const putSession = (session) =>
    transaction(["sessions"], "readwrite", (tx) => { tx.objectStore("sessions").put(session); });
  const putFile = (session, text) =>
    transaction(["sessions", "texts"], "readwrite", (tx) => {
      tx.objectStore("sessions").put(session);
      tx.objectStore("texts").put({ id: session.id, text });
    });
  const removeFile = (id) =>
    transaction(["sessions", "texts"], "readwrite", (tx) => {
      tx.objectStore("sessions").delete(id);
      tx.objectStore("texts").delete(id);
    });

  /** Conserva solo los MAX_RECENTS más recientes. */
  async function prune() {
    const sessions = await getAllSessions();
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    await Promise.all(sessions.slice(MAX_RECENTS).map((s) => removeFile(s.id)));
  }

  /* ---------------------------------------------------------------
     Reanudar: al abrir un archivo se busca su sesión anterior
     --------------------------------------------------------------- */
  let loadSeq = 0;
  // Guardado del último archivo abierto (la lista espera a que termine).
  let loadSaving = Promise.resolve();

  on("load", (detail) => {
    loadSaving = rememberFile(detail);
  });

  async function rememberFile({ file, cues }) {
    const seq = ++loadSeq;
    try {
      const previous = await getSession(file.id);
      // Mientras se consultaba pudo abrirse otro archivo o volverse atrás.
      if (seq !== loadSeq || state.file?.id !== file.id) return;

      const canResume = previous && previous.index > 0 && previous.index < cues.length &&
        state.index === 0; // si el usuario ya se movió, se respeta
      if (canResume) {
        goToIndex(previous.index, "resume");
        showToast(`Continuando donde lo dejaste · ${previous.index + 1} / ${cues.length}`, {
          actionLabel: "Empezar desde el principio",
          onAction: () => goToIndex(0, "user"),
          duration: 8000,
        });
      }

      const now = Date.now();
      await putFile({
        id: file.id,
        name: file.name,
        title: file.title,
        total: cues.length,
        index: state.index,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      }, file.text);
      await prune();
      // La lista (oculta ahora) queda al día para cuando se vuelva a la carga.
      renderRecents();
    } catch (error) {
      console.warn("Captions Reader: no se pudo guardar el archivo en recientes.", error);
    }
  }

  /* ---------------------------------------------------------------
     Guardar la posición (agrupando cambios rápidos)
     --------------------------------------------------------------- */
  let saveTimer = 0;
  let pending = null; // { id, index }

  on("cue", ({ index, source }) => {
    if (!state.file || source === "load") return;
    pending = { id: state.file.id, index };
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(flush, SAVE_DELAY_MS);
  });

  async function flush() {
    window.clearTimeout(saveTimer);
    if (!pending) return;
    const { id, index } = pending;
    pending = null;
    try {
      const session = await getSession(id);
      if (!session) return; // se quitó de recientes mientras tanto
      session.index = index;
      session.updatedAt = Date.now();
      await putSession(session);
    } catch (error) {
      console.warn("Captions Reader: no se pudo guardar la posición.", error);
    }
  }

  // Al cerrar o esconder la pestaña no se pierde el último cambio.
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });

  /* ---------------------------------------------------------------
     Lista de recientes en la zona de carga
     --------------------------------------------------------------- */
  const relativeTime = new Intl.RelativeTimeFormat("es", { numeric: "auto" });

  /** "hace 5 minutos", "ayer", "hace 3 días"... */
  function timeAgo(timestamp) {
    const seconds = Math.round((timestamp - Date.now()) / 1000);
    const units = [["year", 31536000], ["month", 2592000], ["week", 604800],
                   ["day", 86400], ["hour", 3600], ["minute", 60]];
    for (const [unit, size] of units) {
      if (Math.abs(seconds) >= size) return relativeTime.format(Math.round(seconds / size), unit);
    }
    return "ahora mismo";
  }

  function buildItem(session) {
    const item = document.createElement("li");
    item.className = "recents__item";

    // El título extraído puede no ser útil: entonces se muestra el nombre.
    // Si no hay datos de temporada, basta con el nombre de la obra (la
    // tarjeta es pequeña para "Temporada: No identificada, ...").
    const title = session.title && session.title !== "Información no disponible"
      ? session.title.replace(/ \| Temporada: No identificada, episodio no identificado$/, "")
      : session.name;
    const progress = Math.round(((session.index + 1) / session.total) * 100);

    const open = document.createElement("button");
    open.type = "button";
    open.className = "recents__open";
    open.title = session.name;
    open.dataset.id = session.id;

    const name = document.createElement("span");
    name.className = "recents__name";
    name.textContent = title;

    const bar = document.createElement("span");
    bar.className = "recents__progress";
    const fill = document.createElement("span");
    fill.style.width = `${progress}%`;
    bar.append(fill);

    const meta = document.createElement("span");
    meta.className = "recents__meta";
    const position = document.createElement("span");
    position.textContent = `${session.index + 1} / ${session.total}`;
    const when = document.createElement("span");
    when.textContent = timeAgo(session.updatedAt);
    meta.append(position, when);

    open.append(name, bar, meta);
    open.setAttribute("aria-label",
      `${title}. Subtítulo ${session.index + 1} de ${session.total}. Abierto ${when.textContent}.`);
    open.addEventListener("click", () => reopen(session));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "recents__remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Quitar «${title}» de recientes`);
    remove.title = "Quitar de recientes";
    remove.addEventListener("click", () => forget(session.id, item));

    item.append(open, remove);
    return item;
  }

  async function renderRecents() {
    let sessions;
    try {
      sessions = await getAllSessions();
    } catch (_) {
      els.section.hidden = true;
      return;
    }
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    els.list.replaceChildren(...sessions.slice(0, MAX_RECENTS).map(buildItem));
    els.section.hidden = sessions.length === 0;
  }

  async function reopen(session) {
    try {
      const record = await getText(session.id);
      if (!record) throw new Error("Texto no encontrado");
      openSubtitles(session.name, record.text);
    } catch (error) {
      console.warn("Captions Reader: no se pudo reabrir el archivo.", error);
      showError("No se pudo abrir este archivo reciente. Vuelve a cargarlo.");
      await removeFile(session.id).catch(() => {});
      renderRecents();
    }
  }

  async function forget(id, item) {
    // Tras quitarlo, el foco pasa al siguiente elemento (o al anterior, o a
    // la zona de carga) para que el teclado no se pierda.
    const sibling = item.nextElementSibling || item.previousElementSibling;
    const nextFocusId = sibling?.querySelector(".recents__open")?.dataset.id;
    try {
      await removeFile(id);
    } catch (error) {
      console.warn("Captions Reader: no se pudo quitar de recientes.", error);
    }
    await renderRecents();
    const target = nextFocusId
      ? els.list.querySelector(`[data-id="${CSS.escape(nextFocusId)}"]`)
      : dom.fileInput;
    target?.focus();
  }

  // Al volver a la zona de carga se guarda lo pendiente y se refresca la lista.
  on("reset", async () => {
    await loadSaving;
    await flush();
    renderRecents();
  });

  renderRecents();
})();
