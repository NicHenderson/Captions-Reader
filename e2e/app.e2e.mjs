/* Tests de extremo a extremo: abren index.html con file:// en Chromium real
   (igual que un usuario que hace doble clic en el archivo) y verifican la
   interfaz: carga y codificación, teclado, diálogo "Saltar a", foco,
   arrastrar y soltar, copiar y cancelación de lecturas en curso.

   Requisitos (una sola vez):
     npm install
     npx playwright install chromium
   Ejecutar:
     npm run test:e2e
*/

import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import http from "node:http";
import fs from "node:fs";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_URL = pathToFileURL(path.join(root, "index.html")).href;
const fixture = (name) => path.join(root, "test", "fixtures", name);

let browser;
let context;
let page;
let pageErrors;

before(async () => {
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
});

beforeEach(async () => {
  context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  // Cuenta aperturas del diálogo y eventos "close" ya procesados por la app
  // (su oyente se registró antes que este), para esperar sin tiempos fijos.
  await context.addInitScript(() => {
    window.__dialogOpens = 0;
    window.__dialogCloses = 0;
    const showModal = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () {
      window.__dialogOpens++;
      return showModal.call(this);
    };
    document.addEventListener("DOMContentLoaded", () => {
      document.getElementById("jumpModal")?.addEventListener("close", () => { window.__dialogCloses++; });
    });
  });
  page = await context.newPage();
  pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(APP_URL);
});

afterEach(async () => {
  await context.close();
  assert.deepEqual(pageErrors, [], "la página no debe lanzar excepciones");
});

/* ---------- Utilidades ---------- */
const counter = () => page.textContent("#counter");
const caption = () => page.textContent("#captionText");
const activeId = () => page.evaluate(() => document.activeElement.id || document.activeElement.tagName);
const modalOpen = () => page.evaluate(() => document.getElementById("jumpModal").open);
const wheelValue = (id) => page.getAttribute(`#${id}`, "aria-valuenow");

async function load(name) {
  await page.setInputFiles("#fileInput", fixture(name));
  await page.waitForSelector("#reader:not([hidden])");
}

// El evento "close" de <dialog> se despacha en una tarea posterior al cierre:
// se espera a que la app haya procesado el cierre de cada apertura.
const settle = () => page.waitForFunction(() =>
  !document.getElementById("jumpModal").open && window.__dialogCloses === window.__dialogOpens);

// Reloj simulado y PAUSADO: el tiempo solo avanza con page.clock.runFor().
// (Tras install() el reloj sigue corriendo en tiempo real hasta pausarlo.)
async function gotoWithPausedClock() {
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.goto(APP_URL);
  await page.clock.pauseAt(new Date("2026-01-01T00:00:30Z"));
}

/* ---------- Carga y codificación ---------- */

test("Windows-1252 (Latin-1) se muestra sin caracteres '�'", async () => {
  await load("latin1-windows1252.srt");
  assert.equal(await caption(), "¿Qué tal, señor Núñez?");
});

test("UTF-16 con BOM se decodifica", async () => {
  await load("utf16le-bom.srt");
  assert.equal(await caption(), "¿Qué tal, señor Núñez?");
});

test("formatos variados: 4 cues y marca de tiempo normalizada", async () => {
  await load("formatos-variados.srt");
  assert.equal(await counter(), "1 / 4");
  await page.click("#nextBtn");
  assert.equal(await page.textContent("#timecode"), "00:00:05,500 → 00:00:07,000");
});

test("rechaza extensiones no .srt y archivos de más de 5 MB", async () => {
  await page.setInputFiles("#fileInput", { name: "x.txt", mimeType: "text/plain", buffer: Buffer.from("hola") });
  assert.match(await page.textContent("#error"), /\.srt/);
  await page.setInputFiles("#fileInput", {
    name: "enorme.srt", mimeType: "text/plain", buffer: Buffer.alloc(6 * 1024 * 1024, "a"),
  });
  assert.match(await page.textContent("#error"), /demasiado grande/);
});

