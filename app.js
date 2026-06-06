/* =====================================================================
   Captions Reader — app.js
   Vanilla JavaScript (ES6+). Sin frameworks ni librerías.

   Responsabilidades del módulo:
     1) Parsear el contenido de un archivo .srt a una estructura de datos.
     2) Gestionar los dos estados de la interfaz (espera / activo).
     3) Navegar subtítulo a subtítulo (flechas y teclado).
   ===================================================================== */

"use strict";

/* ---------------------------------------------------------------------
   1) REFERENCIAS AL DOM
   Se capturan una sola vez al inicio para no consultar el DOM repetidamente.
   --------------------------------------------------------------------- */
const dom = {
  uploader:    document.getElementById("uploader"),
  dropzone:    document.getElementById("dropzone"),
  fileInput:   document.getElementById("fileInput"),
  error:       document.getElementById("error"),

  reader:      document.getElementById("reader"),
  prevBtn:     document.getElementById("prevBtn"),
  nextBtn:     document.getElementById("nextBtn"),
  resetBtn:    document.getElementById("resetBtn"),
  captionText: document.getElementById("captionText"),
  timecode:    document.getElementById("timecode"),
  counter:     document.getElementById("counter"),
  progressBar: document.getElementById("progressBar"),
  copyBtn:     document.getElementById("copyBtn"),
  copyLabel:   document.getElementById("copyLabel"),
  tagline:     document.getElementById("tagline"),

  // Modal "Saltar a"
  jumpBtn:     document.getElementById("jumpBtn"),
  jumpModal:   document.getElementById("jumpModal"),
  jumpOverlay: document.getElementById("jumpOverlay"),
  jumpCancel:  document.getElementById("jumpCancel"),
  jumpAccept:  document.getElementById("jumpAccept"),
  wheelHours:   document.getElementById("wheelHours"),
  wheelMinutes: document.getElementById("wheelMinutes"),
  wheelSeconds: document.getElementById("wheelSeconds"),
};

// Texto que muestra el tagline cuando no hay archivo cargado.
const DEFAULT_TAGLINE = "Lector de subtítulos · formato .srt";

/* ---------------------------------------------------------------------
   2) ESTADO DE LA APLICACIÓN
   "cues" guarda la lista de subtítulos; "index" el que se muestra ahora.
   --------------------------------------------------------------------- */
const state = {
  cues: [],   // Array de objetos { start, end, text }
  index: 0,   // Posición actual dentro de cues
};

/* ---------------------------------------------------------------------
   3) LIMPIEZA DEL TEXTO DEL SUBTÍTULO
   Objetivo: mostrar SOLO texto limpio.
     - Se eliminan etiquetas HTML.  <i>Hola</i>           -> Hola
     - Se eliminan segmentos entre corchetes.  [música]    -> (se quita)
     - Se decodifican entidades HTML comunes.  &amp;        -> &
   Si tras la limpieza no queda texto, el subtítulo se descartará
   por completo (no se mostrará).
   --------------------------------------------------------------------- */

/**
 * Decodifica las entidades HTML más habituales sin depender del DOM
 * (funciona perfectamente al abrir el archivo con file://).
 * @param {string} str
 * @returns {string}
 */
function decodeEntities(str) {
  const map = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
  };
  return str.replace(/&[a-zA-Z#0-9]+;/g, (entity) => map[entity] || entity);
}

/**
 * Limpia el texto de un subtítulo.
 * @param {string} text
 * @returns {string} Texto limpio (puede quedar vacío).
 */
function cleanText(text) {
  let result = text;

  // 1) Quita las etiquetas HTML/SRT del tipo <i>, </i>, <font ...>, etc.
  result = result.replace(/<[^>]*>/g, "");

  // 2) Quita los segmentos entre corchetes, p. ej. "[intriguing music playing]".
  //    El patrón también abarca corchetes que ocupen varias líneas.
  result = result.replace(/\[[^\]]*\]/g, "");

  // 3) Quita los segmentos entre llaves, p. ej. el código de posición "{\an8}".
  //    Funciona tanto si la línea es solo "{...}" (quedará vacía y se omitirá)
  //    como si mezcla texto: "{\an8}♪ The colors... ♪" -> "♪ The colors... ♪".
  result = result.replace(/\{[^}]*\}/g, "");

  // 4) Decodifica entidades HTML comunes (&amp;, &#39;, etc.).
  result = decodeEntities(result);

  // 5) Normaliza espacios: limpia cada línea y descarta las que queden vacías.
  result = result
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();

  return result;
}

