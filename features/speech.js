/* =====================================================================
   Captions Reader — features/speech.js
   FUNCIONALIDAD: lectura en voz alta (Web Speech API, sin dependencias).

   · Botón "Voz" (o tecla V): lee en voz alta cada subtítulo que aparece.
   · La voz se elige según el idioma detectado en los subtítulos
     (detectLanguage en captions-core.js); si el sistema no tiene una voz
     de ese idioma, se avisa y se usa la predeterminada.
   · Usa la misma velocidad que la reproducción (0,5× – 2×).
   · Durante la reproducción temporizada, si la frase aún no ha terminado
     al llegar el siguiente subtítulo, la reproducción ESPERA a que acabe
     (features.playback.addHold). Hay un tiempo máximo de seguridad por si
     el navegador no avisa del final (pasa en algunos motores de voz).
   · Si el navegador no tiene síntesis de voz, el botón no se muestra.
   ===================================================================== */

"use strict";

(() => {
  const synth = window.speechSynthesis;
  if (!synth || typeof window.SpeechSynthesisUtterance !== "function") return;

  const button = document.getElementById("voiceBtn");
  button.hidden = false;

  const languageNames = new Intl.DisplayNames(["es"], { type: "language" });

  let enabled = false;
  let speaking = false;
  let current = null;   // SpeechSynthesisUtterance en curso
  let safetyTimer = 0;
  let lang = null;      // idioma detectado ("es", "en"...)
  let voice = null;     // voz elegida para ese idioma
  let warnedNoVoice = false;

  /* ---------------- Elección de voz ---------------- */

  /** La mejor voz instalada para el idioma detectado (o null). */
  function pickVoice() {
    if (!lang) return null;
    const candidates = synth.getVoices().filter((v) => v.lang.toLowerCase().startsWith(lang));
    if (!candidates.length) return null;
    // Preferencias: misma variante que el navegador (es-ES vs es-MX),
    // la voz predeterminada del sistema y, por último, la primera.
    const preferred = navigator.language.toLowerCase();
    return candidates.find((v) => v.lang.toLowerCase() === preferred) ||
      candidates.find((v) => v.default) ||
      candidates[0];
  }

  // Las voces se cargan de forma asíncrona en algunos navegadores.
  const refreshVoice = () => { voice = pickVoice(); };
  if (typeof synth.addEventListener === "function") {
    synth.addEventListener("voiceschanged", refreshVoice);
  }

  function updateTitle() {
    const name = lang ? languageNames.of(lang) : null;
    button.title = name ? `Leer en voz alta (V) · ${name}` : "Leer en voz alta (V)";
  }

  /* ---------------- Hablar ---------------- */
  const clampRate = (rate) => Math.min(2, Math.max(0.5, rate));

  /** Tiempo máximo razonable para decir "text" (red de seguridad). */
  function maxDurationMs(text, rate) {
    return (text.length * 90) / rate + 3000;
  }

  function finished(utterance) {
    if (utterance !== current) return; // aviso de una frase ya cancelada
    window.clearTimeout(safetyTimer);
    current = null;
    speaking = false;
  }

  function stopSpeaking() {
    window.clearTimeout(safetyTimer);
    if (current) {
      // cancel() dispara "error" (interrupted) en la frase actual: se ignora.
      current.onend = null;
      current.onerror = null;
    }
    current = null;
    speaking = false;
    synth.cancel();
  }

  function speak(rawText) {
    stopSpeaking();
    const text = rawText.replace(/\s*\n\s*/g, " ").trim();
    if (!text) return;

    const rate = clampRate(features.playback?.getSpeed() ?? 1);
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = rate;
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } else if (lang) {
      utterance.lang = lang;
    }
    utterance.onend = () => finished(utterance);
    utterance.onerror = () => finished(utterance);

    current = utterance;
    speaking = true;
    safetyTimer = window.setTimeout(() => finished(utterance), maxDurationMs(text, rate));
    synth.speak(utterance);
  }

  /* ---------------- Activar / desactivar ---------------- */
  function enable() {
    enabled = true;
    button.setAttribute("aria-pressed", "true");
    refreshVoice();
    if (lang && !voice && synth.getVoices().length && !warnedNoVoice) {
      warnedNoVoice = true;
      showToast(`No hay una voz en ${languageNames.of(lang)} instalada; se usará la predeterminada.`);
    }
    const cue = state.cues[state.index];
    if (cue) speak(cue.text);
  }

  function disable() {
    enabled = false;
    button.setAttribute("aria-pressed", "false");
    stopSpeaking();
  }

  const toggle = () => (enabled ? disable() : enable());

  button.addEventListener("click", toggle);
  addShortcut("v", toggle);

  /* ---------------- Integración con la app ---------------- */
  on("load", ({ cues }) => {
    stopSpeaking();
    // Con unas decenas de subtítulos basta para saber el idioma.
    lang = detectLanguage(cues.slice(0, 200).map((cue) => cue.text));
    warnedNoVoice = false;
    refreshVoice();
    updateTitle();
  });

  on("cue", ({ cue }) => {
    if (enabled) speak(cue.text);
  });

  on("reset", stopSpeaking);

  // La reproducción temporizada espera a que termine la frase.
  features.playback?.addHold(() => enabled && speaking);

  features.speech = {
    isEnabled: () => enabled,
    isSpeaking: () => speaking,
  };
})();
