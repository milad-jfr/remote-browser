import fs from "fs";
import path from "path";
import os from "os";
import { chromium } from "playwright";

const REQUEST_DIR = "./request";
const RESULT_DIR = "./result";

if (!fs.existsSync(REQUEST_DIR)) {
  fs.mkdirSync(REQUEST_DIR, { recursive: true });
}

if (!fs.existsSync(RESULT_DIR)) {
  fs.mkdirSync(RESULT_DIR, { recursive: true });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const sessions = new Map();

async function getSession(sessionId) {

  if (sessions.has(sessionId)) {
    return sessions.get(sessionId);
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage"
    ]
  });

  const context = await browser.newContext({
    viewport: {
      width: 1920,
      height: 1080
    },
    deviceScaleFactor: 1,
    isMobile: false
  });

  const page = await context.newPage();

  const session = {
    browser,
    context,
    page
  };

  sessions.set(sessionId, session);

  return session;
}

async function waitForPageReady(page) {

  try {
    await page.waitForLoadState("domcontentloaded", {
      timeout: 30000
    });
  } catch (_) {}

  await sleep(1500);
}

async function naturalMouseMove(page, targetX, targetY) {

  const steps = 25;

  const box = await page.evaluate(() => {
    return {
      width: window.innerWidth,
      height: window.innerHeight
    };
  });

  const startX = Math.floor(box.width / 2);
  const startY = Math.floor(box.height / 2);

  for (let i = 0; i <= steps; i++) {

    const progress = i / steps;

    const currentX =
      startX + (targetX - startX) * progress;

    const currentY =
      startY + (targetY - startY) * progress;

    await page.mouse.move(currentX, currentY);

    await sleep(8 + Math.random() * 12);
  }
}

async function makeScreenshot(page, id) {

  await page.screenshot({
    path: path.join(RESULT_DIR, `${id}.jpg`),
    type: "jpeg",
    quality: 80,
    fullPage: false
  });
}

async function saveResult(id, result) {

  fs.writeFileSync(
    path.join(RESULT_DIR, `${id}.json`),
    JSON.stringify(result, null, 2)
  );
}

async function processRequest(fileName) {

  const requestPath =
    path.join(REQUEST_DIR, fileName);

  const raw =
    fs.readFileSync(requestPath, "utf8");

  const request = JSON.parse(raw);

  const id =
    path.parse(fileName).name;

  const sessionId =
    request.sessionId || "default";

  const {
    page
  } = await getSession(sessionId);

  const result = {
    id,
    sessionId,
    status: "success",
    title: "",
    url: "",
    screenshot: `${id}.jpg`,
    error: null
  };

  try {

    const action =
      request.action || "open";

    if (action === "open") {

      await page.goto(request.url, {
        waitUntil: "domcontentloaded",
        timeout: 60000
      });

      await waitForPageReady(page);
    }

    else if (action === "click") {

      const x = request.x;
      const y = request.y;

      if (
        typeof x !== "number" ||
        typeof y !== "number"
      ) {
        throw new Error("Invalid click coordinates");
      }

      await naturalMouseMove(page, x, y);

      await sleep(100);

      await page.mouse.down();

      await sleep(50 + Math.random() * 80);

      await page.mouse.up();

      await sleep(2500);
    }

    else if (action === "paste_text") {

      const text = request.text || "";

      await page.evaluate(async (clipboardText) => {

        try {
          await navigator.clipboard.writeText(
            clipboardText
          );
        } catch (_) {}

      }, text);

      const modifier =
        os.platform() === "darwin"
          ? "Meta"
          : "Control";

      await page.keyboard.press(`${modifier}+V`);

      await sleep(1000);
    }

    result.title = await page.title();
    result.url = page.url();

    await makeScreenshot(page, id);

  } catch (err) {

    result.status = "error";
    result.error = err.message;
  }

  await saveResult(id, result);

  console.log(`done: ${id}`);
}

async function main() {

  const fileName = process.argv[2];

  if (!fileName) {
    process.exit(1);
  }

  try {
    await processRequest(fileName);
  } catch (err) {
    console.error(err);
  }
}

main();