/* ---------------------------------------------------------------------
   EXTRACCIÓN DEL TÍTULO DE LA OBRA (a partir del nombre del archivo)
   Sigue 4 fases: sanitización, radar de basura técnica, guillotina y pulido.
   --------------------------------------------------------------------- */

/* FASE 2 — RADAR: patrones que representan "basura técnica".
   No son palabras exactas, sino patrones (temporada, resolución, origen,
   códec, audio, año...). Se compilan UNA sola vez en una regex combinada.
   Los \b se añaden al unir, así cada patrón respeta límites de palabra. */
const GARBAGE_PATTERN_SOURCES = [
  "S\\d{1,2}E\\d{1,2}",        // temporada + episodio: S01E01
  "\\d{1,2}x\\d{2}",           // formato alternativo: 1x02
  "S\\d{1,2}",                 // solo temporada: S01
  "\\d{3,4}p",                 // resolución: 1080p, 720p, 480p
  "2160p", "4k", "uhd",        // resolución / calidad
  // Orígenes de ripeo y plataformas:
  "web[ -]?dl", "webrip", "web", "bluray", "brrip", "bdrip", "hdtv",
  "dvdrip", "hdrip", "remux", "telesync", "hdcam", "cam",
  "amzn", "nf", "hmax", "dsnp", "atvp", "hulu", "max",
  // Códecs de vídeo:
  "x26[45]", "h\\s?26[45]", "hevc", "avc", "xvid", "divx",
  // Audio:
  "ddp?\\d?", "dts", "ac3", "aac", "atmos", "truehd", "flac",
  // Año (1900–2099):
  "(?:19|20)\\d{2}",
];

// Regex combinada e insensible a mayúsculas. Sin flag "g": search() devuelve
// siempre el índice del primer match (el más a la izquierda).
const GARBAGE_REGEX = new RegExp(
  "\\b(?:" + GARBAGE_PATTERN_SOURCES.join("|") + ")\\b",
  "i"
);

/**
 * FASE 3 (parte) — Devuelve el índice donde empieza la primera "basura técnica",
 * o -1 si no hay ninguna.
 * @param {string} text - Nombre ya sanitizado (con espacios).
 * @returns {number}
 */
function findFirstGarbageIndex(text) {
  return text.search(GARBAGE_REGEX);
}

/**
 * FASE 4 — Pulido: elimina espacios y guiones medios "huérfanos" del extremo
 * derecho (p. ej. "Spider-Noir - " -> "Spider-Noir"). Conserva los guiones
 * internos legítimos (Spider-Noir).
 * @param {string} str
 * @returns {string}
 */
function polishTitle(str) {
  return str.trim().replace(/[\s-]+$/, "").trim();
}

/**
 * Detecta temporada y episodio en el nombre sanitizado.
 * Admite los formatos "S01E01" y "1x02".
 * @param {string} text
 * @returns {{season:number, episode:number, index:number, length:number}|null}
 */
function detectSeasonEpisode(text) {
  let match = text.match(/\bS(\d{1,2})E(\d{1,2})\b/i);   // S01E01
  if (!match) {
    match = text.match(/\b(\d{1,2})x(\d{2})\b/i);        // 1x02
  }
  if (!match) return null;

  return {
    season: parseInt(match[1], 10),
    episode: parseInt(match[2], 10),
    index: match.index,
    length: match[0].length,
  };
}

/**
 * Extrae el nombre del episodio: el texto que va DESPUÉS del token de
 * temporada/episodio y ANTES de la siguiente basura técnica.
 * @param {string} text - Nombre sanitizado.
 * @param {number} fromIndex - Posición donde termina el token S01E01.
 * @returns {string} Nombre del episodio (puede quedar vacío).
 */
function extractEpisodeTitle(text, fromIndex) {
  const rest = text.slice(fromIndex);
  const garbageIndex = findFirstGarbageIndex(rest);
  const raw = garbageIndex === -1 ? rest : rest.slice(0, garbageIndex);
  return polishTitle(raw);
}

/**
 * Algoritmo principal: a partir del nombre de archivo, devuelve el título
 * limpio y formateado para mostrar en el tagline.
 * @param {string} filename - Nombre del archivo, p. ej. "Michael.2026.1080p...srt".
 * @returns {string}
 */
