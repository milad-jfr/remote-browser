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

console.log("Video worker started");

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function detectStreamType(url) {

  if (!url) {
    return null;
  }

  const u = url.toLowerCase();

  if (u.includes(".m3u8")) {
    return "hls";
  }

  if (u.includes(".mpd")) {
    return "dash";
  }

  if (u.includes(".mp4")) {
    return "mp4";
  }

  if (u.startsWith("blob:")) {
    return "blob";
  }

  return "unknown";
}

async function processRequest(fileName) {

  const requestPath = path.join(REQUEST_DIR, fileName);

  const raw = fs.readFileSync(requestPath, "utf8");

  const request = JSON.parse(raw);

  const id = path.parse(fileName).name;

  console.log(`Processing video debug: ${id}`);

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
    isMobile: false
  });

  const page = await context.newPage();

  const mediaRequests = [];

  // =========================
  // NETWORK MONITOR
  // =========================

  page.on("request", req => {

    try {

      const reqUrl = req.url().toLowerCase();

      const type = req.resourceType();

      if (
        type === "media" ||
        reqUrl.includes(".mp4") ||
        reqUrl.includes(".m3u8") ||
        reqUrl.includes(".mpd") ||
        reqUrl.includes(".ts") ||
        reqUrl.includes("videoplayback") ||
        reqUrl.includes("segment") ||
        reqUrl.includes("playlist")
      ) {

        mediaRequests.push({
          type,
          method: req.method(),
          url: req.url()
        });

      }

    } catch {}

  });

  const result = {
    id,
    createdAt: Date.now(),

    pageUrl: null,
    title: null,

    videoDetected: false,

    videoUrl: null,

    streamType: null,

    videoDebug: null,

    mediaRequests: [],

    possibleVideos: [],

    error: null
  };

  try {

    if (!request.url) {
      throw new Error("Missing URL");
    }

    // =========================
    // OPEN PAGE
    // =========================

    await page.goto(request.url, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await sleep(5000);

    result.pageUrl = page.url();

    result.title = await page.title();

    // =========================
    // VIDEO ELEMENT DEBUG
    // =========================

    const videoDebug = await page.evaluate(() => {

      const videos = [
        ...document.querySelectorAll("video")
      ];

      return videos.map(v => ({
        currentSrc: v.currentSrc || null,

        src: v.src || null,

        poster: v.poster || null,

        readyState: v.readyState,

        networkState: v.networkState,

        sources: [
          ...v.querySelectorAll("source")
        ].map(s => s.src)
      }));

    });

    result.videoDebug = videoDebug;

    result.mediaRequests = mediaRequests;

    // =========================
    // COLLECT POSSIBLE VIDEOS
    // =========================

    const possibleVideos = [];

    for (const video of videoDebug) {

      if (
        video.currentSrc &&
        !video.currentSrc.startsWith("blob:")
      ) {

        possibleVideos.push(video.currentSrc);

      }

      if (
        video.src &&
        !video.src.startsWith("blob:")
      ) {

        possibleVideos.push(video.src);

      }

      if (video.sources?.length) {

        for (const s of video.sources) {

          if (
            s &&
            !s.startsWith("blob:")
          ) {

            possibleVideos.push(s);

          }

        }

      }

    }

    for (const req of mediaRequests) {

      if (req.url) {
        possibleVideos.push(req.url);
      }

    }

    // remove duplicates
    const uniqueVideos = [...new Set(possibleVideos)];

    result.possibleVideos = uniqueVideos;

    // =========================
    // PICK BEST VIDEO
    // =========================

    let bestVideo = null;

    bestVideo =
      uniqueVideos.find(v => v.includes(".m3u8")) ||

      uniqueVideos.find(v => v.includes(".mpd")) ||

      uniqueVideos.find(v => v.includes(".mp4")) ||

      uniqueVideos[0] ||

      null;

    if (bestVideo) {

      result.videoDetected = true;

      result.videoUrl = bestVideo;

      result.streamType = detectStreamType(bestVideo);

    }

  } catch (err) {

    result.error = err.message;

  }

  await browser.close();

  // =========================
  // SAVE RESULT
  // =========================

  fs.writeFileSync(
    path.join(RESULT_DIR, `${id}.video.json`),
    JSON.stringify(result, null, 2)
  );

  // =========================
  // PUSH RESULT
  // =========================

  execSync("git add result", {
    stdio: "ignore"
  });

  execSync(`git commit -m "video debug ${id}" || true`, {
    stdio: "ignore"
  });

  execSync("git push", {
    stdio: "ignore"
  });

  console.log(`Finished video debug: ${id}`);
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

      console.error("Video worker error:", err.message);

    }

    await sleep(5000);
  }
}

main();