test("'Cargar otro archivo' durante una lectura la cancela; con dos archivos gana el último", async () => {
  // Lectura lenta artificial para poder interrumpirla.
  await page.evaluate(() => {
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      return new Promise((resolve) => setTimeout(() => resolve(original.call(this)), 400));
    };
  });
  await page.setInputFiles("#fileInput", fixture("formatos-variados.srt"));
  await page.evaluate(() => resetToUploader());
  await page.waitForTimeout(700);
  assert.ok(await page.isHidden("#reader"), "no debe aparecer el lector tras reiniciar");

  await page.setInputFiles("#fileInput", fixture("formatos-variados.srt"));
  await page.setInputFiles("#fileInput", fixture("latin1-windows1252.srt"));
  await page.waitForSelector("#reader:not([hidden])");
  await page.waitForTimeout(700);
  assert.equal(await caption(), "¿Qué tal, señor Núñez?");
});

test("soltar un archivo fuera de la zona de carga no abandona la página", async () => {
  const prevented = await page.evaluate(() => {
    const event = new DragEvent("drop", { cancelable: true, bubbles: true });
    document.body.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.ok(prevented);
});

/* ---------- Navegación con teclado ---------- */

test("atajos: Espacio avanza, Shift+Espacio retrocede, flechas navegan, C copia", async () => {
  await load("formatos-variados.srt");
  await page.keyboard.press("Space");
  assert.equal(await counter(), "2 / 4");
  await page.keyboard.press("Shift+Space");
  assert.equal(await counter(), "1 / 4");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  assert.equal(await counter(), "3 / 4");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await counter(), "2 / 4");
  await page.keyboard.press("c");
  await page.waitForTimeout(200);
  assert.equal(await page.textContent("#copyLabel"), "¡Copiado!");
});

test("teclado: con Tab sobre '‹', Espacio activa ese botón (retrocede)", async () => {
  await load("formatos-variados.srt");
  await page.click("#nextBtn");
  await page.click("#nextBtn"); // 3/4
  await page.focus("#playBtn"); // primer control de la tarjeta
  await page.keyboard.press("Shift+Tab");
  assert.equal(await activeId(), "prevBtn");
  await page.keyboard.press("Space");
  assert.equal(await counter(), "2 / 4");
});

test("ratón: tras hacer clic en '‹', Espacio sigue siendo el atajo de avanzar", async () => {
  await load("formatos-variados.srt");
  await page.click("#nextBtn");
  await page.click("#nextBtn");
  await page.click("#prevBtn"); // 2/4, foco (por ratón) en ‹
  await page.keyboard.press("Space");
  assert.equal(await counter(), "3 / 4");
});

test("ratón: tras saltar con 'Aceptar', Espacio avanza y no reabre el diálogo", async () => {
  await load("formatos-variados.srt");
  await page.click("#jumpBtn");
  await page.click("button[value=ok]");
  await settle();
  await page.keyboard.press("Space");
  assert.equal(await counter(), "2 / 4");
  assert.equal(await modalOpen(), false);
});

/* ---------- Diálogo "Saltar a" ---------- */

test("al abrir, el foco entra en la rueda de horas y Tab no se escapa", async () => {
  await load("formatos-variados.srt");
  await page.focus("#jumpBtn");
  await page.keyboard.press("Enter");
  assert.ok(await modalOpen());
  assert.equal(await activeId(), "wheelHours");
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(() =>
      document.getElementById("jumpModal").contains(document.activeElement) ||
      document.activeElement === document.body);
    assert.ok(inside, `Tab nº ${i + 1} sacó el foco del diálogo`);
  }
});