function extractTitleFromFilename(filename) {
  if (!filename) return "Información no disponible";

  // ---- FASE 1: Sanitización ----
  // a) Amputar la extensión .srt del final.
  let name = filename.replace(/\.srt$/i, "");
  // b) Puntos y guiones bajos -> espacios. Los guiones medios se respetan.
  name = name.replace(/[._]+/g, " ");
  // c) Colapsar espacios repetidos.
  name = name.replace(/\s+/g, " ").trim();

  if (!name) return "Información no disponible";

  // ---- FASE 3: Guillotina (corte en la primera basura técnica) ----
  const cutIndex = findFirstGarbageIndex(name);
  const rawWorkName = cutIndex === -1 ? name : name.slice(0, cutIndex);

  // ---- FASE 4: Pulido del nombre de la obra ----
  const workName = polishTitle(rawWorkName);

  // Si tras cortar no queda nombre alguno, no hay información utilizable.
  if (!workName) return "Información no disponible";

  // ---- Decisión: película vs serie ----
  const se = detectSeasonEpisode(name);
  const hasYear = /\b(?:19|20)\d{2}\b/.test(name);

  // Caso A) Serie con temporada y episodio identificados.
  if (se) {
    const episodeTitle = extractEpisodeTitle(name, se.index + se.length);
    const base = `${workName} | Temporada ${se.season}, episodio ${se.episode}`;
    return episodeTitle ? `${base}: '${episodeTitle}'` : base;
  }

  // Caso B) Película: hay un año pero no temporada/episodio. Solo el nombre.
  if (hasYear) {
    return workName;
  }

  // Caso C) Obra sin año ni temporada/episodio: se trata como serie sin datos.
  return `${workName} | Temporada: No identificada, episodio no identificado`;
}

/* ---------------------------------------------------------------------
   4) PARSER DE .SRT
   Un archivo .srt se compone de bloques separados por una línea en blanco:

       1
       00:00:01,000 --> 00:00:04,000
       Texto del subtítulo
       (puede ocupar varias líneas)

   Devuelve un array de "cues". Es tolerante con:
     - Saltos de línea Windows (\r\n) y Unix (\n).
     - BOM al inicio del archivo.
     - Bloques sin número de índice.
     - Espacios o líneas en blanco extra entre bloques.
   --------------------------------------------------------------------- */

/**
 * Convierte el texto completo de un .srt en una lista de subtítulos.
 * @param {string} raw - Contenido bruto del archivo.
 * @returns {Array<{start: string, end: string, text: string}>}
 */
