const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const REQUEST_DIR = "./request";
const RESULT_DIR = "./result";
const SESSIONS_DIR = "./sessions";

if (!fs.existsSync(REQUEST_DIR)) {
  fs.mkdirSync(REQUEST_DIR, { recursive: true });
}

if (!fs.existsSync(RESULT_DIR)) {
  fs.mkdirSync(RESULT_DIR, { recursive: true });
}

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

const sessions = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPageReady(page) {
  try {
    await page.waitForLoadState("domcontentloaded", {
      timeout: 15000,
    });
  } catch (_) {}

  try {
    await page.waitForFunction(() => {
      return !!document.body;
    }, {
      timeout: 10000,
    });
  } catch (_) {}

  await page.waitForTimeout(1000);
}

async function autoScroll(page) {
  try {
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 500;

        const timer = setInterval(() => {
          window.scrollBy(0, distance);

          totalHeight += distance;

          if (
            totalHeight >=
            document.body.scrollHeight
          ) {
            clearInterval(timer);

            window.scrollTo(0, 0);

            resolve();
          }
        }, 100);
      });
    });
  } catch (err) {
    console.error("Auto scroll error:", err);
  }
}

async function getOrCreateSession(sessionId) {
  if (sessions.has(sessionId)) {
    const existing = sessions.get(sessionId);

    try {
      if (!existing.page.isClosed()) {
        existing.lastUsed = Date.now();
        return existing;
      }
    } catch (_) {}
  }

  const sessionPath = path.join(
    SESSIONS_DIR,
    sessionId
  );

  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, {
      recursive: true,
    });
  }

  const statePath = path.join(
    sessionPath,
    "state.json"
  );

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  let context;

  if (fs.existsSync(statePath)) {
    context = await browser.newContext({
      storageState: statePath,
      viewport: {
        width: 1920,
        height: 1080,
      },
      deviceScaleFactor: 1,
      isMobile: false,
    });
  } else {
    context = await browser.newContext({
      viewport: {
        width: 1920,
        height: 1080,
      },
      deviceScaleFactor: 1,
      isMobile: false,
    });
  }

  const page = await context.newPage();

  const session = {
    browser,
    context,
    page,
    statePath,
    lastUsed: Date.now(),
  };

  sessions.set(sessionId, session);

  return session;
}

async function naturalClick(page, x, y) {
  const offsetX =
    x + Math.floor(Math.random() * 4) - 2;

  const offsetY =
    y + Math.floor(Math.random() * 4) - 2;

  await page.mouse.move(offsetX, offsetY, {
    steps: 12,
  });

  await page.waitForTimeout(
    30 + Math.random() * 120
  );

  await page.mouse.down();

  await page.waitForTimeout(
    50 + Math.random() * 120
  );

  await page.mouse.up();
}

async function saveResult(id, result) {
  const resultPath = path.join(
    RESULT_DIR,
    `${id}.json`
  );

  fs.writeFileSync(
    resultPath,
    JSON.stringify(result, null, 2)
  );
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

  const id = path.basename(
    fileName,
    ".json"
  );

  const sessionId =
    request.sessionId || "default";

  console.log(
    `[worker] processing ${id} (${request.action})`
  );

  let session;

  try {
    session = await getOrCreateSession(
      sessionId
    );

    const {
      page,
      context,
      statePath,
    } = session;

    const result = {
      id,
      sessionId,
      status: "success",
      title: "",
      url: "",
      screenshot: `${id}.jpg`,
      error: null,
      createdAt: new Date().toISOString(),
    };

    if (request.action === "open") {
      if (!request.url) {
        throw new Error("Missing URL");
      }

      await page.goto(request.url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      await waitForPageReady(page);
    }

    else if (request.action === "click") {
      if (
        typeof request.x !== "number" ||
        typeof request.y !== "number"
      ) {
        throw new Error(
          "Invalid click coordinates"
        );
      }

      await waitForPageReady(page);

      await naturalClick(
        page,
        request.x,
        request.y
      );

      await Promise.race([
        page.waitForLoadState("networkidle", {
          timeout: 7000,
        }).catch(() => {}),

        page.waitForTimeout(2500),
      ]);

      await waitForPageReady(page);
    }

    await autoScroll(page);

    try {
      result.title = await page.title();
    } catch (_) {
      result.title = "";
    }

    try {
      result.url = page.url();
    } catch (_) {
      result.url = request.url || "";
    }

    const screenshotPath = path.join(
      RESULT_DIR,
      `${id}.jpg`
    );

    await page.screenshot({
      path: screenshotPath,
      type: "jpeg",
      quality: 60,
      fullPage: true,
    });

    await context.storageState({
      path: statePath,
    });

    await saveResult(id, result);

    console.log(
      `[worker] completed ${id}`
    );
  } catch (err) {
    console.error(err);

    const errorResult = {
      id,
      sessionId,
      status: "error",
      title: "",
      url: request.url || "",
      screenshot: null,
      error: err.message,
      createdAt: new Date().toISOString(),
    };

    await saveResult(id, errorResult);
  } finally {
    try {
      fs.unlinkSync(requestPath);
    } catch (_) {}
  }
}

async function cleanupOldSessions() {
  const now = Date.now();

  for (const [sessionId, session] of sessions) {
    const inactiveFor =
      now - session.lastUsed;

    if (inactiveFor > 1000 * 60 * 30) {
      try {
        await session.page.close();
      } catch (_) {}

      try {
        await session.context.close();
      } catch (_) {}

      try {
        await session.browser.close();
      } catch (_) {}

      sessions.delete(sessionId);

      console.log(
        `[worker] cleaned session ${sessionId}`
      );
    }
  }
}

async function workerLoop() {
  console.log("[worker] started");

  while (true) {
    try {
      const files = fs
        .readdirSync(REQUEST_DIR)
        .filter((f) => f.endsWith(".json"));

      for (const file of files) {
        try {
          await processRequest(file);
        } catch (err) {
          console.error(
            `[worker] failed ${file}`,
            err
          );
        }
      }

      await cleanupOldSessions();
    } catch (err) {
      console.error(
        "[worker] loop error",
        err
      );
    }

    await sleep(1000);
  }
}

workerLoop();