test("ruedas con teclado: la selección sigue a la flecha (↓ número de abajo, ↑ el de arriba)", async () => {
  await load("formatos-variados.srt");
  await page.click("#jumpBtn");
  await page.focus("#wheelMinutes");
  await page.keyboard.press("ArrowUp");
  assert.equal(await wheelValue("wheelMinutes"), "0", "↑ en 00 no baja de 0");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  assert.equal(await wheelValue("wheelMinutes"), "2");
  assert.equal(await page.getAttribute("#wheelMinutes", "aria-valuetext"), "02 minutos");

  // Comprobación visual: al terminar la animación, el "01" (número anterior)
  // queda POR ENCIMA del centro y el "03" (siguiente) por debajo.
  // La física del resorte avanza por fotograma: se espera a que se detenga.
  await page.waitForFunction(() => minutesWheel.mode === "idle");
  const offsetY = (n) => page.evaluate((i) => {
    const wheel = document.getElementById("wheelMinutes").getBoundingClientRect();
    const item = document.querySelectorAll("#wheelMinutes .wheel__item")[i].getBoundingClientRect();
    return (item.top + item.height / 2) - (wheel.top + wheel.height / 2);
  }, n);
  assert.ok(Math.abs(await offsetY(2)) < 2, "el 02 está centrado");
  assert.ok(await offsetY(1) < -20, "el 01 está arriba");
  assert.ok(await offsetY(3) > 20, "el 03 está abajo");

  await page.keyboard.press("ArrowUp");
  assert.equal(await wheelValue("wheelMinutes"), "1");
  await page.keyboard.press("PageDown");
  assert.equal(await wheelValue("wheelMinutes"), "6");
  await page.keyboard.press("PageUp");
  assert.equal(await wheelValue("wheelMinutes"), "1");
  await page.keyboard.press("End");
  assert.equal(await wheelValue("wheelMinutes"), "59");
  await page.keyboard.press("Home");
  assert.equal(await wheelValue("wheelMinutes"), "0");
});

test("Enter sobre 'Cancelar' cancela (no salta) y devuelve el foco a 'Saltar a'", async () => {
  await load("formatos-variados.srt");
  await page.focus("#jumpBtn");
  await page.keyboard.press("Enter");
  await page.focus("#wheelMinutes");
  await page.keyboard.press("ArrowDown");
  await page.focus("button[value=cancel]");
  await page.keyboard.press("Enter");
  await settle();
  assert.equal(await modalOpen(), false);
  assert.equal(await counter(), "1 / 4");
  assert.equal(await activeId(), "jumpBtn");
});

test("Enter sobre una rueda confirma el salto", async () => {
  await load("formatos-variados.srt");
  await page.click("#jumpBtn");
  await page.focus("#wheelMinutes");
  await page.keyboard.press("ArrowDown"); // 00:01:00
  await page.keyboard.press("Enter");
  await settle();
  assert.equal(await counter(), "3 / 4");
  assert.equal(await caption(), "Un minuto & algo");
});

test("'Aceptar' salta al cue más cercano", async () => {
  await load("formatos-variados.srt");
  await page.click("#jumpBtn");
  await page.focus("#wheelMinutes");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown"); // 00:02:00
  await page.click("button[value=ok]");
  await settle();
  assert.equal(await counter(), "4 / 4");
});

test("Escape cancela aunque el salto anterior se hubiera aceptado", async () => {
  await load("formatos-variados.srt");
  await page.click("#jumpBtn");
  await page.click("button[value=ok]"); // salto a 00:00:00 (returnValue = "ok")
  await settle();
  await page.click("#nextBtn"); // 2/4
  await page.click("#jumpBtn");
  await page.focus("#wheelMinutes");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await settle();
  assert.equal(await modalOpen(), false);
  assert.equal(await counter(), "2 / 4");
});

test("clic en el fondo cierra sin saltar; clic dentro del cuadro no cierra", async () => {
  await load("formatos-variados.srt");
  await page.click("#jumpBtn");
  await page.click("#jumpTitle");
  assert.ok(await modalOpen(), "un clic dentro del cuadro no debe cerrarlo");
  await page.mouse.click(5, 5);
  await settle();
  assert.equal(await modalOpen(), false);
  assert.equal(await counter(), "1 / 4");
});

test("arrastrar una rueda con el puntero cambia su valor sin cerrar el diálogo", async () => {
  await load("formatos-variados.srt");
  await page.click("#jumpBtn");
  const box = await page.locator("#wheelSeconds").boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 130, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(1500);
  assert.ok(Number(await wheelValue("wheelSeconds")) > 0);
  assert.ok(await modalOpen());
});

/* ---------- Rueda activa: ← / → y anillo de foco propio ---------- */

const ringShown = () => page.evaluate(() => document.getElementById("timePicker").classList.contains("has-ring"));
const engagedId = () => page.evaluate(() => document.querySelector(".wheel.is-engaged")?.id ?? null);
// Centro horizontal del anillo respecto al de su rueda (≈ 0 si está alineado).
const ringOffsetX = (id) => page.evaluate((wheelId) => {
  const ring = document.getElementById("wheelRing").getBoundingClientRect();
  const wheel = document.getElementById(wheelId).getBoundingClientRect();
  return (ring.left + ring.width / 2) - (wheel.left + wheel.width / 2);
}, id);
const ringSettled = () => page.waitForTimeout(500); // transición de 0,38 s

