/* =====================================================================
   Captions Reader — app.js
   Vanilla JavaScript (ES6+). Sin frameworks ni librerías.

   Responsabilidades del módulo:
     1) Gestionar los dos estados de la interfaz (espera / activo).
     2) Navegar subtítulo a subtítulo (flechas y teclado).
     3) Conectar la interfaz con la lógica pura de captions-core.js
        (parser .srt, limpieza de texto, título, utilidades de tiempo),
        que se carga antes que este archivo.
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

  // Modal "Saltar a" (<dialog> nativo)
  jumpBtn:     document.getElementById("jumpBtn"),
  jumpModal:   document.getElementById("jumpModal"),
  wheelHours:   document.getElementById("wheelHours"),
  wheelMinutes: document.getElementById("wheelMinutes"),
  wheelSeconds: document.getElementById("wheelSeconds"),
  timePicker:   document.getElementById("timePicker"),
  wheelRing:    document.getElementById("wheelRing"),
};

// Texto que muestra el tagline cuando no hay archivo cargado.
const DEFAULT_TAGLINE = "Lector de subtítulos · formato .srt";

// Tamaño máximo aceptado. Un .srt típico pesa entre 50 y 200 KB.
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/* ---------------------------------------------------------------------
   2) ESTADO DE LA APLICACIÓN
   "cues" guarda la lista de subtítulos; "index" el que se muestra ahora.
   --------------------------------------------------------------------- */
const state = {
  cues: [],   // Array de objetos { startMs, endMs, text }
  index: 0,   // Posición actual dentro de cues
};

/* ---------------------------------------------------------------------
   3) RENDERIZADO DE LA INTERFAZ
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
   4) NAVEGACIÓN
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
     · Teclado: ↑/↓ (±1), RePág/AvPág (±5), Inicio/Fin (extremos).
       La tecla mueve la selección en su dirección: ↑ elige el número de
       arriba (menor) y ↓ el de abajo (mayor), igual que la rueda del ratón.
   Cada instancia es independiente del resto y expone su valor a los
   lectores de pantalla (aria-valuenow / aria-valuetext).
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
    this.el.setAttribute("aria-valuemin", "0");
    this.el.setAttribute("aria-valuemax", String(this.length - 1));
    this._updateAria(0);
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

  /* Devuelve el valor seleccionado (el número anclado en el centro).
     Si la rueda aún se está anclando, devuelve el número hacia el que va. */
  getValue() {
    if (this.mode === "snap") return this.target;
    return this._clamp(Math.round(this.position));
  }

  /* Coloca la rueda en un valor concreto (sin animación). */
  setValue(value) {
    this._stop();
    this.position = this._clamp(value);
    this.velocity = 0;
    this.mode = "idle";
    this._updateAria(this.position);
    this.render();
  }

  /* Lleva la rueda a un valor concreto con la animación de resorte. */
  snapTo(value) {
    this._stop();
    this.target = this._clamp(value);
    this.velocity = 0;
    this.mode = "snap";
    this._updateAria(this.target);
    this._start();
  }

  /* Publica el valor para tecnologías de asistencia ("05 minutos"). */
  _updateAria(value) {
    const unit = this.el.dataset.unit || "";
    this.el.setAttribute("aria-valuenow", String(value));
    this.el.setAttribute("aria-valuetext", `${String(value).padStart(2, "0")} ${unit}`.trim());
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
          this._updateAria(this.target);
        } else if (Math.abs(this.velocity) < this.V_MIN) {
          // Velocidad muy baja: se activa el imán hacia el número más cercano.
          this.mode = "snap";
          this.target = this._clamp(Math.round(this.position));
          this._updateAria(this.target);
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
      this.snapTo(Math.round(this.position) + Math.sign(e.deltaY));
    }, { passive: false });

    // Teclado (la rueda tiene role="slider" y tabindex="0").
    // Los números mayores están DEBAJO, así que ↑/RePág eligen los de arriba
    // (restan) y ↓/AvPág los de abajo (suman): lo que se ve sigue a la tecla.
    this.el.addEventListener("keydown", (e) => {
      const steps = { ArrowUp: -1, ArrowDown: 1, PageUp: -5, PageDown: 5 };
      let next;
      if (e.key in steps) next = this.getValue() + steps[e.key];
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = this.length - 1;
      else return;
      e.preventDefault();
      this.snapTo(next);
    });
  }
}

