import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { chromium } from "playwright";

const REQUEST_DIR = "./request";
const RESULT_DIR = "./result";

const OWNER = "milad-jfr";
const REPO = "remote-browser";
const BRANCH = "main";

if (!fs.existsSync(REQUEST_DIR)) fs.mkdirSync(REQUEST_DIR, { recursive: true });
if (!fs.existsSync(RESULT_DIR)) fs.mkdirSync(RESULT_DIR, { recursive: true });

function sanitize(name) {
  return (name || "video")
    .replace(/[<>:"/\\|?*]+/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

function buildDownloadUrl(file) {
  return `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/result/${file}`;
}

function chunkFile(filePath, chunkMB = 90) {
  const stat = fs.statSync(filePath);
  const max = chunkMB * 1024 * 1024;

  if (stat.size <= max) return [filePath];

  const buf = fs.readFileSync(filePath);
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);

  const parts = [];
  let offset = 0;
  let i = 1;

  while (offset < buf.length) {
    const slice = buf.slice(offset, offset + max);
    const name = `${base}.part${i}${ext}`;
    const p = path.join(dir, name);
    fs.writeFileSync(p, slice);
    parts.push(p);
    offset += max;
    i++;
  }

  fs.unlinkSync(filePath);
  return parts;
}

async function detectMainVideo(page, url) {
  const media = [];

  page.on("response", async (res) => {
    try {
      const u = res.url();
      const lower = u.toLowerCase();

      if (
        lower.includes(".m3u8") ||
        lower.includes(".mp4") ||
        lower.includes(".ts")
      ) {
        media.push({
          url: u,
          time: Date.now()
        });

        console.log("MEDIA:", u);
      }
    } catch {}
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(3000);

  try {
    const selectors = [
      "video",
      ".play",
      ".vjs-big-play-button",
      "[aria-label='Play']",
      ".jw-icon-playback"
    ];

    for (const s of selectors) {
      const el = await page.$(s);
      if (el) {
        console.log("Clicking:", s);
        await el.click({ force: true });
        break;
      }
    }
  } catch {}

  await page.waitForTimeout(10000);

  if (!media.length) throw new Error("No media detected");

  const filtered = media.filter((m) => {
    const u = m.url.toLowerCase();
    return !(
      u.includes("ads") ||
      u.includes("doubleclick") ||
      u.includes("promo") ||
      u.includes("advert")
    );
  });

  if (!filtered.length) throw new Error("Only ads detected");

  // priority detection
  let found =
    filtered.find((v) => v.url.includes("master.m3u8")) ||
    filtered.find((v) => v.url.includes("playlist.m3u8")) ||
    filtered.find((v) => v.url.includes(".m3u8")) ||
    filtered.find((v) => v.url.includes(".mp4")) ||
    filtered.find((v) => v.url.includes(".ts"));

  if (!found) throw new Error("No valid media");

  console.log("SELECTED MEDIA:", found.url);

  return found.url;
}

async function downloadFullVideo(mediaUrl, output) {
  const cmd = `
yt-dlp \
-f "best[height<=240][ext=mp4]/worst[height<=240]/worst" \
--merge-output-format mp4 \
--no-playlist \
-o "${output}" \
"${mediaUrl}"
`;

  console.log(cmd);
  execSync(cmd, { stdio: "inherit" });
}

async function processRequest(file) {
  const requestPath = path.join(REQUEST_DIR, file);
  const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  const id = path.parse(file).name;

  const result = {
    success: false,
    mediaUrl: null,
    downloads: [],
    error: null
  };

  let browser;

  try {
    if (!request.url) throw new Error("Missing URL");

    const tempDir = path.join(RESULT_DIR, `tmp_${id}`);
    fs.mkdirSync(tempDir, { recursive: true });

    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 720 }
    });

    const page = await ctx.newPage();

    const mediaUrl = await detectMainVideo(page, request.url);

    result.mediaUrl = mediaUrl;

    const out = path.join(tempDir, `${id}.%(ext)s`);

    await downloadFullVideo(mediaUrl, out);

    const files = fs.readdirSync(tempDir);
    if (!files.length) throw new Error("No output file");

    const downloaded = path.join(tempDir, files[0]);

    const finalName = `${id}-${sanitize(files[0])}`;
    const finalPath = path.join(RESULT_DIR, finalName);

    fs.renameSync(downloaded, finalPath);

    const chunks = chunkFile(finalPath, 90);

    for (const c of chunks) {
      const name = path.basename(c);
      result.downloads.push({
        file: name,
        url: buildDownloadUrl(name)
      });
    }

    result.success = true;

    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (err) {
    console.error(err);
    result.error = err.message;
  }

  if (browser) await browser.close();

  fs.writeFileSync(
    path.join(RESULT_DIR, `${id}.video.json`),
    JSON.stringify(result, null, 2)
  );

  console.log("Finished video request:", id);
}

async function main() {
  const file = process.argv[2];

  if (!file) {
    console.error("No request file");
    process.exit(1);
  }

  await processRequest(file);
}

main();