test("← / → pasan de una rueda a otra y se detienen en los extremos", async () => {
  await load("formatos-variados.srt");
  await page.focus("#jumpBtn");
  await page.keyboard.press("Enter");
  assert.equal(await activeId(), "wheelHours");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await activeId(), "wheelHours", "← en la primera rueda no hace nada");
  await page.keyboard.press("ArrowRight");
  assert.equal(await activeId(), "wheelMinutes");
  await page.keyboard.press("ArrowRight");
  assert.equal(await activeId(), "wheelSeconds");
  await page.keyboard.press("ArrowRight");
  assert.equal(await activeId(), "wheelSeconds", "→ en la última rueda no hace nada");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await activeId(), "wheelMinutes");
  // Con el diálogo abierto, ← / → no cambian de subtítulo.
  assert.equal(await counter(), "1 / 4");
});

test("anillo con teclado: aparece al abrir con Enter y se desliza a la rueda activa", async () => {
  await load("formatos-variados.srt");
  await page.focus("#jumpBtn");
  await page.keyboard.press("Enter");
  assert.ok(await ringShown());
  assert.equal(await engagedId(), "wheelHours");
  await page.keyboard.press("ArrowRight");
  await ringSettled();
  assert.equal(await engagedId(), "wheelMinutes");
  assert.ok(Math.abs(await ringOffsetX("wheelMinutes")) < 1, "anillo alineado con minutos");
  // No hay contorno por defecto del navegador en las ruedas.
  assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), "none");
});

test("anillo con ratón: no aparece al abrir con clic, sí al arrastrar o girar una rueda", async () => {
  await load("formatos-variados.srt");
  await page.click("#jumpBtn");
  assert.equal(await ringShown(), false, "sin interacción con las ruedas no hay anillo");

  const box = await page.locator("#wheelSeconds").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  assert.ok(await ringShown(), "aparece al empezar a arrastrar");
  assert.equal(await engagedId(), "wheelSeconds");
  await page.mouse.up();

  const hours = await page.locator("#wheelHours").boundingBox();
  await page.mouse.move(hours.x + hours.width / 2, hours.y + hours.height / 2);
  await page.mouse.wheel(0, 100);
  await ringSettled();
  assert.equal(await engagedId(), "wheelHours", "la rueda del ratón también la activa");
  assert.equal(await activeId(), "wheelHours", "y le da el foco, para que las teclas actúen sobre ella");
  assert.ok(Math.abs(await ringOffsetX("wheelHours")) < 1);

  // Las flechas siguen funcionando sobre la rueda marcada.
  await page.keyboard.press("ArrowRight");
  assert.equal(await engagedId(), "wheelMinutes");
});

test("anillo: abrir con clic tras cerrar con Escape no lo muestra", async () => {
  await load("formatos-variados.srt");
  await page.focus("#jumpBtn");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await settle();
  await page.click("#jumpBtn");
  assert.equal(await ringShown(), false);
});

test("anillo: se oculta al salir de las ruedas con Tab y vuelve con Shift+Tab", async () => {
  await load("formatos-variados.srt");
  await page.focus("#jumpBtn");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight"); // segundos
  await page.keyboard.press("Tab"); // Cancelar
  assert.equal(await ringShown(), false);
  assert.equal(await page.evaluate(() => document.activeElement.value), "cancel");
  // Los botones también usan un foco propio (sin contorno del navegador).
  assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), "none");
  await page.keyboard.press("Shift+Tab");
  assert.ok(await ringShown());
  assert.equal(await engagedId(), "wheelSeconds");
});

/* ---------- Funcionalidad: reanudar + recientes (IndexedDB) ---------- */

const recentItems = () => page.locator("#recentsList .recents__open");
// La posición se guarda agrupada (400 ms) o al volver a la zona de carga.
const backToUploader = async () => {
  await page.click("#resetBtn");
  await page.waitForSelector("#recents:not([hidden])");
};

