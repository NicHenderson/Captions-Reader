/* =====================================================================
   Captions Reader — features/transcript.js
   FUNCIONALIDAD: transcripción completa con búsqueda.

   · Botón "Transcripción" (o tecla T): muestra todos los subtítulos en
     una lista desplazable. El actual se resalta y se mantiene a la vista.
   · Clic en una fila: salta a ese subtítulo.
   · Búsqueda (tecla /): sin distinguir mayúsculas ni tildes, con espera
     de 150 ms entre teclas (debounce). Muestra solo las coincidencias,
     resaltadas. Enter salta al siguiente resultado (Shift+Enter, al
     anterior); Escape borra la búsqueda o, si ya está vacía, cierra.
   · Rendimiento:
       - La lista completa se construye una vez por archivo y NO se toca al
         buscar: los resultados se pintan en una segunda lista. Ocultar
         miles de filas intercaladas resultó muy lento (medido: ~320 ms con
         3.000 subtítulos); construir solo los resultados es mucho más barato.
       - Las filas usan "content-visibility: auto" (CSS): el navegador no
         pinta las que no se ven.
       - La versión normalizada de cada texto se calcula una sola vez.
   · Seguridad: el texto de los subtítulos se inserta SIEMPRE como texto
     (textContent / nodos de texto), nunca como HTML.
   ===================================================================== */

"use strict";