function parseSRT(raw) {
  // Elimina el BOM (carácter invisible al inicio de algunos archivos)
  // y normaliza todos los saltos de línea a "\n".
  const normalized = raw
    .replace(/^\uFEFF/, "")
    .replace(/\r\n|\r/g, "\n")
    .trim();

  // Separa en bloques: una o más líneas vacías actúan como divisor.
  const blocks = normalized.split(/\n{2,}/);

  // Expresión regular para la línea de tiempos: "hh:mm:ss,mmm --> hh:mm:ss,mmm"
  const timeRegex =
    /(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/;

  const cues = [];

  for (const block of blocks) {
    const lines = block.split("\n");

    // Busca en qué línea está la marca de tiempo (suele ser la 1ª o la 2ª,
    // según si el bloque incluye número de índice o no).
    const timeLineIndex = lines.findIndex((line) => timeRegex.test(line));
    if (timeLineIndex === -1) continue; // bloque sin tiempos -> se ignora

    const match = lines[timeLineIndex].match(timeRegex);
    const start = match[1];
    const end = match[2];

    // El texto es todo lo que viene después de la línea de tiempos.
    const rawText = lines
      .slice(timeLineIndex + 1)
      .join("\n")
      .trim();

    // Se limpia: sin etiquetas HTML, sin corchetes, sin entidades.
    const text = cleanText(rawText);

    // Solo guardamos cues que conserven texto real tras limpiar.
    // Así, un subtítulo como "[intriguing music playing]" se omite por completo.
    if (text) {
      cues.push({ start, end, text });
    }
  }

  return cues;
}

/* ---------------------------------------------------------------------
   4) UTILIDADES DE FORMATO
   --------------------------------------------------------------------- */

/**
 * Da formato a la línea de tiempos para mostrarla en la tarjeta.
 * Reemplaza la flecha "-->" por "→" para una estética más limpia.
 */
function formatTimecode(cue) {
  return `${cue.start} → ${cue.end}`;
}

/* ---------------------------------------------------------------------
   5) RENDERIZADO DE LA INTERFAZ
   --------------------------------------------------------------------- */

/**
 * Pinta en pantalla el subtítulo correspondiente al índice actual y
 * actualiza metadatos, contador, barra de progreso y botones.
 */
function renderCurrentCue() {
  const cue = state.cues[state.index];
  if (!cue) return;

  // Texto principal. Reinicia la animación "is-changing" forzando un reflow.
  dom.captionText.classList.remove("is-changing");
  void dom.captionText.offsetWidth; // truco para reiniciar la animación CSS
  dom.captionText.textContent = cue.text;
  dom.captionText.classList.add("is-changing");

  // Metadatos
  dom.timecode.textContent = formatTimecode(cue);
  dom.counter.textContent = `${state.index + 1} / ${state.cues.length}`;

  // Barra de progreso (porcentaje según la posición en la lista)
  const percent = ((state.index + 1) / state.cues.length) * 100;
  dom.progressBar.style.width = `${percent}%`;

  // Habilita/deshabilita las flechas según haya o no más subtítulos.
  dom.prevBtn.disabled = state.index === 0;
  dom.nextBtn.disabled = state.index === state.cues.length - 1;
}

/* ---------------------------------------------------------------------
   6) NAVEGACIÓN
   --------------------------------------------------------------------- */

/**
 * Avanza (+1) o retrocede (-1) un subtítulo, sin salirse de los límites.
 * @param {number} step - Normalmente +1 o -1.
 */
function navigate(step) {
  const next = state.index + step;
  // clamp: mantiene el índice dentro del rango válido [0, length - 1]
  if (next < 0 || next >= state.cues.length) return;
  state.index = next;
  renderCurrentCue();
}

/* ---------------------------------------------------------------------
   COPIAR AL PORTAPAPELES
   La API moderna (navigator.clipboard) requiere un contexto seguro
   (https o localhost) y NO funciona al abrir con file://. Por eso se
   incluye un respaldo con un <textarea> temporal + execCommand("copy"),
   que sí funciona al abrir el .html directamente.
   --------------------------------------------------------------------- */

/**
 * Respaldo de copiado para contextos no seguros (file://).
 * @param {string} text
 * @returns {boolean} true si se copió correctamente.
 */
function fallbackCopy(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  // Lo dejamos fuera de la vista para que no provoque saltos de scroll.
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  let success = false;
  try {
    success = document.execCommand("copy");
  } catch (_) {
    success = false;
  }

  document.body.removeChild(textarea);
  return success;
}

/**
 * Copia el texto del subtítulo actual. Intenta la API moderna y,
 * si no está disponible, usa el respaldo.
 */
async function copyCurrentCue() {
  const cue = state.cues[state.index];
  if (!cue) return;

  // Se aplana el texto para el portapapeles: cualquier salto de línea
  // (con sus espacios alrededor) se sustituye por un único espacio.
  // Así "Someone once asked me\nwhat universe this was." se copia como
  // "Someone once asked me what universe this was." en una sola línea.
  // El texto que se MUESTRA en pantalla no cambia; solo lo que se copia.
  const textToCopy = cue.text.replace(/\s*\n\s*/g, " ").trim();

  let copied = false;

  // Intento con la API moderna solo si existe y el contexto es seguro.
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(textToCopy);
      copied = true;
    } catch (_) {
      copied = false;
    }
  }

  // Respaldo (necesario al abrir con file://).
  if (!copied) {
    copied = fallbackCopy(textToCopy);
  }

  showCopyFeedback(copied);
}

/**
 * Da retroalimentación visual breve tras pulsar "Copiar".
 * @param {boolean} success
 */
function showCopyFeedback(success) {
  dom.copyLabel.textContent = success ? "¡Copiado!" : "No se pudo copiar";
  dom.copyBtn.classList.add("is-copied");

  // Vuelve al estado normal pasado un momento.
  window.clearTimeout(showCopyFeedback._timer);
  showCopyFeedback._timer = window.setTimeout(() => {
    dom.copyLabel.textContent = "Copiar";
    dom.copyBtn.classList.remove("is-copied");
  }, 1400);
}