test("recientes: tras recargar la página, el archivo aparece con su posición", async () => {
  await load("formatos-variados.srt");
  await page.click("#nextBtn");
  await page.click("#nextBtn"); // 3/4
  await page.waitForTimeout(600); // guardado agrupado
  await page.reload();
  await page.waitForSelector("#recents:not([hidden])");
  assert.equal(await recentItems().count(), 1);
  const label = await recentItems().first().getAttribute("aria-label");
  assert.match(label, /formatos-variados.*Subtítulo 3 de 4/);
  assert.match(await recentItems().first().textContent(), /3 \/ 4/);
});

test("recientes: reabrir continúa donde se dejó y el toast permite empezar de cero", async () => {
  await load("formatos-variados.srt");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight"); // 3/4
  await backToUploader();
  await recentItems().first().click();
  await page.waitForSelector("#reader:not([hidden])");
  await page.waitForFunction(() => document.getElementById("counter").textContent === "3 / 4");
  assert.match(await page.textContent("#toastText"), /Continuando donde lo dejaste · 3 \/ 4/);
  await page.click("#toastAction");
  assert.equal(await counter(), "1 / 4");
  assert.ok(await page.isHidden("#toast"));
});

test("recientes: volver a cargar el MISMO archivo desde el disco también reanuda", async () => {
  await load("formatos-variados.srt");
  await page.keyboard.press("ArrowRight"); // 2/4
  await backToUploader();
  await load("formatos-variados.srt");
  await page.waitForFunction(() => document.getElementById("counter").textContent === "2 / 4");
});

test("recientes: la × quita el archivo y el foco no se pierde", async () => {
  await load("formatos-variados.srt");
  await backToUploader();
  await load("latin1-windows1252.srt");
  await backToUploader();
  await page.waitForFunction(() => document.querySelectorAll("#recentsList li").length === 2);
  // El más reciente va primero.
  assert.match(await recentItems().first().textContent(), /latin1/);
  await page.locator(".recents__remove").first().focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll("#recentsList li").length === 1);
  assert.equal(await page.evaluate(() => document.activeElement.className), "recents__open");
  await page.locator(".recents__remove").first().click();
  await page.waitForSelector("#recents", { state: "hidden" });
});

test("recientes: se conservan como máximo 8 archivos", async () => {
  for (let i = 1; i <= 9; i++) {
    await page.setInputFiles("#fileInput", {
      name: `serie.S01E0${i}.srt`, mimeType: "text/plain",
      buffer: Buffer.from(`1\n00:00:01,000 --> 00:00:02,000\nEpisodio ${i}\n`),
    });
    await page.waitForSelector("#reader:not([hidden])");
    await page.waitForTimeout(150);
    await page.click("#resetBtn");
  }
  await page.waitForTimeout(300);
  await page.reload();
  await page.waitForSelector("#recents:not([hidden])");
  assert.equal(await recentItems().count(), 8);
  assert.doesNotMatch(await page.textContent("#recentsList"), /episodio 1\b/i, "el más antiguo se descarta");
});

/* ---------- Funcionalidad: reproducción temporizada ----------
   Se usa el reloj simulado de Playwright: el tiempo solo avanza con
   page.clock.runFor(), así las pruebas son exactas en cualquier máquina.
   reproduccion.srt: Uno 1–2 s · Dos 3–4 s · Tres 4–5 s · Cuatro 8–9 s */

async function loadWithFakeClock(name) {
  await gotoWithPausedClock();
  await load(name);
}
const isGap = () => page.evaluate(() => document.getElementById("captionText").classList.contains("is-gap"));

test("reproducción: avanza con los tiempos reales, atenúa los huecos y se detiene al final", async () => {
  await loadWithFakeClock("reproduccion.srt");
  await page.click("#playBtn");
  assert.equal(await page.textContent("#playLabel"), "Pausar");
  assert.ok(await page.isVisible("#pauseIcon"), "icono de pausa visible");
  assert.ok(await page.isHidden("#playIcon"), "icono de play oculto");
  assert.ok(await page.isVisible("#playClock"));

  await page.clock.runFor(800);   // 1,8 s: dentro de "Uno"
  assert.equal(await counter(), "1 / 4");
  assert.equal(await isGap(), false);
  await page.clock.runFor(700);   // 2,5 s: hueco entre "Uno" y "Dos"
  assert.equal(await counter(), "1 / 4");
  assert.equal(await isGap(), true);
  await page.clock.runFor(600);   // 3,1 s
  assert.equal(await counter(), "2 / 4");
  assert.equal(await isGap(), false);
  assert.equal(await page.textContent("#playClock"), "00:00:03");
  await page.clock.runFor(1000);  // 4,1 s
  assert.equal(await counter(), "3 / 4");
  await page.clock.runFor(4000);  // 8,1 s
  assert.equal(await caption(), "Cuatro");
  await page.clock.runFor(1500);  // 9,6 s: terminó
  assert.equal(await page.textContent("#playLabel"), "Reproducir");
  assert.ok(await page.isHidden("#playClock"));

  // Reproducir de nuevo al terminar vuelve a empezar.
  await page.click("#playBtn");
  assert.equal(await counter(), "1 / 4");
});

