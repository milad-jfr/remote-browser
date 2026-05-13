import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import puppeteer from "puppeteer";

const TEMP_DIR = "/tmp/video-worker";

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function uniqueVideos(arr) {
  const seen = new Set();

  return arr.filter((v) => {
    if (!v?.url) return false;

    if (seen.has(v.url)) return false;

    seen.add(v.url);

    return true;
  });
}

function isValidMediaUrl(url) {
  if (!url) return false;

  const u = url.toLowerCase();

  return (
    u.includes(".mp4") ||
    u.includes(".m3u8") ||
    u.includes(".mpd") ||
    u.includes("videoplayback")
  );
}

function parseHeight(label = "") {
  const m = label.match(/(\d{3,4})p/i);

  if (!m) return 9999;

  return Number(m[1]);
}

function pickBest240(videos) {
  if (!videos?.length) return null;

  const sorted = [...videos].sort((a, b) => {
    return parseHeight(a.quality || "") - parseHeight(b.quality || "");
  });

  const exact240 = sorted.find((v) =>
    (v.quality || "").includes("240")
  );

  if (exact240) return exact240;

  return sorted[0];
}

async function safeGoto(page, url) {
  try {
    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });
  } catch {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
  }
}

async function extractMedia(url) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  const page = await browser.newPage();

  const mediaRequests = [];
  const resultVideos = [];

  page.on("request", (req) => {
    try {
      const reqUrl = req.url();

      if (isValidMediaUrl(reqUrl)) {
        mediaRequests.push(reqUrl);
      }
    } catch {}
  });

  page.on("response", async (res) => {
    try {
      const resUrl = res.url().toLowerCase();

      if (isValidMediaUrl(resUrl)) {
        mediaRequests.push(resUrl);
        return;
      }

      const ct = res.headers()["content-type"] || "";

      if (ct.includes("application/json")) {
        const text = await res.text();

        const matches = text.match(
          /https?:\/\/[^"' ]+\.(mp4|m3u8|mpd)[^"' ]*/gi
        );

        if (matches?.length) {
          mediaRequests.push(...matches);
        }
      }
    } catch {}
  });

  await safeGoto(page, url);

  try {
    await page.click("video");
  } catch {}

  try {
    await page.evaluate(() => {
      const v = document.querySelector("video");

      if (v) {
        v.muted = true;

        v.play().catch(() => {});
      }
    });
  } catch {}

  await sleep(8000);

  try {
    const html = await page.content();

    const regex =
      /https?:\/\/[^"' ]+\.(mp4|m3u8|mpd)[^"' ]*/gi;

    const matches = html.match(regex);

    if (matches?.length) {
      mediaRequests.push(...matches);
    }
  } catch {}

  const clean = uniqueVideos(
    mediaRequests.map((u) => ({
      url: u,
      quality:
        u.match(/(\d{3,4})p/i)?.[1] + "p" || "unknown",
    }))
  ).filter((v) => isValidMediaUrl(v.url));

  resultVideos.push(...clean);

  await browser.close();

  return resultVideos;
}

function run(cmd) {
  console.log(cmd);

  execSync(cmd, {
    stdio: "inherit",
  });
}

async function downloadWithFFmpeg(inputUrl) {
  const videos = await extractMedia(inputUrl);

  if (!videos.length) {
    throw new Error("No valid media streams found");
  }

  const chosen = pickBest240(videos);

  if (!chosen?.url) {
    throw new Error("No downloadable stream selected");
  }

  console.log("Chosen stream:", chosen);

  const output = path.join(
    TEMP_DIR,
    `video_${Date.now()}.mp4`
  );

  const cmdCopy = `
ffmpeg
-y
-i "${chosen.url}"
-c copy
-bsfs:a aac_adtstoasc
"${output}"
`;

  try {
    run(cmdCopy);
  } catch {
    const cmdEncode = `
ffmpeg
-y
-i "${chosen.url}"
-c:v libx264
-c:a aac
-preset veryfast
-crf 28
"${output}"
`;

    run(cmdEncode);
  }

  if (!fs.existsSync(output)) {
    throw new Error("FFmpeg failed to create output");
  }

  return output;
}

async function chunkIfNeeded(filePath) {
  const MAX = 90 * 1024 * 1024;

  const stat = fs.statSync(filePath);

  if (stat.size <= MAX) {
    return [filePath];
  }

  const outDir = path.join(
    TEMP_DIR,
    `chunks_${Date.now()}`
  );

  fs.mkdirSync(outDir, { recursive: true });

  const segmentPattern = path.join(
    outDir,
    "part_%03d.mp4"
  );

  const cmd = `
ffmpeg
-y
-i "${filePath}"
-c copy
-map 0
-f segment
-segment_time 300
-reset_timestamps 1
"${segmentPattern}"
`;

  run(cmd);

  return fs
    .readdirSync(outDir)
    .filter((f) => f.endsWith(".mp4"))
    .map((f) => path.join(outDir, f));
}

export async function handler(job) {
  try {
    const inputUrl = job?.data?.url;

    if (!inputUrl) {
      throw new Error("Missing URL");
    }

    console.log("Processing:", inputUrl);

    const downloaded = await downloadWithFFmpeg(
      inputUrl
    );

    const files = await chunkIfNeeded(downloaded);

    return {
      success: true,
      originalUrl: inputUrl,
      files: files.map((f) => ({
        path: f,
        size: fs.statSync(f).size,
        name: path.basename(f),
      })),
    };
  } catch (err) {
    console.error(err);

    return {
      success: false,
      error: err.message,
    };
  }
}
