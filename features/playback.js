/* =====================================================================
   Captions Reader — features/playback.js
   FUNCIONALIDAD: reproducción temporizada.

   "Reproducir" avanza solo, respetando los tiempos reales del .srt, a la
   velocidad elegida (0,5× – 2×). Útil como teleprompter o para estudiar
   idiomas.

   · Reloj propio basado en performance.now(): la velocidad es la misma en
     una pantalla de 60 Hz, de 120 Hz o en un equipo lento.
   · Con la pestaña visible se actualiza con requestAnimationFrame (reloj
     fluido); oculta, con setTimeout (sigue avanzando en segundo plano).
   · Entre el final de un subtítulo y el inicio del siguiente el texto se
     atenúa (no hay diálogo en ese tramo).
   · Moverse a mano (flechas, Saltar a, transcripción) mientras reproduce
     continúa desde el subtítulo elegido.
   · Atajo: P.
   ===================================================================== */

"use strict";

(() => {
  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const SPEED_KEY = "captions-reader:speed";
  const HIDDEN_TICK_MS = 250; // ritmo con la pestaña oculta

  const els = {
    button: document.getElementById("playBtn"),
    label: document.getElementById("playLabel"),
    playIcon: document.getElementById("playIcon"),
    pauseIcon: document.getElementById("pauseIcon"),
    speed: document.getElementById("speedSelect"),
    clock: document.getElementById("playClock"),
  };

  let playing = false;
  let finished = false; // terminó sola al llegar al final
  let clockMs = 0;      // posición en la línea de tiempo del .srt
  let lastNow = 0;      // performance.now() del último paso
  let frame = 0;        // id de requestAnimationFrame
  let timer = 0;        // id de setTimeout (pestaña oculta)
  let shownSecond = -1; // para repintar el reloj solo cuando cambia

  /* ---------------- Velocidad (se recuerda entre visitas) ---------------- */
  try {
    const saved = Number(localStorage.getItem(SPEED_KEY));
    if (SPEEDS.includes(saved)) els.speed.value = String(saved);
  } catch (_) { /* almacenamiento no disponible: se usa 1× */ }

  const getSpeed = () => Number(els.speed.value) || 1;

  els.speed.addEventListener("change", () => {
    try { localStorage.setItem(SPEED_KEY, els.speed.value); } catch (_) {}
  });

  /* ---------------- Motor ---------------- */
  function scheduleStep() {
    if (!playing) return;
    if (document.hidden) timer = window.setTimeout(step, HIDDEN_TICK_MS);
    else frame = window.requestAnimationFrame(step);
  }

  function cancelStep() {
    window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
    frame = 0;
    timer = 0;
  }

  function step() {
    frame = 0;
    timer = 0;
    if (!playing || !state.cues.length) return;

    const now = performance.now();
    const elapsed = (now - lastNow) * getSpeed();
    lastNow = now;

    const { cues } = state;
    let index = state.index;
    clockMs += elapsed;

    // Puede saltar varios de golpe (p. ej. tras volver a la pestaña).
    const target = findCueIndexBefore(cues, clockMs);
    if (target > index) {
      goToIndex(target, "playback");
      index = target;
    }

    const cue = cues[index];
    const isLast = index === cues.length - 1;
    if (isLast && clockMs >= cue.endMs) {
      finish();
      return;
    }

    dom.captionText.classList.toggle("is-gap", clockMs > cue.endMs);
    renderClock();
    scheduleStep();
  }

  /* ---------------- Controles ---------------- */
  function play() {
    if (playing || !state.cues.length) return;

    // Terminó la última vez: vuelve a empezar desde el principio.
    if (finished && state.index === state.cues.length - 1) goToIndex(0, "user");
    finished = false;

    // Si se pausó dentro del subtítulo actual, continúa desde ahí; si no,
    // empieza desde su inicio.
    const cue = state.cues[state.index];
    const next = state.cues[state.index + 1];
    const inside = clockMs >= cue.startMs && (!next || clockMs < next.startMs);
    if (!inside) clockMs = cue.startMs;

    playing = true;
    lastNow = performance.now();
    updateUi();
    scheduleStep();
  }

  function pause() {
    if (!playing) return;
    playing = false;
    cancelStep();
    dom.captionText.classList.remove("is-gap");
    updateUi();
  }

  function finish() {
    pause();
    finished = true;
  }

  /** Detiene y olvida la posición (al abrir otro archivo o volver atrás). */
  function stop() {
    pause();
    finished = false;
    clockMs = 0;
  }

  const toggle = () => (playing ? pause() : play());

  function renderClock() {
    const second = Math.floor(clockMs / 1000);
    if (second === shownSecond) return;
    shownSecond = second;
    els.clock.textContent = formatClock(clockMs);
  }

  function updateUi() {
    els.button.classList.toggle("is-playing", playing);
    els.label.textContent = playing ? "Pausar" : "Reproducir";
    // Son <svg>: no tienen la propiedad .hidden de los elementos HTML.
    els.playIcon.toggleAttribute("hidden", playing);
    els.pauseIcon.toggleAttribute("hidden", !playing);
    els.clock.hidden = !playing;
    if (playing) {
      shownSecond = -1;
      renderClock();
    }
  }

  /* ---------------- Integración con la app ---------------- */
  els.button.addEventListener("click", toggle);
  addShortcut("p", toggle);

  // Moverse a mano mientras reproduce: continúa desde el subtítulo elegido.
  on("cue", ({ cue, source }) => {
    if (source === "playback") return;
    dom.captionText.classList.remove("is-gap");
    clockMs = cue.startMs;
    finished = false;
    if (playing) {
      lastNow = performance.now();
      renderClock();
    }
  });

  on("load", stop);
  on("reset", stop);

  // Al volver a la pestaña, se pasa de setTimeout a requestAnimationFrame.
  document.addEventListener("visibilitychange", () => {
    if (!playing) return;
    cancelStep();
    scheduleStep();
  });
})();
