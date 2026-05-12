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

function cleanupResults(maxResults = 5) {

  const resultJsonFiles = fs.readdirSync(RESULT_DIR)
    .filter(file => file.endsWith(".json"))
    .sort();

  if (resultJsonFiles.length <= maxResults) return;

  const filesToDelete = resultJsonFiles.slice(
    0,
    resultJsonFiles.length - maxResults
  );

  for (const file of filesToDelete) {

    const id = path.parse(file).name;

    const jsonPath = path.join(RESULT_DIR, `${id}.json`);
    const imagePath = path.join(RESULT_DIR, `${id}.jpg`);

    if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
    if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);

    console.log(`Deleted old result: ${id}`);
  }
}

async function processRequest(fileName) {

  const requestPath = path.join(REQUEST_DIR, fileName);

  const raw = fs.readFileSync(requestPath, "utf8");
  const request = JSON.parse(raw);

  const id = path.parse(fileName).name;
  const url = request.url;

  console.log(`Processing: ${id}`);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"]
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 }
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
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForSelector("body", {
      timeout: 15000
    });

    // زمان اضافه برای render پایدارتر
    await page.waitForTimeout(5000);

    result.title = await page.title();

    await page.screenshot({
      path: path.join(RESULT_DIR, `${id}.jpg`),
      type: "jpeg",
      quality: 40,
      fullPage: true
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

  fs.unlinkSync(requestPath);

  execSync("git add request result", { stdio: "ignore" });
  execSync(`git commit -m "processed ${id}" || true`, { stdio: "ignore" });
  execSync("git push", { stdio: "ignore" });

  console.log(`Finished: ${id}`);
}

async function main() {

  while (true) {

    try {

      execSync("git fetch origin main", { stdio: "ignore" });
      execSync("git reset --hard origin/main", { stdio: "ignore" });

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

    // polling آرام‌تر و پایدارتر
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

main();
