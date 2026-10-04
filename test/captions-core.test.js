/* Tests de la lógica pura (captions-core.js). Ejecutar con: npm test
   (o directamente: node --test). Sin dependencias externas. */

"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  cleanText,
  decodeSubtitleBuffer,
  extractTitleFromFilename,
  findCueIndexAt,
  formatMs,
  formatTimecode,
  parseSRT,
} = require("../captions-core.js");

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name));

describe("parseSRT", () => {
  test("parsea un bloque estándar a milisegundos", () => {
    const cues = parseSRT("1\n00:01:02,345 --> 00:01:04,000\nHola\nmundo");
    assert.deepEqual(cues, [{ startMs: 62345, endMs: 64000, text: "Hola\nmundo" }]);
  });

  test("una línea 'en blanco' con espacios separa bloques (no los fusiona)", () => {
    const cues = parseSRT(
      "1\n00:00:01,000 --> 00:00:02,000\nUno\n \n2\n00:00:03,000 --> 00:00:04,000\nDos\n\t\n3\n00:00:05,000 --> 00:00:06,000\nTres"
    );
    assert.deepEqual(cues.map((c) => c.text), ["Uno", "Dos", "Tres"]);
  });

  test("acepta milisegundos con punto y horas de una cifra", () => {
    const cues = parseSRT("1\n0:00:05.5 --> 0:00:07.000\nTexto");
    assert.equal(cues.length, 1);
    assert.equal(cues[0].startMs, 5500);
    assert.equal(cues[0].endMs, 7000);
  });

  test("tolera BOM, \\r\\n, \\r y bloques sin número", () => {
    const cues = parseSRT("﻿00:00:01,000 --> 00:00:02,000\r\nA\r\n\r\n00:00:03,000 --> 00:00:04,000\rB");
    assert.deepEqual(cues.map((c) => c.text), ["A", "B"]);
  });

  test("descarta cues que se quedan vacíos tras limpiar", () => {
    const cues = parseSRT("1\n00:00:01,000 --> 00:00:02,000\n[música]\n\n2\n00:00:03,000 --> 00:00:04,000\n<i>Hola</i>");
    assert.deepEqual(cues.map((c) => c.text), ["Hola"]);
  });

  test("ordena por tiempo de inicio (requisito de la búsqueda binaria)", () => {
    const cues = parseSRT("1\n00:00:09,000 --> 00:00:10,000\nTarde\n\n2\n00:00:01,000 --> 00:00:02,000\nPronto");
    assert.deepEqual(cues.map((c) => c.text), ["Pronto", "Tarde"]);
  });

  test("fixture formatos-variados.srt", () => {
    const cues = parseSRT(decodeSubtitleBuffer(fixture("formatos-variados.srt")));
    assert.deepEqual(cues.map((c) => c.text), [
      "Primera línea",
      "Milisegundos con punto\ny hora de una cifra",
      "Un minuto & algo",
      "Dos minutos",
    ]);
  });
});

describe("cleanText", () => {
  test("quita etiquetas, corchetes, llaves y decodifica entidades", () => {
    assert.equal(cleanText("{\\an8}<i>Tom &amp; Jerry</i> [risas]"), "Tom & Jerry");
  });

  test("elimina líneas que quedan vacías y normaliza espacios", () => {
    assert.equal(cleanText("[música]\n  Hola    mundo  "), "Hola mundo");
  });
});

