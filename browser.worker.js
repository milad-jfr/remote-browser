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

const sessions = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanupResults(maxResults = 5) {

  const resultJsonFiles = fs.readdirSync(RESULT_DIR)
    .filter(file =>
      file.endsWith(".json") &&
      !file.endsWith(".video.json")
    )
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

    const videoPath =
      path.join(RESULT_DIR, `${id}.video.json`);

    if (fs.existsSync(jsonPath)) {
      fs.unlinkSync(jsonPath);
    }

    if (fs.existsSync(imagePath)) {
      fs.unlinkSync(imagePath);
    }

    if (fs.existsSync(videoPath)) {
      fs.unlinkSync(videoPath);
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

async function focusEditableElement(page) {

  try {

    const locator =
      page.locator(
        "input, textarea, [contenteditable='true']"
      ).last();

    const count =
      await locator.count();

    if (count > 0) {

      await locator.click({
        timeout: 3000
      });

      return true;
    }

  } catch (_) {}

  return false;
}

async function performNaturalPaste(page, text) {

  await focusEditableElement(page);

  await sleep(300);

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

async function getSession(sessionId) {

  if (sessions.has(sessionId)) {

    const existing =
      sessions.get(sessionId);

    try {

      await existing.page.title();

      return existing;

    } catch (_) {

      sessions.delete(sessionId);
    }
  }

  const sessionPath =
    path.join(SESSION_DIR, sessionId);

  const statePath =
    path.join(sessionPath, "state.json");

  if (!fs.existsSync(sessionPath)) {

    fs.mkdirSync(sessionPath, {
      recursive: true
    });
  }

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

  const session = {
    browser,
    context,
    page,
    sessionPath,
    statePath,
    lastX: null,
    lastY: null
  };

  sessions.set(sessionId, session);

  console.log(
    `Created persistent session: ${sessionId}`
  );

  return session;
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

  console.log(
    `Processing browser request: ${id}`
  );

  const session =
    await getSession(sessionId);

  const page =
    session.page;

  const context =
    session.context;

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

    if (action === "open") {

      if (!request.url) {

        throw new Error(
          "Missing request.url"
        );
      }

      await page.goto(
        request.url,
        {
          waitUntil: "domcontentloaded",
          timeout: 60000
        }
      );

      await sleep(2000);
    }

    if (action === "click") {

      if (
        typeof request.x !== "number" ||
        typeof request.y !== "number"
      ) {

        throw new Error(
          "Missing click coordinates"
        );
      }

      session.lastX = request.x;
      session.lastY = request.y;

      await sleep(300);

      await performNaturalClick(
        page,
        request.x,
        request.y
      );

      await sleep(2000);
    }

    if (action === "paste_text") {

      const text =
        request.text || "";

      if (
        session.lastX !== null &&
        session.lastY !== null
      ) {

        try {

          await page.mouse.click(
            session.lastX,
            session.lastY
          );

        } catch (_) {}
      }

      await sleep(300);

      await performNaturalPaste(
        page,
        text
      );

      await sleep(1500);
    }

    await waitForPageReady(
      page,
      15000
    );

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

      result.url = "";
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
      path: session.statePath
    });

  } catch (err) {

    result.status = "error";

    result.error = err.message;
  }

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