/* ---------------------------------------------------------------------
   COMPONENTE: WheelPicker — rueda estilo iOS (UIPickerView)
   Replica la rueda de selección de Apple en Vanilla JS:
     · Proyección cilíndrica 3D (escala por coseno, rotateX, fade exponencial).
     · Física de inercia con fricción al lanzar (flick).
     · Anclaje magnético (snap) con animación de resorte al detenerse.
   Cada instancia es independiente del resto.
   --------------------------------------------------------------------- */
class WheelPicker {
  /**
   * @param {HTMLElement} el     - Contenedor .wheel donde se inyectan los números.
   * @param {number} length      - Cantidad de valores (24 horas, 60 min/seg).
   */
  constructor(el, length) {
    this.el = el;
    this.length = length;

    // --- Constantes geométricas (coinciden con el CSS) ---
    this.itemHeight = 40;   // alto de cada número en px
    this.angleStep = 18;    // grados que separan un número del siguiente
    // Radio del cilindro: hace que números contiguos disten ~itemHeight cerca del centro.
    this.radius = this.itemHeight / Math.sin((this.angleStep * Math.PI) / 180);

    // --- Estado dinámico ---
    this.position = 0;      // índice "flotante" actual (0..length-1)
    this.velocity = 0;      // velocidad en unidades por frame
    this.target = 0;        // objetivo del anclaje (snap)
    this.mode = "idle";     // "idle" | "momentum" | "snap"
    this.raf = null;        // id del requestAnimationFrame en curso

    // --- Constantes de física (ajustadas para imitar a iOS) ---
    this.SENSITIVITY = 0.65; // <1 = menos sensible (hay que arrastrar más por número)
    this.FRICTION = 0.92;    // desaceleración por frame al lanzar (tasa q)
    this.MAX_VELOCITY = 0.8; // tope de velocidad para no "pasarse" de número
    this.V_MIN = 0.025;      // umbral: por debajo, se activa el imán (snap)
    this.SPRING_K = 0.16;    // rigidez del resorte del snap
    this.SPRING_DAMP = 0.74; // amortiguación del resorte (deja un leve rebote)

    this.items = [];
    this._buildItems();
    this._bindEvents();
    this.render();
  }

  /* Crea los elementos numéricos una sola vez. */
  _buildItems() {
    this.el.innerHTML = "";
    for (let i = 0; i < this.length; i++) {
      const item = document.createElement("div");
      item.className = "wheel__item";
      item.textContent = String(i).padStart(2, "0");
      this.el.appendChild(item);
      this.items.push(item);
    }
  }

  /* Mantiene un valor dentro del rango válido [0, length-1]. */
  _clamp(p) {
    return Math.max(0, Math.min(this.length - 1, p));
  }

  /* Devuelve el valor seleccionado (el número anclado en el centro). */
  getValue() {
    return this._clamp(Math.round(this.position));
  }

  /* Coloca la rueda en un valor concreto (sin animación). */
  setValue(value) {
    this._stop();
    this.position = this._clamp(value);
    this.velocity = 0;
    this.mode = "idle";
    this.render();
  }

  /* ---- FASE VISUAL: proyección cilíndrica 3D de cada número ---- */
  render() {
    const selected = Math.round(this.position);
    for (let i = 0; i < this.length; i++) {
      const unit = i - this.position;          // distancia en "ítems" al centro
      const angle = unit * this.angleStep;     // ángulo sobre el cilindro
      const item = this.items[i];

      // Más allá de ±90° el número está en la cara oculta del cilindro: se esconde.
      if (Math.abs(angle) >= 90) {
        item.style.display = "none";
        continue;
      }
      item.style.display = "";

      const rad = (angle * Math.PI) / 180;
      // Posición vertical proyectada (los números se juntan al alejarse: cilindro).
      const translateY = this.radius * Math.sin(rad);
      // Escala vertical por coseno: 1.0 en el centro, 0.4 en los extremos.
      const scaleY = 0.4 + 0.6 * Math.cos(rad);
      // Opacidad con caída exponencial: 100% centro -> 0% antes del borde.
      const opacity = Math.pow(Math.max(0, Math.cos(rad)), 1.6);
      // rotateX: arriba (unit<0 -> ángulo<0) se inclina hacia atrás; abajo hacia delante.
      item.style.transform =
        `translateY(${translateY.toFixed(2)}px) scaleY(${scaleY.toFixed(3)}) rotateX(${angle.toFixed(2)}deg)`;
      item.style.opacity = opacity.toFixed(3);
      item.classList.toggle("is-selected", i === selected);
    }
  }

