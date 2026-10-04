/* =====================================================================
   Captions Reader — captions-core.js
   Lógica PURA (sin DOM): parseo de .srt, limpieza de texto, extracción
   del título a partir del nombre de archivo y utilidades de tiempo.

   Se carga como script clásico ANTES de app.js (sus funciones quedan en
   el ámbito global y app.js las usa directamente, así se sigue pudiendo
   abrir el .html con file://). Al final del archivo se exportan también
   como CommonJS para poder testearlas con "node --test".
   ===================================================================== */

"use strict";

/* ---------------------------------------------------------------------
   1) LIMPIEZA DEL TEXTO DEL SUBTÍTULO
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
   2) EXTRACCIÓN DEL TÍTULO DE LA OBRA (a partir del nombre del archivo)
   Sigue 4 fases: sanitización, radar de basura técnica, guillotina y pulido.
   --------------------------------------------------------------------- */

/* FASE 2 — RADAR: patrones que representan "basura técnica".
   No son palabras exactas, sino patrones (temporada, resolución, origen,
   códec, audio, año...). Se compilan UNA sola vez en una regex combinada.
   Los \b se añaden al unir, así cada patrón respeta límites de palabra.

   Se excluyen a propósito palabras ambiguas que también aparecen en
   títulos reales ("web", "max", "cam", "nf", "avc", "hulu"): en los
   nombres de release siempre van DETRÁS de un marcador fuerte (año,
   S01E01, 1080p...), así que la guillotina ya las elimina igualmente.
   Ej.: "Mad.Max.Fury.Road.2015..." no debe cortarse en "Max". */
const GARBAGE_PATTERN_SOURCES = [
  "S\\d{1,2}E\\d{1,2}",        // temporada + episodio: S01E01
  "\\d{1,2}x\\d{2}",           // formato alternativo: 1x02
  "S\\d{1,2}",                 // solo temporada: S01
  "\\d{3,4}p",                 // resolución: 1080p, 720p, 480p
  "4k", "uhd",                 // resolución / calidad
  // Orígenes de ripeo y plataformas (solo siglas inequívocas):
  "web[ -]?dl", "webrip", "bluray", "brrip", "bdrip", "hdtv",
  "dvdrip", "hdrip", "remux", "telesync", "hdcam",
  "amzn", "hmax", "dsnp", "atvp",
  // Códecs de vídeo:
  "x26[45]", "h\\s?26[45]", "hevc", "xvid", "divx",
  // Audio:
  "ddp?\\d?", "dts", "ac3", "aac", "atmos", "truehd", "flac",
  // Año (1900–2099):
  "(?:19|20)\\d{2}",
];

// Regex combinada, global e insensible a mayúsculas (se recorre con matchAll).
const GARBAGE_REGEX = new RegExp(
  "\\b(?:" + GARBAGE_PATTERN_SOURCES.join("|") + ")\\b",
  "gi"
);

// Un año suelto: si el nombre EMPIEZA por él, es parte del título ("1917", "2001...").
const YEAR_ONLY_REGEX = /^(?:19|20)\d{2}$/;

/**
 * FASE 3 (parte) — Devuelve el índice donde empieza la primera "basura técnica",
 * o -1 si no hay ninguna. Un año al principio del texto no cuenta como basura.
 * @param {string} text - Nombre ya sanitizado (con espacios).
 * @returns {number}
 */
function findFirstGarbageIndex(text) {
  for (const match of text.matchAll(GARBAGE_REGEX)) {
    if (match.index === 0 && YEAR_ONLY_REGEX.test(match[0])) continue;
    return match.index;
  }
  return -1;
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
   3) UTILIDADES DE TIEMPO
   Internamente los tiempos se guardan en milisegundos (números): así
   comparar, ordenar y buscar es trivial y no hay que re-parsear cadenas.
   --------------------------------------------------------------------- */

/**
 * Convierte las partes de una marca de tiempo a milisegundos totales.
 * Los milisegundos se rellenan a 3 cifras por si vinieran con menos (",5" -> 500).
 * @returns {number}
 */
function partsToMs(hours, minutes, seconds, millis) {
  return ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 +
    Number(String(millis).padEnd(3, "0"));
}

/**
 * Da formato SRT a una cantidad de milisegundos: 3723004 -> "01:02:03,004".
 * @param {number} ms
 * @returns {string}
 */
