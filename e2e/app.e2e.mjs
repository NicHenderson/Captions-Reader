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

// El evento "close" de <dialog> se despacha en una tarea posterior al cierre.
const settle = () => page.waitForTimeout(100);

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
  await page.focus("#copyBtn");
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

test("ruedas con teclado: ↑/↓, AvPág/RePág, Inicio/Fin y valores ARIA", async () => {
  await load("formatos-variados.srt");
  await page.click("#jumpBtn");
  await page.focus("#wheelMinutes");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  assert.equal(await wheelValue("wheelMinutes"), "2");
  assert.equal(await page.getAttribute("#wheelMinutes", "aria-valuetext"), "02 minutos");
  await page.keyboard.press("ArrowDown");
  assert.equal(await wheelValue("wheelMinutes"), "1");
  await page.keyboard.press("PageUp");
  assert.equal(await wheelValue("wheelMinutes"), "6");
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
  await page.keyboard.press("ArrowUp");
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
  await page.keyboard.press("ArrowUp"); // 00:01:00
  await page.keyboard.press("Enter");
  await settle();
  assert.equal(await counter(), "3 / 4");
  assert.equal(await caption(), "Un minuto & algo");
});

test("'Aceptar' salta al cue más cercano", async () => {
  await load("formatos-variados.srt");
  await page.click("#jumpBtn");
  await page.focus("#wheelMinutes");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp"); // 00:02:00
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
  await page.keyboard.press("ArrowUp");
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
