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

async function waitForPageReady(page, timeout = 15000) {
  const start = Date.now();

  try {
    await page.waitForLoadState("domcontentloaded", {
      timeout
    });
  } catch (_) {}

  while (Date.now() - start < timeout) {
    try {
      const bodyExists = await page
        .locator("body")
        .count();

      if (bodyExists > 0) {
        return true;
      }
    } catch (_) {}

    await sleep(300);
  }

  return false;
}

async function waitAfterAction(page) {
  try {
    await page.waitForLoadState(
      "networkidle",
      {
        timeout: 3000
      }
    );
  } catch (_) {}

  await sleep(1000);
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

// --------------------
// SESSION CACHE
// --------------------

const sessions = new Map();

async function getSession(sessionId, statePath) {
  const existing = sessions.get(sessionId);

  // اگر session هنوز زنده است
  if (existing) {
    try {
      if (!existing.page.isClosed()) {
        return existing;
      }
    } catch (_) {}
  }

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

  const session = {
    browser,
    context,
    page,
    lastUsedAt: Date.now()
  };

  sessions.set(sessionId, session);

  return session;
}

async function processRequest(fileName) {
  const requestPath = path.join(
    REQUEST_DIR,
    fileName
  );

  const raw = fs.readFileSync(
    requestPath,
    "utf8"
  );

  const request = JSON.parse(raw);

  const id = path.parse(fileName).name;

  const sessionId =
    request.sessionId || "default";

  const sessionPath = path.join(
    SESSION_DIR,
    sessionId
  );

  const statePath = path.join(
    sessionPath,
    "state.json"
  );

  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, {
      recursive: true
    });
  }

  console.log(
    `Processing browser request: ${id}`
  );

  // --------------------
  // REUSE SESSION
  // --------------------

  const session = await getSession(
    sessionId,
    statePath
  );

  const browser = session.browser;
  const context = session.context;

  let page = session.page;

  session.lastUsedAt = Date.now();

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

    const targetUrl = request.url;

    // فقط اگر page مرده بود
    if (page.isClosed()) {
      page = await context.newPage();

      session.page = page;
    }

    // --------------------
    // OPEN
    // --------------------

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

      await waitAfterAction(page);
    }

    // --------------------
    // CLICK
    // --------------------

    if (action === "click") {
      if (
        typeof request.x !== "number" ||
        typeof request.y !== "number"
      ) {
        throw new Error(
          "Missing click coordinates"
        );
      }

      const popupPromise = context
        .waitForEvent("page", {
          timeout: 5000
        })
        .catch(() => null);

      const navigationPromise = page
        .waitForNavigation({
          timeout: 5000,
          waitUntil: "domcontentloaded"
        })
        .catch(() => null);

      await page.mouse.move(
        request.x,
        request.y
      );

      await sleep(100);

      await page.mouse.down();

      await sleep(80);

      await page.mouse.up();

      const newPage = await Promise.race([
        popupPromise,
        sleep(2000).then(() => null)
      ]);

      if (newPage) {
        page = newPage;

        session.page = newPage;

        try {
          await page.waitForLoadState(
            "domcontentloaded",
            {
              timeout: 10000
            }
          );
        } catch (_) {}
      } else {
        await navigationPromise;
      }

      await waitAfterAction(page);
    }

    // --------------------
    // PASTE TEXT
    // --------------------

    if (action === "paste_text") {
      const text = request.text || "";

      const hasFocusedInput =
        await page.evaluate(() => {
          const el = document.activeElement;

          if (!el) {
            return false;
          }

          const tag =
            el.tagName.toLowerCase();

          return (
            tag === "input" ||
            tag === "textarea" ||
            el.isContentEditable
          );
        });

      if (!hasFocusedInput) {
        const input = page.locator(
          'input, textarea, [contenteditable="true"]'
        ).first();

        if (await input.count()) {
          await input.focus();

          await sleep(300);
        }
      }

      // پاک کردن مقدار قبلی
      await page.keyboard
        .press("Control+A")
        .catch(() => {});

      await page.keyboard
        .press("Backspace")
        .catch(() => {});

      await sleep(100);

      // تایپ واقعی
      await page.keyboard.type(text, {
        delay: 80
      });

      // اطمینان از sync شدن React state
      await page.evaluate(() => {
        const el = document.activeElement;

        if (
          el &&
          (
            el.tagName === "INPUT" ||
            el.tagName === "TEXTAREA"
          )
        ) {
          el.dispatchEvent(
            new Event("input", {
              bubbles: true
            })
          );

          el.dispatchEvent(
            new Event("change", {
              bubbles: true
            })
          );
        }
      });

      await waitAfterAction(page);
    }

    // --------------------
    // WAIT PAGE
    // --------------------

    const ready = await waitForPageReady(
      page,
      15000
    );

    if (!ready) {
      console.log(
        "Body not fully ready, continuing..."
      );
    }

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

    await sleep(1000);

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
      path: path.join(
        RESULT_DIR,
        `${id}.jpg`
      ),
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

  // browser.close() حذف شد
  // session باید زنده بماند

  fs.writeFileSync(
    path.join(
      RESULT_DIR,
      `${id}.json`
    ),
    JSON.stringify(result, null, 2)
  );

  cleanupResults(5);

  console.log(
    `Finished browser request: ${id}`
  );
}

async function main() {
  const fileName = process.argv[2];

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