/* ---------------------------------------------------------------------
   SALTAR A UNA MARCA DE TIEMPO (modal)
   --------------------------------------------------------------------- */

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

/* ---------------------------------------------------------------------
   RUEDA ACTIVA: anillo de foco propio y ← / → entre ruedas
   Un único anillo (.picker__ring) marca la rueda activa y se desliza de
   una a otra. Se muestra cuando el usuario llega con el teclado (Tab,
   ← / →) o empieza a usar una rueda con el ratón o el dedo (arrastre,
   clic, rueda del ratón), y se oculta cuando el foco sale de las ruedas.
   --------------------------------------------------------------------- */
const WHEELS = [dom.wheelHours, dom.wheelMinutes, dom.wheelSeconds];
const WHEEL_KEYS = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"];

/** Coloca el anillo sobre "wheel" y la marca como activa. */
function showWheelRing(wheel) {
  const ring = dom.wheelRing;
  const wasHidden = !dom.timePicker.classList.contains("has-ring");

  // Si estaba oculto, aparece directamente en su sitio (sin deslizarse
  // desde la posición anterior): se desactiva la transición un instante.
  if (wasHidden) ring.style.transition = "none";
  ring.style.setProperty("--ring-x", `${wheel.offsetLeft}px`);
  ring.style.setProperty("--ring-w", `${wheel.offsetWidth}px`);
  if (wasHidden) {
    void ring.offsetWidth; // aplica la posición antes de reactivar la transición
    ring.style.transition = "";
  }

  dom.timePicker.classList.add("has-ring");
  WHEELS.forEach((w) => w.classList.toggle("is-engaged", w === wheel));
}

/** Oculta el anillo y desmarca todas las ruedas. */
function hideWheelRing() {
  dom.timePicker.classList.remove("has-ring");
  WHEELS.forEach((w) => w.classList.remove("is-engaged"));
}

WHEELS.forEach((wheel) => {
  // Llegada con el teclado (Tab / Shift+Tab, o el foco inicial al abrir el
  // diálogo con Enter). Con un clic, :focus-visible no se cumple y el anillo
  // lo muestra el "pointerdown" de abajo.
  wheel.addEventListener("focus", () => {
    if (wheel.matches(":focus-visible")) showWheelRing(wheel);
  });

  // Empieza a moverla con el ratón o el dedo.
  wheel.addEventListener("pointerdown", () => showWheelRing(wheel));

  // Rueda del ratón sobre una rueda que no tenía el foco: se le da, para
  // que las teclas actúen después sobre la misma rueda que se ve marcada.
  wheel.addEventListener("wheel", () => {
    if (document.activeElement !== wheel) wheel.focus({ preventScroll: true });
    showWheelRing(wheel);
  }, { passive: true });

  // El foco sale de las ruedas (a un botón o porque se cierra el diálogo).
  wheel.addEventListener("blur", (event) => {
    if (!WHEELS.includes(event.relatedTarget)) hideWheelRing();
  });
});

// Teclado dentro del selector (solo existe con el diálogo abierto):
//   ← / →  pasan a la rueda anterior / siguiente (se detienen en los extremos).
//   ↑ ↓ RePág AvPág Inicio Fin  (los procesa WheelPicker) también muestran el
//   anillo, por si la rueda tenía el foco por un clic sin arrastre.
dom.timePicker.addEventListener("keydown", (event) => {
  const index = WHEELS.indexOf(event.target);
  if (index === -1) return;

  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    const next = WHEELS[index + (event.key === "ArrowRight" ? 1 : -1)];
    if (!next) return;
    next.focus();
    showWheelRing(next);
  } else if (WHEEL_KEYS.includes(event.key)) {
    showWheelRing(event.target);
  }
});

// Si cambia el tamaño de la ventana con el anillo visible, se recoloca.
window.addEventListener("resize", () => {
  const engaged = WHEELS.find((w) => w.classList.contains("is-engaged"));
  if (engaged) showWheelRing(engaged);
});