function formatMs(ms) {
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor(ms / 60000) % 60;
  const seconds = Math.floor(ms / 1000) % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(ms % 1000, 3)}`;
}

/**
 * Da formato a la línea de tiempos para mostrarla en la tarjeta.
 * Usa "→" en lugar de "-->" para una estética más limpia.
 */
function formatTimecode(cue) {
  return `${formatMs(cue.startMs)} → ${formatMs(cue.endMs)}`;
}

/**
 * Devuelve el índice del subtítulo cuyo tiempo de inicio está MÁS CERCA
 * de targetMs. Búsqueda binaria O(log n): requiere cues ordenados por inicio
 * (parseSRT ya los devuelve así). En caso de empate gana el anterior.
 * @param {Array<{startMs:number}>} cues
 * @param {number} targetMs
 * @returns {number}
 */
function findCueIndexAt(cues, targetMs) {
  // 1) Último cue que empieza en o antes de targetMs (0 si ninguno).
  let lo = 0;
  let hi = cues.length - 1;
  let before = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].startMs <= targetMs) {
      before = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  // 2) Se compara con el siguiente y se queda el más cercano.
  const next = cues[before + 1];
  if (next && next.startMs - targetMs < targetMs - cues[before].startMs) {
    return before + 1;
  }
  return before;
}

/* ---------------------------------------------------------------------
   4) DECODIFICACIÓN DEL ARCHIVO
   Muchos .srt en español están guardados en Windows-1252 / Latin-1, no en
   UTF-8. Leerlos siempre como UTF-8 convierte "ñ", "á"... en "�".
   Estrategia: respetar el BOM si lo hay; si no, intentar UTF-8 estricto
   y, si falla, recurrir a Windows-1252 (superconjunto de Latin-1).
   --------------------------------------------------------------------- */

/**
 * Convierte los bytes de un archivo de subtítulos en texto.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {string}
 */
function decodeSubtitleBuffer(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  // BOM de UTF-16 (algunos editores de Windows guardan así los .srt).
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);

  try {
    // "fatal: true" lanza un error ante bytes que no sean UTF-8 válido.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (_) {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/* ---------------------------------------------------------------------
   5) PARSER DE .SRT
   Un archivo .srt se compone de bloques separados por una línea en blanco:

       1
       00:00:01,000 --> 00:00:04,000
       Texto del subtítulo
       (puede ocupar varias líneas)

   Devuelve un array de "cues" ordenado por tiempo de inicio. Es tolerante con:
     - Saltos de línea Windows (\r\n), Mac antiguo (\r) y Unix (\n).
     - BOM al inicio del archivo.
     - Bloques sin número de índice.
     - Líneas "en blanco" que en realidad contienen espacios o tabuladores.
     - Milisegundos con coma (estándar) o con punto (00:00:01.000).
     - Horas de una sola cifra (0:00:01,000).
   --------------------------------------------------------------------- */

// Línea de tiempos: "hh:mm:ss,mmm --> hh:mm:ss,mmm" (con las tolerancias de arriba).
const TIME_LINE_REGEX =
  /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

/**
 * Convierte el texto completo de un .srt en una lista de subtítulos.
 * @param {string} raw - Contenido bruto del archivo.
 * @returns {Array<{startMs: number, endMs: number, text: string}>}
 */
function parseSRT(raw) {
  // Elimina el BOM (carácter invisible al inicio de algunos archivos)
  // y normaliza todos los saltos de línea a "\n".
  const normalized = raw
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .trim();

  // Separa en bloques: una línea vacía (o solo con espacios) actúa como divisor.
  const blocks = normalized.split(/\n[ \t]*\n/);

  const cues = [];

  for (const block of blocks) {
    const lines = block.split("\n");

    // Busca en qué línea está la marca de tiempo (suele ser la 1ª o la 2ª,
    // según si el bloque incluye número de índice o no).
    const timeLineIndex = lines.findIndex((line) => TIME_LINE_REGEX.test(line));
    if (timeLineIndex === -1) continue; // bloque sin tiempos -> se ignora

    const m = lines[timeLineIndex].match(TIME_LINE_REGEX);

    // El texto es todo lo que viene después de la línea de tiempos.
    // Se limpia: sin etiquetas HTML, sin corchetes, sin entidades.
    const text = cleanText(lines.slice(timeLineIndex + 1).join("\n"));

    // Solo guardamos cues que conserven texto real tras limpiar.
    // Así, un subtítulo como "[intriguing music playing]" se omite por completo.
    if (!text) continue;

    cues.push({
      startMs: partsToMs(m[1], m[2], m[3], m[4]),
      endMs: partsToMs(m[5], m[6], m[7], m[8]),
      text,
    });
  }

  // Orden estable por inicio: garantiza la búsqueda binaria de findCueIndexAt.
  return cues.sort((a, b) => a.startMs - b.startMs);
}

/* ---------------------------------------------------------------------
   EXPORTACIÓN PARA NODE (tests). En el navegador "module" no existe y
   las funciones simplemente quedan disponibles para app.js.
   --------------------------------------------------------------------- */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    cleanText,
    decodeEntities,
    decodeSubtitleBuffer,
    extractTitleFromFilename,
    findCueIndexAt,
    formatMs,
    formatTimecode,
    parseSRT,
  };
}