describe("decodeSubtitleBuffer", () => {
  test("UTF-8 se lee tal cual", () => {
    assert.equal(decodeSubtitleBuffer(Buffer.from("Canción ñ", "utf8")), "Canción ñ");
  });

  test("Windows-1252 / Latin-1 no produce caracteres '�'", () => {
    const text = decodeSubtitleBuffer(fixture("latin1-windows1252.srt"));
    assert.match(text, /¿Qué tal, señor Núñez\?/);
    assert.match(text, /¡Él está aquí! Pingüino\./);
    assert.doesNotMatch(text, /�/);
  });

  test("UTF-16 LE con BOM", () => {
    const cues = parseSRT(decodeSubtitleBuffer(fixture("utf16le-bom.srt")));
    assert.deepEqual(cues.map((c) => c.text), ["¿Qué tal, señor Núñez?", "¡Él está aquí! Pingüino."]);
  });

  test("acepta un ArrayBuffer (lo que devuelve File.arrayBuffer())", () => {
    const { buffer, byteOffset, byteLength } = Buffer.from("Hola", "utf8");
    assert.equal(decodeSubtitleBuffer(buffer.slice(byteOffset, byteOffset + byteLength)), "Hola");
  });
});

describe("formatMs / formatTimecode", () => {
  test("formatea a HH:MM:SS,mmm", () => {
    assert.equal(formatMs(0), "00:00:00,000");
    assert.equal(formatMs(3723004), "01:02:03,004");
  });

  test("formatTimecode usa la flecha →", () => {
    assert.equal(formatTimecode({ startMs: 1000, endMs: 2500 }), "00:00:01,000 → 00:00:02,500");
  });
});

describe("findCueIndexAt", () => {
  const cues = [1000, 10000, 60000, 120000].map((startMs) => ({ startMs }));

  test("devuelve el cue cuyo inicio está más cerca", () => {
    assert.equal(findCueIndexAt(cues, 0), 0);
    assert.equal(findCueIndexAt(cues, 4000), 0);
    assert.equal(findCueIndexAt(cues, 7000), 1);
    assert.equal(findCueIndexAt(cues, 60000), 2);
    assert.equal(findCueIndexAt(cues, 999999), 3);
  });

  test("en empate gana el anterior", () => {
    assert.equal(findCueIndexAt(cues, 5500), 0);
  });

  test("coincide con la búsqueda lineal original en muchos puntos", () => {
    const linear = (t) => {
      let best = 0;
      cues.forEach((c, i) => {
        if (Math.abs(c.startMs - t) < Math.abs(cues[best].startMs - t)) best = i;
      });
      return best;
    };
    for (let t = 0; t <= 130000; t += 250) assert.equal(findCueIndexAt(cues, t), linear(t), `t=${t}`);
  });
});

describe("extractTitleFromFilename", () => {
  const cases = {
    // Antes devolvían resultados erróneos (palabras ambiguas / año al principio):
    "Mad.Max.Fury.Road.2015.1080p.BluRay.x264.srt": "Mad Max Fury Road",
    "Max.Payne.2008.srt": "Max Payne",
    "Cam.2018.srt": "Cam",
    "1917.2019.1080p.WEBRip.srt": "1917",
    "2001.A.Space.Odyssey.1968.srt": "2001 A Space Odyssey",
    "The.Web.Collection.srt": "The Web Collection | Temporada: No identificada, episodio no identificado",
    // Casos que ya funcionaban y deben seguir igual:
    "Michael.2026.1080p.WEB-DL.srt": "Michael",
    "Avatar.The.Way.of.Water.2022.srt": "Avatar The Way of Water",
    "Breaking.Bad.S05E14.Ozymandias.1080p.AMZN.WEB-DL.DDP5.1.H.264.srt":
      "Breaking Bad | Temporada 5, episodio 14: 'Ozymandias'",
    "Spider-Noir.S01E01.Pilot.1080p.srt": "Spider-Noir | Temporada 1, episodio 1: 'Pilot'",
    "Stranger.Things.4x02.Vecna.720p.NF.WEB.srt": "Stranger Things | Temporada 4, episodio 2: 'Vecna'",
    "The.Office.US.S02E03.720p.srt": "The Office US | Temporada 2, episodio 3",
    "S01E01.Pilot.srt": "Información no disponible",
    "": "Información no disponible",
  };

  for (const [filename, expected] of Object.entries(cases)) {
    test(filename || "(vacío)", () => {
      assert.equal(extractTitleFromFilename(filename), expected);
    });
  }
});