  /* ---- FASE FÍSICA: bucle de animación (inercia + snap) ---- */
  _start() {
    if (this.raf) return;
    const loop = () => {
      if (this.mode === "momentum") {
        // Inercia: avanza y se frena por fricción cada frame.
        this.position += this.velocity;
        this.velocity *= this.FRICTION;

        // Si se sale del rango, pasa directo al imán contra el borde.
        if (this.position < 0 || this.position > this.length - 1) {
          this.mode = "snap";
          this.target = this._clamp(Math.round(this.position));
        } else if (Math.abs(this.velocity) < this.V_MIN) {
          // Velocidad muy baja: se activa el imán hacia el número más cercano.
          this.mode = "snap";
          this.target = this._clamp(Math.round(this.position));
        }
      } else if (this.mode === "snap") {
        // Resorte elástico que atrae la posición hacia el objetivo.
        const force = (this.target - this.position) * this.SPRING_K;
        this.velocity = (this.velocity + force) * this.SPRING_DAMP;
        this.position += this.velocity;

        // Cuando casi no hay movimiento, se fija exacto y termina.
        if (Math.abs(this.target - this.position) < 0.001 &&
            Math.abs(this.velocity) < 0.001) {
          this.position = this.target;
          this.velocity = 0;
          this.mode = "idle";
        }
      }

      this.render();

      if (this.mode === "idle") {
        this.raf = null; // detiene el bucle
      } else {
        this.raf = requestAnimationFrame(loop);
      }
    };
    this.raf = requestAnimationFrame(loop);
  }

  /* Detiene cualquier animación en curso. */
  _stop() {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
    this.mode = "idle";
  }

  /* ---- ENTRADA: gestos de arrastre, lanzamiento y rueda del ratón ---- */
  _bindEvents() {
    let dragging = false;
    let startY = 0;
    let startPos = 0;
    let lastY = 0;
    let lastT = 0;

    const onDown = (e) => {
      dragging = true;
      this._stop();
      this.velocity = 0;
      startY = e.clientY;
      startPos = this.position;
      lastY = e.clientY;
      lastT = performance.now();
      this.el.setPointerCapture(e.pointerId);
    };

    const onMove = (e) => {
      if (!dragging) return;
      // Arrastrar hacia arriba aumenta el índice (igual que en iOS).
      // SENSITIVITY < 1 hace que cueste un poco más cambiar de número (más control).
      let next = startPos + ((startY - e.clientY) / this.itemHeight) * this.SENSITIVITY;

      // Efecto "rubber band": fuera de los límites, el arrastre se resiste.
      if (next < 0) next = next / 3;
      if (next > this.length - 1) next = (this.length - 1) + (next - (this.length - 1)) / 3;
      this.position = next;

      // Estimación de velocidad instantánea (unidades por frame ≈ 16 ms).
      const now = performance.now();
      const dt = now - lastT;
      if (dt > 0) {
        const dPos = ((lastY - e.clientY) / this.itemHeight) * this.SENSITIVITY;
        this.velocity = (dPos / dt) * 16.67;
      }
      lastY = e.clientY;
      lastT = now;

      this.render();
    };

    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      try { this.el.releasePointerCapture(e.pointerId); } catch (_) {}
      // Limita la velocidad de lanzamiento para no saltarse números.
      this.velocity = Math.max(-this.MAX_VELOCITY,
                               Math.min(this.MAX_VELOCITY, this.velocity));
      // Lanza la inercia (o el imán si apenas hubo velocidad).
      this.mode = "momentum";
      this._start();
    };

    this.el.addEventListener("pointerdown", onDown);
    this.el.addEventListener("pointermove", onMove);
    this.el.addEventListener("pointerup", onUp);
    this.el.addEventListener("pointercancel", onUp);

    // Rueda del ratón: avanza/retrocede un número con anclaje suave.
    this.el.addEventListener("wheel", (e) => {
      e.preventDefault();
      this._stop();
      this.target = this._clamp(Math.round(this.position) + Math.sign(e.deltaY));
      this.velocity = 0;
      this.mode = "snap";
      this._start();
    }, { passive: false });
  }
}

/* ---------------------------------------------------------------------
   SALTAR A UNA MARCA DE TIEMPO (modal)
   --------------------------------------------------------------------- */

