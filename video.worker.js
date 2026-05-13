import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { chromium } from "playwright";

const REQUEST_DIR = "./request";
const RESULT_DIR = "./result";

const OWNER = "milad-jfr";
const REPO = "remote-browser";
const BRANCH = "main";

if (!fs.existsSync(REQUEST_DIR)) {
  fs.mkdirSync(REQUEST_DIR, { recursive: true });
}

if (!fs.existsSync(RESULT_DIR)) {
  fs.mkdirSync(RESULT_DIR, { recursive: true });
}

function sanitize(name) {

  return (name || "video")
    .replace(/[<>:"/\\|?*]+/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 80);

}

function buildDownloadUrl(fileName) {

  return `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/result/${fileName}`;

}

function chunkFile(filePath, chunkSizeMB = 90) {

  const stats = fs.statSync(filePath);

  const maxSize =
    chunkSizeMB * 1024 * 1024;

  if (stats.size <= maxSize) {

    return [filePath];

  }

  const buffer =
    fs.readFileSync(filePath);

  const dir =
    path.dirname(filePath);

  const ext =
    path.extname(filePath);

  const base =
    path.basename(filePath, ext);

  const chunks = [];

  let offset = 0;
  let index = 1;

  while (offset < buffer.length) {

    const chunk =
      buffer.slice(offset, offset + maxSize);

    const chunkName =
      `${base}.part${index}${ext}`;

    const chunkPath =
      path.join(dir, chunkName);

    fs.writeFileSync(chunkPath, chunk);

    chunks.push(chunkPath);

    offset += maxSize;
    index++;

  }

  fs.unlinkSync(filePath);

  return chunks;

}

async function detectMainVideo(page, pageUrl) {

  const mediaRequests = [];

  page.on("response", async (response) => {

    try {

      const url =
        response.url();

      const lower =
        url.toLowerCase();

      const isMedia =
        lower.includes(".m3u8") ||
        lower.includes(".mp4") ||
        lower.includes(".ts") ||
        lower.includes("playlist") ||
        lower.includes("master.m3u8") ||
        lower.includes("video");

      if (!isMedia) {
        return;
      }

      const headers =
        response.headers();

      const contentType =
        headers["content-type"] || "";

      if (
        contentType.includes("video") ||
        lower.includes(".m3u8") ||
        lower.includes(".mp4") ||
        lower.includes(".ts")
      ) {

        mediaRequests.push({
          url,
          time: Date.now()
        });

        console.log("MEDIA:", url);

      }

    } catch (err) {

      console.log(err.message);

    }

  });

  await page.goto(pageUrl, {
    waitUntil: "domcontentloaded",
    timeout: 120000
  });

  await page.waitForTimeout(3000);

  try {

    const playSelectors = [
      "video",
      ".play",
      ".playButton",
      ".vjs-big-play-button",
      "[aria-label='Play']",
      ".jw-icon-playback"
    ];

    for (const selector of playSelectors) {

      const el =
        await page.$(selector);

      if (el) {

        console.log("Clicking:", selector);

        await el.click({
          force: true
        });

        break;

      }

    }

  } catch (err) {

    console.log(
      "Play click failed:",
      err.message
    );

  }

  await page.waitForTimeout(10000);

  if (!mediaRequests.length) {

    throw new Error(
      "No media streams detected"
    );

  }

  // حذف تبلیغات احتمالی
  const filtered =
    mediaRequests.filter((item) => {

      const url =
        item.url.toLowerCase();

      if (
        url.includes("ads") ||
        url.includes("doubleclick") ||
        url.includes("vast") ||
        url.includes("promo") ||
        url.includes("advert")
      ) {

        return false;

      }

      return true;

    });

  if (!filtered.length) {

    throw new Error(
      "Only ad streams detected"
    );

  }

  // آخرین stream معمولا ویدئوی اصلی است
  const selected =
    filtered[filtered.length - 1];

  console.log(
    "SELECTED MEDIA:",
    selected.url
  );

  return selected.url;

}

async function downloadFullVideo(mediaUrl, outputTemplate) {

  const cmd = `
yt-dlp \
-f "best[height<=240][ext=mp4]/worst[height<=240]/worst" \
--merge-output-format mp4 \
--no-playlist \
-o "${outputTemplate}" \
"${mediaUrl}"
`;

  console.log(cmd);

  execSync(cmd, {
    stdio: "inherit"
  });

}

async function processRequest(fileName) {

  const requestPath =
    path.join(REQUEST_DIR, fileName);

  const request =
    JSON.parse(
      fs.readFileSync(requestPath, "utf8")
    );

  const id =
    path.parse(fileName).name;

  const result = {
    success: false,
    mediaUrl: null,
    downloads: [],
    error: null
  };

  let browser;

  try {

    if (!request.url) {

      throw new Error("Missing URL");

    }

    const tempDir =
      path.join(
        RESULT_DIR,
        `tmp_${id}`
      );

    fs.mkdirSync(tempDir, {
      recursive: true
    });

    browser =
      await chromium.launch({
        headless: true
      });

    const context =
      await browser.newContext({
        viewport: {
          width: 1280,
          height: 720
        }
      });

    const page =
      await context.newPage();

    // مخصوص beeg
    if (
      request.url.includes("beeg.com")
    ) {

      await page.goto(request.url, {
        waitUntil: "domcontentloaded",
        timeout: 120000
      });

      await page.waitForTimeout(5000);

    }

    const mediaUrl =
      await detectMainVideo(
        page,
        request.url
      );

    result.mediaUrl =
      mediaUrl;

    const outputTemplate =
      path.join(
        tempDir,
        `${id}.%(ext)s`
      );

    // دانلود کامل ویدئو
    await downloadFullVideo(
      mediaUrl,
      outputTemplate
    );

    const files =
      fs.readdirSync(tempDir);

    if (!files.length) {

      throw new Error(
        "No output files"
      );

    }

    const downloadedFile =
      path.join(
        tempDir,
        files[0]
      );

    const finalName =
      `${id}-${sanitize(files[0])}`;

    const finalPath =
      path.join(
        RESULT_DIR,
        finalName
      );

    fs.renameSync(
      downloadedFile,
      finalPath
    );

    // تقسیم به chunk های 90MB
    const chunks =
      chunkFile(finalPath, 90);

    for (const chunk of chunks) {

      const name =
        path.basename(chunk);

      result.downloads.push({
        file: name,
        url: buildDownloadUrl(name)
      });

    }

    result.success = true;

    fs.rmSync(tempDir, {
      recursive: true,
      force: true
    });

  } catch (err) {

    console.error(err);

    result.error =
      err.message;

  }

  try {

    if (browser) {
      await browser.close();
    }

  } catch {}

  fs.writeFileSync(
    path.join(
      RESULT_DIR,
      `${id}.video.json`
    ),
    JSON.stringify(result, null, 2)
  );

  console.log(
    `Finished video request: ${id}`
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
      "Video worker failed:",
      err.message
    );

    process.exit(1);

  }

}

main();