/**
 * Abre el modal. Las tres ruedas siempre parten desde 0.
 * showModal() de <dialog> se encarga de: llevar el foco dentro (a la rueda
 * con "autofocus"), atraparlo mientras está abierto, volverlo inerte el
 * resto de la página, cerrar con Escape y devolver el foco al cerrar.
 */
function openJumpModal(event) {
  ensureWheels();

  // Reinicio limpio: cada vez que se abre, todas las ruedas vuelven a 0.
  hoursWheel.setValue(0);
  minutesWheel.setValue(0);
  secondsWheel.setValue(0);

  // Escape cierra SIN tocar returnValue: hay que vaciarlo para que no
  // conserve el "ok" de un salto anterior.
  dom.jumpModal.returnValue = "";
  dom.jumpModal.showModal();

  // Anillo inicial según CÓMO se abrió: con teclado (Enter/Espacio sobre el
  // botón, event.detail === 0) se marca la rueda de horas; con un clic, no
  // hay anillo hasta que el usuario toque una rueda.
  if (event && event.detail === 0) showWheelRing(dom.wheelHours);
  else hideWheelRing();
}

/** Cierra el modal sin realizar ninguna acción. */
function closeJumpModal() {
  if (dom.jumpModal.open) dom.jumpModal.close("cancel");
}

/**
 * Lee la hora elegida en las ruedas y salta al subtítulo cuyo tiempo de
 * inicio esté MÁS CERCA del seleccionado (búsqueda binaria en captions-core).
 */
function confirmJump() {
  const targetMs =
    ((hoursWheel.getValue() * 60 + minutesWheel.getValue()) * 60 + secondsWheel.getValue()) * 1000;

  state.index = findCueIndexAt(state.cues, targetMs);
  renderCurrentCue();
}

/* ---------------------------------------------------------------------
   5) TRANSICIONES ENTRE ESTADOS DE LA UI
   --------------------------------------------------------------------- */

/** Pasa al estado activo: oculta la carga y muestra el controlador. */
function showReader() {
  dom.uploader.hidden = true;
  dom.reader.hidden = false;
}

/** Vuelve al estado de espera: limpia datos y muestra la zona de carga. */
function resetToUploader() {
  loadToken++; // invalida cualquier lectura de archivo que siga en curso
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
   6) MANEJO DE ERRORES (mensajes para el usuario)
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
   7) CARGA Y PROCESADO DEL ARCHIVO
   --------------------------------------------------------------------- */

// Identifica la lectura en curso. Si mientras se lee un archivo llega otro
// (o se pulsa "Cargar otro archivo"), el resultado antiguo se descarta.
let loadToken = 0;

/**
 * Recibe un objeto File, valida extensión y tamaño, lo lee, detecta su
 * codificación y lo parsea. Si todo va bien, cambia al estado activo y
 * muestra el primer subtítulo.
 * @param {File} file
 */
async function handleFile(file) {
  clearError();

  // Validación básica de extensión.
  if (!file || !/\.srt$/i.test(file.name)) {
    showError("Por favor, selecciona un archivo con extensión .srt");
    return;
  }

  if (file.size > MAX_FILE_BYTES) {
    showError("El archivo es demasiado grande para ser un .srt (máximo 5 MB).");
    return;
  }

  const token = ++loadToken;

  try {
    // Se leen los BYTES (no texto) para poder detectar la codificación:
    // UTF-8, UTF-16 o Windows-1252 (habitual en .srt en español).
    const buffer = await file.arrayBuffer();
    if (token !== loadToken) return; // llegó otro archivo o se reinició

    const cues = parseSRT(decodeSubtitleBuffer(buffer));

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
  } catch (error) {
    // Si la lectura falla (archivo corrupto, permisos, archivo movido, etc.).
    console.error("Captions Reader: error al leer el archivo", error);
    if (token === loadToken) {
      showError("Ocurrió un error al leer el archivo. Inténtalo de nuevo.");
    }
  }
}

/* ---------------------------------------------------------------------
   8) EVENTOS
   --------------------------------------------------------------------- */

// 8.1) Selección de archivo mediante el input.
dom.fileInput.addEventListener("change", (event) => {
  const file = event.target.files[0];
  handleFile(file);
});

