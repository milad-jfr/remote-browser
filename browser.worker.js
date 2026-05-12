import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { execSync } from "child_process";

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

console.log("Remote browser worker started");

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

async function autoScroll(page) {

  await page.evaluate(async () => {

    await new Promise((resolve) => {

      let totalHeight = 0;
      const distance = 1000;

      const timer = setInterval(() => {

        const scrollHeight = document.body.scrollHeight;

        window.scrollBy(0, distance);

        totalHeight += distance;

        if (totalHeight >= scrollHeight) {

          clearInterval(timer);

          window.scrollTo(0, 0);

          resolve();
        }

      }, 250);

    });

  });
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

  console.log(`Processing: ${id}`);

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
    screenshot: `${id}.jpg`,
    error: null,
    createdAt: Date.now()
  };

  try {

    const action = request.action || "open";

    if (action === "open") {

      await page.goto(request.url, {
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

      await page.mouse.click(request.x, request.y);

      await sleep(3000);
    }

    await page.waitForSelector("body", {
      timeout: 15000
    });

    await sleep(3000);

    await autoScroll(page);

    await sleep(2000);

    result.title = await page.title();
    result.url = page.url();

    await page.screenshot({
      path: path.join(RESULT_DIR, `${id}.jpg`),
      type: "jpeg",
      quality: 60,
      fullPage: true
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
    path.join(RESULT_DIR, `${id}.json`),
    JSON.stringify(result, null, 2)
  );

  cleanupResults(5);

  if (fs.existsSync(requestPath)) {
    fs.unlinkSync(requestPath);
  }

  execSync("git add request result sessions", {
    stdio: "ignore"
  });

  execSync(`git commit -m "processed ${id}" || true`, {
    stdio: "ignore"
  });

  execSync("git push", {
    stdio: "ignore"
  });

  console.log(`Finished: ${id}`);
}

async function main() {

  while (true) {

    try {

      execSync("git fetch origin main", {
        stdio: "ignore"
      });

      execSync("git reset --hard origin/main", {
        stdio: "ignore"
      });

      const files = fs.readdirSync(REQUEST_DIR)
        .filter(file => file.endsWith(".json"))
        .sort();

      if (files.length > 0) {

        await processRequest(files[0]);

        process.exit(0);
      }

    } catch (err) {

      console.error("Worker error:", err.message);

    }

    await sleep(5000);
  }
}

main();