/**
 * Convierte una marca de tiempo "HH:MM:SS,mmm" a milisegundos totales.
 * Sirve tanto para los tiempos de inicio del .srt como para el input.
 * @param {string} timecode
 * @returns {number|null} Milisegundos, o null si el formato no es válido.
 */
function timecodeToMs(timecode) {
  const match = timecode.match(/(\d{1,2}):(\d{2}):(\d{2}),(\d{1,3})/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  // Rellena los milisegundos a 3 cifras por si vinieran con menos (",5" -> 500).
  const millis = Number(match[4].padEnd(3, "0"));

  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

// Instancias de las tres ruedas (se crean una sola vez, al primer uso).
let hoursWheel = null;
let minutesWheel = null;
let secondsWheel = null;

/** Crea las ruedas la primera vez que se abre el modal. */
function ensureWheels() {
  if (hoursWheel) return;
  hoursWheel = new WheelPicker(dom.wheelHours, 24);   // 00–23
  minutesWheel = new WheelPicker(dom.wheelMinutes, 60); // 00–59
  secondsWheel = new WheelPicker(dom.wheelSeconds, 60); // 00–59
}

/** Abre el modal. Las tres ruedas siempre parten desde 0. */
function openJumpModal() {
  ensureWheels();

  // Reinicio limpio: cada vez que se abre, todas las ruedas vuelven a 0.
  hoursWheel.setValue(0);
  minutesWheel.setValue(0);
  secondsWheel.setValue(0);

  dom.jumpModal.hidden = false;
}

/** Cierra el modal sin realizar ninguna acción. */
function closeJumpModal() {
  dom.jumpModal.hidden = true;
}

/**
 * Lee la hora elegida en las ruedas y salta al subtítulo cuyo tiempo de
 * inicio esté MÁS CERCA del seleccionado.
 */
function confirmJump() {
  // Valores de las ruedas, con relleno a 2 dígitos.
  const hh = String(hoursWheel.getValue()).padStart(2, "0");
  const mm = String(minutesWheel.getValue()).padStart(2, "0");
  const ss = String(secondsWheel.getValue()).padStart(2, "0");

  // Se concatena ",000" para igualar la sintaxis del .srt (HH:MM:SS,000).
  const targetMs = timecodeToMs(`${hh}:${mm}:${ss},000`);

  // Algoritmo de proximidad: menor diferencia absoluta de milisegundos.
  let bestIndex = 0;
  let bestDiff = Infinity;
  state.cues.forEach((cue, i) => {
    const cueMs = timecodeToMs(cue.start);
    if (cueMs === null) return;
    const diff = Math.abs(cueMs - targetMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIndex = i;
    }
  });

  // Salto de UI: actualiza el índice, cierra el modal y muestra el subtítulo.
  state.index = bestIndex;
  closeJumpModal();
  renderCurrentCue();
}

/* ---------------------------------------------------------------------
   7) TRANSICIONES ENTRE ESTADOS DE LA UI
   --------------------------------------------------------------------- */

/** Pasa al estado activo: oculta la carga y muestra el controlador. */
function showReader() {
  dom.uploader.hidden = true;
  dom.reader.hidden = false;
}

/** Vuelve al estado de espera: limpia datos y muestra la zona de carga. */
function resetToUploader() {
  state.cues = [];
  state.index = 0;
  dom.reader.hidden = true;
  dom.uploader.hidden = false;
  dom.fileInput.value = ""; // permite volver a elegir el mismo archivo
  dom.tagline.textContent = DEFAULT_TAGLINE; // restaura el subtítulo de la marca
  closeJumpModal(); // por si quedó abierto
  clearError();
}

/* ---------------------------------------------------------------------
   8) MANEJO DE ERRORES (mensajes para el usuario)
   --------------------------------------------------------------------- */

function showError(message) {
  dom.error.textContent = message;
  dom.error.classList.add("is-visible");
}

function clearError() {
  dom.error.textContent = "";
  dom.error.classList.remove("is-visible");
}

/* ---------------------------------------------------------------------
   9) CARGA Y PROCESADO DEL ARCHIVO
   --------------------------------------------------------------------- */

/**
 * Recibe un objeto File, valida la extensión, lo lee y lo parsea.
 * Si todo va bien, cambia al estado activo y muestra el primer subtítulo.
 * @param {File} file
 */
function handleFile(file) {
  clearError();

  // Validación básica de extensión.
  if (!file || !/\.srt$/i.test(file.name)) {
    showError("Por favor, selecciona un archivo con extensión .srt");
    return;
  }

  const reader = new FileReader();

  // Cuando termina de leer, parseamos el contenido.
  reader.onload = (event) => {
    const cues = parseSRT(event.target.result);

    if (cues.length === 0) {
      showError("No se encontraron subtítulos válidos en el archivo.");
      return;
    }

    // Guardamos en el estado y arrancamos el controlador.
    state.cues = cues;
    state.index = 0;
    // Extrae y muestra el título limpio de la obra en el tagline.
    dom.tagline.textContent = extractTitleFromFilename(file.name);
    showReader();
    renderCurrentCue();
  };

  // Si la lectura falla (archivo corrupto, permisos, etc.).
  reader.onerror = () => {
    showError("Ocurrió un error al leer el archivo. Inténtalo de nuevo.");
  };

  // Lectura como texto UTF-8 (codificación habitual de los .srt).
  reader.readAsText(file, "UTF-8");
}

/* ---------------------------------------------------------------------
   10) EVENTOS
   --------------------------------------------------------------------- */

// 10.1) Selección de archivo mediante el input.
dom.fileInput.addEventListener("change", (event) => {
  const file = event.target.files[0];
  handleFile(file);
});

// 10.2) Soporte de "arrastrar y soltar" sobre la zona de carga.
// Hay que prevenir el comportamiento por defecto del navegador (abrir el archivo).
["dragenter", "dragover"].forEach((type) => {
  dom.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dom.dropzone.classList.add("is-dragover");
  });
});

