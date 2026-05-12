import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { execSync } from "child_process";

const REQUEST_DIR = "./request";
const RESULT_DIR = "./result";

if (!fs.existsSync(REQUEST_DIR)) {
  fs.mkdirSync(REQUEST_DIR, { recursive: true });
}

if (!fs.existsSync(RESULT_DIR)) {
  fs.mkdirSync(RESULT_DIR, { recursive: true });
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

  const url = request.url;

  console.log(`Processing: ${id}`);
  console.log(`URL: ${url}`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ]
  });

  const context = await browser.newContext({

    viewport: {
      width: 1920,
      height: 1080
    },

    deviceScaleFactor: 1,

    isMobile: false,

    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
  });

  const page = await context.newPage();

  const result = {
    id,
    url,
    status: "success",
    title: "",
    screenshot: `${id}.jpg`,
    error: null,
    createdAt: Date.now()
  };

  try {

    await page.goto(url, {
      waitUntil: "networkidle",
      timeout: 90000
    });

    await page.waitForSelector("body", {
      timeout: 20000
    });

    // زمان برای render اولیه
    await sleep(3000);

    // اسکرول برای lazy-load
    await autoScroll(page);

    // زمان برای render نهایی
    await sleep(2000);

    result.title = await page.title();

    await page.screenshot({
      path: path.join(RESULT_DIR, `${id}.jpg`),
      type: "jpeg",
      quality: 60,
      fullPage: true
    });

    console.log(`Screenshot saved: ${id}.jpg`);

  } catch (err) {

    console.error(err);

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

  execSync("git add request result", {
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
