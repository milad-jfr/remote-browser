import fs from "fs";
import path from "path";
import os from "os";
import { chromium } from "playwright";

const REQUEST_DIR = "./request";
const RESULT_DIR = "./result";
const SESSION_DIR = "./sessions";

if (!fs.existsSync(REQUEST_DIR)) {
  fs.mkdirSync(REQUEST_DIR, { recursive: true });
}

if (!fs.existsSync(RESULT_DIR)) {
  fs.mkdirSync(RESULT_DIR, { recursive: true });
}

if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanupResults(maxResults = 5) {

  const resultJsonFiles = fs.readdirSync(RESULT_DIR)
    .filter(file => file.endsWith(".json"))
    .sort();

  if (resultJsonFiles.length <= maxResults) {
    return;
  }

  const filesToDelete = resultJsonFiles.slice(
    0,
    resultJsonFiles.length - maxResults
  );

  for (const file of filesToDelete) {

    const id = path.parse(file).name;

    const jsonPath =
      path.join(RESULT_DIR, `${id}.json`);

    const imagePath =
      path.join(RESULT_DIR, `${id}.jpg`);

    if (fs.existsSync(jsonPath)) {
      fs.unlinkSync(jsonPath);
    }

    if (fs.existsSync(imagePath)) {
      fs.unlinkSync(imagePath);
    }

    console.log(`Deleted old result: ${id}`);
  }
}

async function waitForPageReady(page, timeout = 20000) {

  const start = Date.now();

  try {
    await page.waitForLoadState(
      "domcontentloaded",
      { timeout }
    );
  } catch (_) {}

  while (Date.now() - start < timeout) {

    try {

      const bodyExists =
        await page.locator("body").count();

      if (bodyExists > 0) {
        return true;
      }

    } catch (_) {}

    await sleep(300);
  }

  return false;
}

async function autoScroll(page) {

  try {

    await page.evaluate(async () => {

      if (!document.body) {
        return;
      }

      await new Promise((resolve) => {

        let totalHeight = 0;

        const distance = 1000;

        const timer = setInterval(() => {

          try {

            const scrollHeight =
              document.body
                ? document.body.scrollHeight
                : 0;

            window.scrollBy(0, distance);

            totalHeight += distance;

            if (totalHeight >= scrollHeight) {

              clearInterval(timer);

              window.scrollTo(0, 0);

              resolve();
            }

          } catch (_) {

            clearInterval(timer);

            resolve();
          }

        }, 250);

      });

    });

  } catch (err) {

    console.log(
      "autoScroll skipped:",
      err.message
    );
  }
}

async function naturalMouseMove(page, targetX, targetY) {

  const viewport = page.viewportSize();

  const startX =
    Math.floor(viewport.width / 2);

  const startY =
    Math.floor(viewport.height / 2);

  const steps = 30;

  for (let i = 0; i <= steps; i++) {

    const progress = i / steps;

    const currentX =
      startX +
      ((targetX - startX) * progress);

    const currentY =
      startY +
      ((targetY - startY) * progress);

    await page.mouse.move(
      currentX,
      currentY
    );

    await sleep(
      5 + Math.random() * 15
    );
  }
}

async function performNaturalClick(page, x, y) {

  await naturalMouseMove(page, x, y);

  await sleep(
    50 + Math.random() * 80
  );

  await page.mouse.down();

  await sleep(
    40 + Math.random() * 120
  );

  await page.mouse.up();
}

async function performNaturalPaste(page, text) {

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

  await sleep(200);

  await page.keyboard.press(
    `${modifier}+V`
  );
}

async function processRequest(fileName) {

  const requestPath =
    path.join(REQUEST_DIR, fileName);

  const raw =
    fs.readFileSync(requestPath, "utf8");

  const request =
    JSON.parse(raw);

  const id =
    path.parse(fileName).name;

  const sessionId =
    request.sessionId || "default";

  const sessionPath =
    path.join(SESSION_DIR, sessionId);

  const statePath =
    path.join(sessionPath, "state.json");

  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, {
      recursive: true
    });
  }

  console.log(
    `Processing browser request: ${id}`
  );

  const browser =
    await chromium.launch({

      headless: false,

      slowMo: 20,

      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });

  let context;

  if (fs.existsSync(statePath)) {

    context =
      await browser.newContext({

        storageState: statePath,

        viewport: {
          width: 1920,
          height: 1080
        },

        deviceScaleFactor: 1,

        isMobile: false
      });

  } else {

    context =
      await browser.newContext({

        viewport: {
          width: 1920,
          height: 1080
        },

        deviceScaleFactor: 1,

        isMobile: false
      });
  }

  const page =
    await context.newPage();

  const result = {
    id,
    sessionId,
    status: "success",
    title: "",
    url: "",
    screenshot: `${id}.jpg`,
    error: null,
    createdAt: Date.now()
  };

  try {

    const action =
      request.action || "open";

    const targetUrl =
      request.url;

    if (action === "open") {

      if (!targetUrl) {
        throw new Error(
          "Missing request.url for open action"
        );
      }

      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000
      });
    }

    if (action === "click") {

      if (request.url) {

        await page.goto(request.url, {
          waitUntil: "domcontentloaded",
          timeout: 60000
        });
      }

      await sleep(1500);

      if (
        typeof request.x !== "number" ||
        typeof request.y !== "number"
      ) {
        throw new Error(
          "Missing click coordinates"
        );
      }

      await performNaturalClick(
        page,
        request.x,
        request.y
      );

      await sleep(2500);
    }

    if (action === "paste_text") {

      if (request.url) {

        await page.goto(request.url, {
          waitUntil: "domcontentloaded",
          timeout: 60000
        });
      }

      await sleep(1000);

      const text =
        request.text || "";

      await performNaturalPaste(
        page,
        text
      );

      await sleep(1500);
    }

    const ready =
      await waitForPageReady(
        page,
        15000
      );

    if (!ready) {

      console.log(
        "Body not fully ready, continuing with fallback..."
      );
    }

    await sleep(2000);

    try {

      await page
        .locator("body")
        .first()
        .waitFor({
          timeout: 5000,
          state: "attached"
        });

    } catch (_) {}

    try {

      result.title =
        await page.title();

    } catch (_) {

      result.title = "";
    }

    try {

      result.url =
        await page.url();

    } catch (_) {

      result.url =
        targetUrl || "";
    }

    await page.screenshot({

      path: path.join(
        RESULT_DIR,
        `${id}.jpg`
      ),

      type: "jpeg",

      quality: 80,

      fullPage: false
    });

    await context.storageState({
      path: statePath
    });

  } catch (err) {

    result.status = "error";

    result.error = err.message;
  }

  await browser.close();

  fs.writeFileSync(

    path.join(
      RESULT_DIR,
      `${id}.json`
    ),

    JSON.stringify(
      result,
      null,
      2
    )
  );

  cleanupResults(5);

  console.log(
    `Finished browser request: ${id}`
  );
}

async function main() {

  const fileName =
    process.argv[2];

  if (!fileName) {

    console.error(
      "No request file provided"
    );

    process.exit(1);
  }

  try {

    await processRequest(fileName);

  } catch (err) {

    console.error(
      "Browser worker failed:",
      err.message
    );

    process.exit(1);
  }
}

main();