["dragleave", "drop"].forEach((type) => {
  dom.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dom.dropzone.classList.remove("is-dragover");
  });
});

dom.dropzone.addEventListener("drop", (event) => {
  const file = event.dataTransfer.files[0];
  handleFile(file);
});

// 10.3) Botones de navegación.
dom.prevBtn.addEventListener("click", () => navigate(-1));
dom.nextBtn.addEventListener("click", () => navigate(1));

// 10.4) Botón para reiniciar y cargar otro archivo.
dom.resetBtn.addEventListener("click", resetToUploader);

// 10.5) Botón para copiar el subtítulo actual al portapapeles.
dom.copyBtn.addEventListener("click", copyCurrentCue);

// 10.6) Clic sobre el propio texto del subtítulo: también copia.
//       Reutiliza la misma función que el botón.
dom.captionText.addEventListener("click", copyCurrentCue);

// 10.7) Modal "Saltar a": abrir, cancelar, aceptar y cerrar al hacer clic fuera.
dom.jumpBtn.addEventListener("click", openJumpModal);
dom.jumpCancel.addEventListener("click", closeJumpModal);
dom.jumpOverlay.addEventListener("click", closeJumpModal);
dom.jumpAccept.addEventListener("click", confirmJump);

// Con el modal abierto: Enter confirma, Escape cancela.
document.addEventListener("keydown", (event) => {
  if (dom.jumpModal.hidden) return;
  if (event.key === "Enter") {
    event.preventDefault();
    confirmJump();
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeJumpModal();
  }
});

// 10.8) Atajos de teclado (solo en estado activo y con el modal cerrado):
//       →            avanza un subtítulo.
//       ←            retrocede un subtítulo.
//       Espacio      avanza un subtítulo (como la flecha derecha).
//       Shift+Espacio retrocede un subtítulo (como la flecha izquierda).
//       C            copia el subtítulo actual.
document.addEventListener("keydown", (event) => {
  // Ignora si aún no hay subtítulos cargados o si el modal está abierto
  // (así no interferimos mientras el usuario escribe la marca de tiempo).
  if (dom.reader.hidden || !dom.jumpModal.hidden) return;

  // Navegación con flechas.
  if (event.key === "ArrowLeft") navigate(-1);
  if (event.key === "ArrowRight") navigate(1);

  // Barra espaciadora: Shift+Espacio retrocede; Espacio solo avanza.
  // event.code === "Space" detecta la tecla sin importar el navegador.
  if (event.code === "Space") {
    event.preventDefault(); // evita el desplazamiento de la página
    navigate(event.shiftKey ? -1 : 1);
  }

  // Tecla "C" para copiar (sin Ctrl/Cmd/Alt, para no pisar el copiar nativo).
  if (event.code === "KeyC" && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    copyCurrentCue();
  }
});