test("reproducción: la velocidad 2× va el doble de rápido y se recuerda", async () => {
  await loadWithFakeClock("reproduccion.srt");
  await page.selectOption("#speedSelect", "2");
  await page.click("#playBtn");
  await page.clock.runFor(1100);  // 1 s + 2,2 s = 3,2 s de subtítulos
  assert.equal(await counter(), "2 / 4");
  await page.reload();
  assert.equal(await page.inputValue("#speedSelect"), "2");
});

test("reproducción: pausar detiene el avance y P alterna", async () => {
  await loadWithFakeClock("reproduccion.srt");
  await page.keyboard.press("p");
  await page.clock.runFor(500);
  await page.keyboard.press("p");
  assert.equal(await page.textContent("#playLabel"), "Reproducir");
  await page.clock.runFor(5000);
  assert.equal(await counter(), "1 / 4", "en pausa no avanza");
  await page.keyboard.press("p");
  await page.clock.runFor(1000);   // continúa desde 1,5 s -> 2,5 s
  assert.equal(await counter(), "1 / 4");
  await page.clock.runFor(700);    // 3,2 s
  assert.equal(await counter(), "2 / 4");
});

test("reproducción: moverse a mano continúa desde el subtítulo elegido", async () => {
  await loadWithFakeClock("reproduccion.srt");
  await page.click("#playBtn");
  await page.clock.runFor(200);
  await page.keyboard.press("ArrowRight"); // "Dos" (3 s)
  await page.keyboard.press("ArrowRight"); // "Tres" (4 s)
  assert.equal(await counter(), "3 / 4");
  await page.clock.runFor(3000);           // 7 s: hueco tras "Tres"
  assert.equal(await counter(), "3 / 4");
  assert.equal(await isGap(), true);
  await page.clock.runFor(1200);           // 8,2 s
  assert.equal(await counter(), "4 / 4");
});

test("reproducción: con el campo de búsqueda enfocado, P se escribe y no reproduce", async () => {
  await load("reproduccion.srt");
  await page.click("#transcriptBtn");
  await page.focus("#transcriptSearch");
  await page.keyboard.type("p");
  assert.equal(await page.inputValue("#transcriptSearch"), "p");
  assert.equal(await page.textContent("#playLabel"), "Reproducir");
});

/* ---------- Funcionalidad: transcripción con búsqueda ---------- */

const visibleRows = () => page.locator(".transcript__row:visible");
const currentRowText = () => page.textContent('.transcript__row[aria-current="true"] .transcript__text');
const searchFor = async (text) => {
  await page.fill("#transcriptSearch", text);
  await page.waitForTimeout(250); // debounce de 150 ms
};

test("transcripción: lista completa, sigue al subtítulo actual y un clic salta", async () => {
  await load("transcripcion.srt");
  await page.click("#transcriptBtn");
  assert.equal(await page.getAttribute("#transcriptBtn", "aria-expanded"), "true");
  assert.equal(await visibleRows().count(), 5);
  assert.equal(await page.textContent("#transcriptCount"), "5 subtítulos");
  assert.equal(await currentRowText(), "Primera línea del diálogo");
  await page.click("#nextBtn");
  assert.match(await currentRowText(), /texto raro/);
  await page.locator(".transcript__row").nth(3).click();
  assert.equal(await counter(), "4 / 5");
  assert.equal(await caption(), "Nada que ver");
});

