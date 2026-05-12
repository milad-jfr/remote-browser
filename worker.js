import fetch from "node-fetch";
import dotenv from "dotenv";
import { chromium } from "playwright";

dotenv.config();

const {
  GITHUB_TOKEN,
  OWNER,
  REPO,
  BRANCH = "main"
} = process.env;

if (!GITHUB_TOKEN || !OWNER || !REPO) {
  console.error("Missing envs: GITHUB_TOKEN / OWNER / REPO");
  console.error({ GITHUB_TOKEN: !!GITHUB_TOKEN, OWNER, REPO, BRANCH });
  process.exit(1);
}

// مطابق ساختار جدید
const CMD_DIR = "commands";
const RES_DIR = "results";
const STATE_DIR = "state";

const apiBase = `https://api.github.com/repos/${OWNER}/${REPO}/contents`;

const defaultHeaders = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "Content-Type": "application/json"
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function listRepoFiles(dir) {
  const res = await fetch(`${apiBase}/${dir}?ref=${BRANCH}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json"
    }
  });

  if (res.status === 404) return [];

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`listRepoFiles failed ${dir}: ${res.status}\n${text}`);
  }

  const data = JSON.parse(text);
  return data
    .filter(item => item.type === "file")
    .map(item => item.name)
    .filter(name => name.endsWith(".json"));
}

async function getRepoJson(filePath) {
  const res = await fetch(`${apiBase}/${filePath}?ref=${BRANCH}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json"
    }
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`getRepoJson failed ${filePath}: ${res.status}\n${text}`);
  }

  const data = JSON.parse(text);
  const raw = Buffer.from(data.content, "base64").toString("utf8");
  return JSON.parse(raw);
}

async function putRepoFile(filePath, contentBufferOrString, message) {
  const content =
    typeof contentBufferOrString === "string"
      ? Buffer.from(contentBufferOrString).toString("base64")
      : Buffer.from(contentBufferOrString).toString("base64");

  const url = `${apiBase}/${filePath}`;

  // اگر فایل از قبل هست، sha را بگیریم که overwrite شود (نه error)
  let sha;
  const existing = await fetch(`${url}?ref=${BRANCH}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json"
    }
  });

  if (existing.ok) {
    const existingData = await existing.json();
    sha = existingData.sha;
  }

  const res = await fetch(url, {
    method: "PUT",
    headers: defaultHeaders,
    body: JSON.stringify({
      message,
      content,
      branch: BRANCH,
      ...(sha ? { sha } : {})
    })
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`putRepoFile failed ${filePath}: ${res.status}\n${text}`);
  }

  return JSON.parse(text);
}

async function resultExists(commandId) {
  const resPath = `${RES_DIR}/${commandId}.json`;
  const res = await fetch(`${apiBase}/${resPath}?ref=${BRANCH}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json"
    }
  });

  return res.ok;
}

// فقط navigate (فعلاً)
async function handleNavigate(page, cmd) {
  await page.goto(cmd.url, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  // یک کم صبر برای load بهتر
  await page.waitForTimeout(1500);

  const screenshot = await page.screenshot({
    fullPage: true
  });

  const statePath = `${STATE_DIR}/${cmd.id}.png`;
  await putRepoFile(statePath, screenshot, `screenshot ${cmd.id}`);

  const result = {
    id: cmd.id,
    ok: true,
    type: cmd.type,
    url: page.url(),
    title: await page.title(),
    screenshot: statePath,
    createdAt: new Date().toISOString()
  };

  const resultPath = `${RES_DIR}/${cmd.id}.json`;
  await putRepoFile(
    resultPath,
    JSON.stringify(result, null, 2),
    `result ${cmd.id}`
  );

  console.log(`done command ${cmd.id}`);
}

async function handleCommand(page, cmd) {
  console.log(`handling command ${cmd.id} type=${cmd.type}`);

  try {
    if (cmd.type === "navigate") {
      await handleNavigate(page, cmd);
      return;
    }

    // اگر type ناشناخته باشد
    const result = {
      id: cmd.id,
      ok: false,
      error: `Unsupported command type: ${cmd.type}`,
      createdAt: new Date().toISOString()
    };

    await putRepoFile(
      `${RES_DIR}/${cmd.id}.json`,
      JSON.stringify(result, null, 2),
      `result ${cmd.id}`
    );
  } catch (err) {
    const result = {
      id: cmd.id,
      ok: false,
      error: err?.message || String(err),
      stack: err?.stack || null,
      createdAt: new Date().toISOString()
    };

    try {
      await putRepoFile(
        `${RES_DIR}/${cmd.id}.json`,
        JSON.stringify(result, null, 2),
        `result ${cmd.id}`
      );
    } catch (writeErr) {
      console.error("failed to write error result", writeErr);
    }

    console.error(`command ${cmd.id} failed`, err);
  }
}

async function main() {
  console.log("launching chromium...");

  const browser = await chromium.launch({
    headless: true
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }
  });

  const page = await context.newPage();

  console.log("worker started");
  console.log(`repo=${OWNER}/${REPO} branch=${BRANCH}`);
  console.log(`CMD_DIR=${CMD_DIR} RES_DIR=${RES_DIR} STATE_DIR=${STATE_DIR}`);

  while (true) {
    try {
      const files = await listRepoFiles(CMD_DIR);

      // sort بر اساس id عددی (نام فایل: <id>.json)
      files.sort((a, b) => {
        const na = Number(a.replace(".json", ""));
        const nb = Number(b.replace(".json", ""));
        return na - nb;
      });

      for (const file of files) {
        const cmdPath = `${CMD_DIR}/${file}`;
        const cmd = await getRepoJson(cmdPath);

        const alreadyDone = await resultExists(cmd.id);
        if (alreadyDone) {
          continue;
        }

        await handleCommand(page, cmd);
      }
    } catch (err) {
      console.error("worker loop error:", err?.stack || err);
    }

    await sleep(3000);
  }
}

main().catch(err => {
  console.error("fatal worker error:", err?.stack || err);
  process.exit(1);
});