(() => {
  const SEARCH_DELAY_MS = 150;
  const USER_SCROLL_GRACE_MS = 2500; // no se pelea con el scroll del usuario

  const els = {
    button: document.getElementById("transcriptBtn"),
    panel: document.getElementById("transcript"),
    search: document.getElementById("transcriptSearch"),
    count: document.getElementById("transcriptCount"),
    list: document.getElementById("transcriptList"),
    results: document.getElementById("transcriptResults"),
  };

  let cues = [];
  let prepared = [];          // prepareSearch() de cada subtítulo (bajo demanda)
  let fullRows = [];          // filas de la lista completa, por índice
  let resultRows = new Map(); // índice -> fila de la lista de resultados
  let resultIndexes = [];     // índices de los resultados, en orden
  let query = "";
  let searchTimer = 0;
  let userScrolledAt = -Infinity;

  const prefersReducedMotion = () =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------------- Filas ---------------- */

  /** Pinta "text" en "el" con <mark> en los tramos indicados (sin HTML). */
  function renderText(el, text, ranges) {
    if (!ranges.length) {
      el.textContent = text;
      return;
    }
    const parts = [];
    let pos = 0;
    for (const [start, end] of ranges) {
      if (start > pos) parts.push(text.slice(pos, start));
      const mark = document.createElement("mark");
      mark.textContent = text.slice(start, end);
      parts.push(mark);
      pos = end;
    }
    if (pos < text.length) parts.push(text.slice(pos));
    el.replaceChildren(...parts);
  }

  /** Crea una fila (li > button) para el subtítulo "index". */
  function createRow(index, ranges = []) {
    const item = document.createElement("li");
    item.className = "transcript__item";

    const row = document.createElement("button");
    row.type = "button";
    row.className = "transcript__row";
    row.dataset.index = String(index);
    if (index === state.index) row.setAttribute("aria-current", "true");

    const time = document.createElement("span");
    time.className = "transcript__time";
    time.textContent = formatClock(cues[index].startMs);

    const text = document.createElement("span");
    text.className = "transcript__text";
    renderText(text, cues[index].text, ranges);

    row.append(time, text);
    item.append(row);
    return { item, row };
  }

  function buildFullList() {
    const fragment = document.createDocumentFragment();
    fullRows = cues.map((_, index) => {
      const { item, row } = createRow(index);
      fragment.append(item);
      return row;
    });
    els.list.replaceChildren(fragment);
    els.list.scrollTop = 0;
  }

  /* ---------------- Subtítulo actual ---------------- */
  const activeList = () => (query ? els.results : els.list);

  function markCurrent(index, { instant = false } = {}) {
    for (const list of [els.list, els.results]) {
      list.querySelector('.transcript__row[aria-current="true"]')?.removeAttribute("aria-current");
    }
    const fullRow = fullRows[index];
    const resultRow = resultRows.get(index);
    fullRow?.setAttribute("aria-current", "true");
    resultRow?.setAttribute("aria-current", "true");

    const visibleRow = query ? resultRow : fullRow;
    if (visibleRow && !els.panel.hidden) reveal(visibleRow, instant);
  }

  /** Desplaza la lista visible (no la página) para centrar "row". */
  function reveal(row, instant) {
    const userIsScrolling = performance.now() - userScrolledAt < USER_SCROLL_GRACE_MS;
    if (userIsScrolling && !instant) return;

    const list = activeList();
    const area = list.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    if (box.top >= area.top && box.bottom <= area.bottom) return; // ya se ve

    list.scrollTo({
      top: list.scrollTop + (box.top - area.top) - (area.height - box.height) / 2,
      behavior: instant || prefersReducedMotion() ? "auto" : "smooth",
    });
  }

  for (const list of [els.list, els.results]) {
    // Desplazamiento hecho por el usuario (no por el código).
    ["wheel", "touchmove", "pointerdown"].forEach((type) =>
      list.addEventListener(type, () => { userScrolledAt = performance.now(); }, { passive: true }));
    list.addEventListener("keydown", (event) => {
      if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"].includes(event.key)) {
        userScrolledAt = performance.now();
      }
    });
    // Un clic en cualquier fila (delegación: un oyente para miles de filas).
    list.addEventListener("click", (event) => {
      const row = event.target.closest(".transcript__row");
      if (row) goToIndex(Number(row.dataset.index), "transcript");
    });
  }

  /* ---------------- Búsqueda ---------------- */
  function applySearch() {
    window.clearTimeout(searchTimer);
    const next = els.search.value.trim();
    if (next === query) return;
    query = next;

    resultRows = new Map();
    resultIndexes = [];

    if (!query) {
      els.results.hidden = true;
      els.results.replaceChildren();
      els.list.hidden = false;
      updateCount();
      const row = fullRows[state.index];
      if (row && !els.panel.hidden) reveal(row, true);
      return;
    }

    const fragment = document.createDocumentFragment();
    cues.forEach((cue, index) => {
      prepared[index] ??= prepareSearch(cue.text);
      const ranges = findMatches(cue.text, query, prepared[index]);
      if (!ranges.length) return;
      const { item, row } = createRow(index, ranges);
      fragment.append(item);
      resultRows.set(index, row);
      resultIndexes.push(index);
    });

    if (!resultIndexes.length) {
      const empty = document.createElement("li");
      empty.className = "transcript__empty";
      empty.textContent = `Sin resultados para «${query}»`;
      fragment.append(empty);
    }

    els.results.replaceChildren(fragment);
    els.results.scrollTop = 0;
    els.results.hidden = false;
    els.list.hidden = true;
    updateCount();
  }

  function updateCount() {
    const matches = resultIndexes.length;
    if (!query) {
      els.count.textContent = `${cues.length} subtítulos`;
    } else if (matches === 0) {
      els.count.textContent = "Sin resultados";
    } else {
      els.count.textContent = matches === 1 ? "1 resultado" : `${matches} resultados`;
    }
  }

  /** Salta al siguiente (o anterior) resultado desde el subtítulo actual. */
  function goToResult(direction) {
    if (!resultIndexes.length) return;
    const from = state.index;
    const target = direction > 0
      ? resultIndexes.find((i) => i > from) ?? resultIndexes[0]
      : [...resultIndexes].reverse().find((i) => i < from) ?? resultIndexes[resultIndexes.length - 1];
    goToIndex(target, "transcript");
  }

  els.search.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(applySearch, SEARCH_DELAY_MS);
  });

  els.search.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applySearch(); // por si aún no había pasado el debounce
      goToResult(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (els.search.value) {
        els.search.value = "";
        applySearch();
      } else {
        close();
      }
    }
  });

  /* ---------------- Abrir / cerrar ---------------- */
  function open() {
    els.panel.hidden = false;
    els.button.setAttribute("aria-expanded", "true");
    const row = query ? resultRows.get(state.index) : fullRows[state.index];
    if (row) reveal(row, true);
  }

  function close() {
    const hadFocus = els.panel.contains(document.activeElement);
    els.panel.hidden = true;
    els.button.setAttribute("aria-expanded", "false");
    if (hadFocus) els.button.focus();
  }

  const toggle = () => (els.panel.hidden ? open() : close());

  function focusSearch() {
    open();
    els.search.focus();
    els.search.select();
  }

  els.button.addEventListener("click", toggle);
  addShortcut("t", toggle);
  addShortcut("/", focusSearch);

  /* ---------------- Integración con la app ---------------- */
  function clearSearch() {
    window.clearTimeout(searchTimer);
    els.search.value = "";
    query = "";
    resultRows = new Map();
    resultIndexes = [];
    els.results.replaceChildren();
    els.results.hidden = true;
    els.list.hidden = false;
  }

  on("load", (detail) => {
    cues = detail.cues;
    prepared = new Array(cues.length);
    clearSearch();
    buildFullList();
    updateCount();
  });

  on("cue", ({ index, source }) => {
    // Al abrir un archivo o reanudar, el salto es instantáneo.
    markCurrent(index, { instant: source === "load" || source === "resume" });
  });

  on("reset", () => {
    close();
    clearSearch();
    cues = [];
    prepared = [];
    fullRows = [];
    els.list.replaceChildren(); // libera la memoria de las filas
  });
})();