test("transcripción: el texto de los subtítulos nunca se interpreta como HTML", async () => {
  await load("transcripcion.srt");
  await page.click("#transcriptBtn");
  await searchFor("img");
  assert.equal(await page.locator("#transcript img").count(), 0, "ni en la lista completa ni en los resultados");
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.match(await page.textContent("#transcriptResults"), /<img src=x onerror="window.__xss=1"> texto raro/);
  assert.match(await page.textContent("#transcriptList"), /<img src=x onerror="window.__xss=1"> texto raro/);
});

test("transcripción: búsqueda sin tildes ni mayúsculas, con resaltado", async () => {
  await load("transcripcion.srt");
  await page.keyboard.press("/");
  assert.equal(await activeId(), "transcriptSearch", "/ abre el panel y enfoca la búsqueda");
  await searchFor("linea");
  assert.equal(await page.textContent("#transcriptCount"), "3 resultados");
  assert.equal(await visibleRows().count(), 3);
  assert.deepEqual(await page.locator("#transcriptResults mark").allTextContents(), ["línea", "LÍNEA", "línea"]);

  await searchFor("zzz");
  assert.equal(await page.textContent("#transcriptCount"), "Sin resultados");
  assert.equal(await visibleRows().count(), 0);
  assert.match(await page.textContent(".transcript__empty"), /Sin resultados para «zzz»/);
});

test("transcripción: Enter / Shift+Enter recorren los resultados; Escape borra y cierra", async () => {
  await load("transcripcion.srt");
  await page.keyboard.press("/");
  await searchFor("línea");
  await page.keyboard.press("Enter");
  assert.equal(await counter(), "3 / 5", "siguiente resultado tras el actual (1)");
  await page.keyboard.press("Enter");
  assert.equal(await counter(), "5 / 5");
  await page.keyboard.press("Enter");
  assert.equal(await counter(), "1 / 5", "vuelve al principio");
  await page.keyboard.press("Shift+Enter");
  assert.equal(await counter(), "5 / 5");

  await page.keyboard.press("Escape");
  assert.equal(await page.inputValue("#transcriptSearch"), "");
  assert.equal(await visibleRows().count(), 5);
  await page.keyboard.press("Escape");
  assert.ok(await page.isHidden("#transcript"));
  assert.equal(await activeId(), "transcriptBtn", "el foco vuelve al botón");
});

test("transcripción: T abre y cierra; al volver a la carga se vacía", async () => {
  await load("transcripcion.srt");
  await page.keyboard.press("t");
  assert.ok(await page.isVisible("#transcript"));
  await page.keyboard.press("t");
  assert.ok(await page.isHidden("#transcript"));
  await page.click("#resetBtn");
  assert.equal(await page.locator("#transcriptList li").count(), 0);
});

test("transcripción: con 3.000 subtítulos abre y busca con fluidez", async () => {
  const blocks = [];
  for (let i = 0; i < 3000; i++) {
    const t = (n) => new Date(n).toISOString().slice(11, 23).replace(".", ",");
    blocks.push(`${i + 1}\n${t(i * 2000)} --> ${t(i * 2000 + 1500)}\nFrase número ${i + 1} con algo de texto ${i % 7 === 0 ? "especial" : ""}`);
  }
  await page.setInputFiles("#fileInput", { name: "larga.srt", mimeType: "text/plain", buffer: Buffer.from(blocks.join("\n\n")) });
  await page.waitForSelector("#reader:not([hidden])");
  const openMs = await page.evaluate(async () => {
    const t0 = performance.now();
    document.getElementById("transcriptBtn").click();
    await new Promise(requestAnimationFrame);
    return performance.now() - t0;
  });
  const searchMs = await page.evaluate(() => {
    const input = document.getElementById("transcriptSearch");
    input.value = "especial";
    const t0 = performance.now();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); // busca sin esperar
    return performance.now() - t0;
  });
  assert.equal(await page.textContent("#transcriptCount"), "429 resultados");
  console.log(`      abrir: ${openMs.toFixed(0)} ms · buscar: ${searchMs.toFixed(0)} ms`);
  assert.ok(openMs < 1000 && searchMs < 500, `demasiado lento: abrir ${openMs} ms, buscar ${searchMs} ms`);
});

/* ---------- Funcionalidad: PWA (sin conexión, instalar, abrir con…) ----------
   El Service Worker necesita http(s): se sirve la carpeta del proyecto con
   un servidor estático mínimo, como haría GitHub Pages. */

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json", ".srt": "text/plain",
};
let server;
let HTTP_URL;