// 8.2) Soporte de "arrastrar y soltar" sobre la zona de carga.
// Red de seguridad: si el archivo se suelta FUERA de la zona de carga, el
// navegador lo abriría y la página se perdería. Se cancela a nivel de ventana.
["dragover", "drop"].forEach((type) => {
  window.addEventListener(type, (event) => event.preventDefault());
});

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

// 8.3) Botones de navegación.
dom.prevBtn.addEventListener("click", () => navigate(-1));
dom.nextBtn.addEventListener("click", () => navigate(1));

// 8.4) Botón para reiniciar y cargar otro archivo.
dom.resetBtn.addEventListener("click", resetToUploader);

// 8.5) Botón para copiar el subtítulo actual al portapapeles.
dom.copyBtn.addEventListener("click", copyCurrentCue);

// 8.6) Clic sobre el propio texto del subtítulo: también copia.
//       Reutiliza la misma función que el botón.
dom.captionText.addEventListener("click", copyCurrentCue);

// 8.7) Modal "Saltar a".
//   · "Cancelar" y "Aceptar" son botones de un <form method="dialog">: cierran
//     el diálogo con returnValue "cancel" u "ok". Escape lo cierra de forma nativa.
//   · Solo si se cerró con "ok" se realiza el salto.
dom.jumpBtn.addEventListener("click", openJumpModal);

dom.jumpModal.addEventListener("close", () => {
  if (dom.jumpModal.returnValue === "ok") confirmJump();
});

// Clic fuera del cuadro (sobre el ::backdrop): el evento llega con el propio
// <dialog> como destino, porque el formulario ocupa todo su interior.
dom.jumpModal.addEventListener("click", (event) => {
  if (event.target === dom.jumpModal) closeJumpModal();
});

// Enter con el foco en una rueda confirma. Sobre un botón no se intercepta:
// así Enter en "Cancelar" cancela y Enter en "Aceptar" acepta.
dom.jumpModal.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.target.closest("button")) return;
  event.preventDefault();
  dom.jumpModal.close("ok");
});

// 8.8) Atajos de teclado (solo en estado activo y con el modal cerrado):
//       →            avanza un subtítulo.
//       ←            retrocede un subtítulo.
//       Espacio      avanza un subtítulo (como la flecha derecha).
//       Shift+Espacio retrocede un subtítulo (como la flecha izquierda).
//       C            copia el subtítulo actual.
//       (Si se llegó a un botón navegando con Tab, Espacio activa ESE botón,
//        como es estándar: p. ej. Espacio sobre "‹" retrocede. Si el foco vino
//        de un clic de ratón, Espacio conserva el atajo de avanzar.)

// Origen del foco: ¿se llegó al elemento con Tab o con el ratón?
// (No sirve :focus-visible: Chrome lo activa al pulsar cualquier tecla,
//  incluida la propia barra espaciadora que estamos evaluando.)
let tabNavigation = false;
let focusFromTab = false;
document.addEventListener("keydown", (event) => {
  if (event.key === "Tab") tabNavigation = true;
}, true);
document.addEventListener("pointerdown", () => { tabNavigation = false; }, true);
document.addEventListener("focusin", () => { focusFromTab = tabNavigation; });

document.addEventListener("keydown", (event) => {
  // Ignora si aún no hay subtítulos cargados o si el modal está abierto
  // (así no interferimos mientras el usuario gira las ruedas).
  if (dom.reader.hidden || dom.jumpModal.open) return;

  // Navegación con flechas.
  if (event.key === "ArrowLeft") navigate(-1);
  if (event.key === "ArrowRight") navigate(1);

  // Barra espaciadora: Shift+Espacio retrocede; Espacio solo avanza.
  // event.code === "Space" detecta la tecla sin importar el navegador.
  // Se omite si se llegó a un control con Tab: el navegador lo activará.
  const tabFocusedControl =
    focusFromTab && event.target.closest("button, input, select, textarea");
  if (event.code === "Space" && !tabFocusedControl) {
    event.preventDefault(); // evita el desplazamiento de la página
    navigate(event.shiftKey ? -1 : 1);
  }

  // Tecla "C" para copiar (sin Ctrl/Cmd/Alt, para no pisar el copiar nativo).
  if (event.code === "KeyC" && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    copyCurrentCue();
  }
});
