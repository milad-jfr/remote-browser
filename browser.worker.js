import fs from "fs";
import path from "path";
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

    const jsonPath = path.join(RESULT_DIR, `${id}.json`);
    const imagePath = path.join(RESULT_DIR, `${id}.jpg`);

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
    await page.waitForLoadState("domcontentloaded", { timeout });
  } catch (_) {}

  while (Date.now() - start < timeout) {
    try {
      const bodyExists = await page.locator("body").count();

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
            const scrollHeight = document.body
              ? document.body.scrollHeight
              : 0;

            window.scrollBy(0, distance);
            totalHeight += distance;

            if (totalHeight >= scrollHeight) {
              clearInterval(timer);
              window.scrollTo(0, 0);
              resolve();
            }
          } catch (e) {
            clearInterval(timer);
            resolve();
          }
        }, 250);
      });
    });
  } catch (err) {
    console.log("autoScroll skipped:", err.message);
  }
}

async function performRealClick(page, x, y) {
  const elementInfo = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);

    if (!el) {
      return null;
    }

    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const href = el.href || null;

    return {
      tag,
      role,
      href,
      text: (el.innerText || "").slice(0, 100)
    };
  }, { x, y });

  console.log("Clicked element:", elementInfo);

  await page.mouse.move(x, y);

  await sleep(100);

  await page.mouse.down();

  await sleep(80);

  await page.mouse.up();

  try {
    await Promise.race([
      page.waitForLoadState("domcontentloaded", {
        timeout: 5000
      }),
      page.waitForTimeout(5000)
    ]);
  } catch (_) {}

  await sleep(1500);

  return elementInfo;
}

async function processRequest(fileName) {
  const requestPath = path.join(REQUEST_DIR, fileName);
  const raw = fs.readFileSync(requestPath, "utf8");
  const request = JSON.parse(raw);

  const id = path.parse(fileName).name;
  const sessionId = request.sessionId || "default";
  const sessionPath = path.join(SESSION_DIR, sessionId);
  const statePath = path.join(sessionPath, "state.json");

  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
  }

  console.log(`Processing browser request: ${id}`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ]
  });

  let context;

  if (fs.existsSync(statePath)) {
    context = await browser.newContext({
      storageState: statePath,
      viewport: {
        width: 1920,
        height: 1080
      },
      deviceScaleFactor: 1,
      isMobile: false
    });
  } else {
    context = await browser.newContext({
      viewport: {
        width: 1920,
        height: 1080
      },
      deviceScaleFactor: 1,
      isMobile: false
    });
  }

  const page = await context.newPage();

  const result = {
    id,
    sessionId,
    status: "success",
    title: "",
    url: "",
    screenshot: `${id}.jpg`,
    clickedElement: null,
    error: null,
    createdAt: Date.now()
  };

  try {
    const action = request.action || "open";
    const targetUrl = request.url;

    if (action === "open") {
      if (!targetUrl) {
        throw new Error("Missing request.url for open action");
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

      await sleep(2000);

      if (
        typeof request.x !== "number" ||
        typeof request.y !== "number"
      ) {
        throw new Error("Missing click coordinates");
      }

      result.clickedElement = await performRealClick(
        page,
        request.x,
        request.y
      );
    }

    const ready = await waitForPageReady(page, 15000);

    if (!ready) {
      console.log("Body not fully ready, continuing with fallback...");
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

    await autoScroll(page);

    await sleep(1500);

    try {
      result.title = await page.title();
    } catch (_) {
      result.title = "";
    }

    try {
      result.url = page.url();
    } catch (_) {
      result.url = targetUrl || "";
    }

    await page.screenshot({
      path: path.join(RESULT_DIR, `${id}.jpg`),
      type: "jpeg",
      quality: 60,
      fullPage: true
    });

    console.log("Screenshot captured");

    await context.storageState({
      path: statePath
    });

  } catch (err) {
    result.status = "error";
    result.error = err.message;

    console.error("Worker error:", err);
  }

  await browser.close();

  fs.writeFileSync(
    path.join(RESULT_DIR, `${id}.json`),
    JSON.stringify(result, null, 2)
  );

  cleanupResults(5);

  console.log(`Finished browser request: ${id}`);
}

async function main() {
  const fileName = process.argv[2];

  if (!fileName) {
    console.error("No request file provided");
    process.exit(1);
  }

  try {
    await processRequest(fileName);
  } catch (err) {
    console.error("Browser worker failed:", err.message);
    process.exit(1);
  }
}

main();