async function startServer() {
  if (server) return;
  server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");
    const file = path.join(root, decodeURIComponent(pathname.endsWith("/") ? `${pathname}index.html` : pathname));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  HTTP_URL = `http://127.0.0.1:${server.address().port}/`;
}
after(() => server?.close());

const pngSize = (buffer) => [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];

test("PWA: manifiesto válido con iconos 192/512/maskable y apertura de .srt", async () => {
  await startServer();
  await page.goto(HTTP_URL);
  const href = await page.getAttribute('link[rel="manifest"]', "href");
  const response = await page.request.get(new URL(href, HTTP_URL).href);
  assert.equal(response.status(), 200);
  const manifest = await response.json();
  assert.equal(manifest.name, "Captions Reader");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "./");
  assert.deepEqual(manifest.file_handlers[0].accept["application/x-subrip"], [".srt"]);
  for (const icon of manifest.icons) {
    const png = await (await page.request.get(new URL(icon.src, HTTP_URL).href)).body();
    assert.equal(pngSize(png).join("x"), icon.sizes, `${icon.src} mide lo que declara`);
  }
  assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable"));
});

test("PWA: con el Service Worker activo, la app carga y funciona SIN CONEXIÓN", async () => {
  await startServer();
  await page.goto(HTTP_URL);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // ahora la página está controlada por el Service Worker
  assert.ok(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)));
  const caches = await page.evaluate(() => caches.keys());
  assert.ok(caches.some((key) => key.startsWith("captions-reader-app-")), "caché de la app creada");

  await context.setOffline(true);
  await page.reload();
  assert.ok(await page.isVisible("#dropzone"), "la página carga sin conexión");
  await load("formatos-variados.srt");
  await page.keyboard.press("ArrowRight");
  assert.equal(await counter(), "2 / 4", "y funciona sin conexión");
  await context.setOffline(false);
});

test("PWA: la primera visita avisa de que ya funciona sin conexión", async () => {
  await startServer();
  await page.goto(HTTP_URL);
  await page.waitForFunction(() => /sin conexión/.test(document.getElementById("toastText").textContent));
});

test("PWA: abierta con file:// no intenta registrar el Service Worker", async () => {
  // En file:// Chrome no permite ni consultar los registros: se vigila si la
  // app llama a register().
  await page.addInitScript(() => {
    window.__registerCalls = 0;
    if (navigator.serviceWorker) {
      navigator.serviceWorker.register = () => { window.__registerCalls++; return Promise.reject(new Error("no")); };
    }
  });
  await page.goto(APP_URL);
  await page.waitForLoadState("load");
  assert.equal(await page.evaluate(() => window.__registerCalls), 0);
});

test("PWA: botón 'Instalar app' cuando el navegador lo ofrece", async () => {
  assert.ok(await page.isHidden("#installBtn"));
  await page.evaluate(() => {
    const event = new Event("beforeinstallprompt", { cancelable: true });
    event.prompt = () => { window.__prompted = true; };
    event.userChoice = Promise.resolve({ outcome: "accepted" });
    window.dispatchEvent(event);
  });
  assert.ok(await page.isVisible("#installBtn"));
  await page.click("#installBtn");
  assert.equal(await page.evaluate(() => window.__prompted), true);
  assert.ok(await page.isHidden("#installBtn"));
});

test("PWA: 'Abrir con…' del sistema operativo abre el .srt (File Handling API)", async () => {
  // Chromium ya trae window.launchQueue (de solo lectura): se redefine.
  await page.addInitScript(() => {
    Object.defineProperty(window, "launchQueue", {
      configurable: true,
      value: { setConsumer: (consumer) => { window.__launchConsumer = consumer; } },
    });
  });
  await page.goto(APP_URL);
  const srt = fs.readFileSync(fixture("formatos-variados.srt"), "utf8");
  await page.evaluate((text) => window.__launchConsumer({
    files: [{ getFile: async () => new File([text], "Serie.S01E02.Piloto.srt") }],
  }), srt);
  await page.waitForSelector("#reader:not([hidden])");
  assert.equal(await counter(), "1 / 4");
  assert.match(await page.textContent("#tagline"), /Serie \| Temporada 1, episodio 2: 'Piloto'/);
});
