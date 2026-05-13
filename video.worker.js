import fs from "fs";
import path from "path";
import { chromium } from "playwright";

const REQUEST_DIR = "./request";
const RESULT_DIR = "./result";

if (!fs.existsSync(REQUEST_DIR)) {
  fs.mkdirSync(REQUEST_DIR, { recursive: true });
}

if (!fs.existsSync(RESULT_DIR)) {
  fs.mkdirSync(RESULT_DIR, { recursive: true });
}

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

function isYoutube(url) {

  if (!url) {
    return false;
  }

  return (
    url.includes("youtube.com") ||
    url.includes("youtu.be")
  );
}

function isPornhub(url) {

  if (!url) {
    return false;
  }

  return url.includes("pornhub.com");
}

function uniqueVideos(videos) {

  const map = new Map();

  for (const video of videos) {

    if (!video?.url) {
      continue;
    }

    if (!map.has(video.url)) {
      map.set(video.url, video);
    }

  }

  return [...map.values()];
}

async function safeGoto(page, url) {

  try {

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 90000
    });

  } catch (err) {

    console.log("Primary goto failed:", err.message);

    await page.goto(url, {
      waitUntil: "load",
      timeout: 90000
    });

  }

}

async function extractYoutube(page) {

  try {

    const data = await page.evaluate(() => {

      const result = {
        title: null,
        formats: []
      };

      const player =
        window.ytInitialPlayerResponse ||
        null;

      if (!player) {
        return null;
      }

      result.title =
        player?.videoDetails?.title ||
        document.title ||
        null;

      const streams = [
        ...(player?.streamingData?.formats || []),
        ...(player?.streamingData?.adaptiveFormats || [])
      ];

      for (const stream of streams) {

        const video = {
          url: null,
          mimeType: stream.mimeType || null,
          quality:
            stream.qualityLabel ||
            stream.quality ||
            null,
          bitrate: stream.bitrate || null,
          hasAudio:
            !!stream.audioQuality,
          hasVideo:
            !!stream.qualityLabel
        };

        // direct usable URL
        if (stream.url) {
          video.url = stream.url;
        }

        // ciphered URL (cannot fully decode without yt-dlp style logic)
        if (!video.url && stream.signatureCipher) {

          try {

            const params = new URLSearchParams(
              stream.signatureCipher
            );

            const cipherUrl = params.get("url");

            if (cipherUrl) {
              video.url = cipherUrl;
            }

          } catch {}

        }

        if (video.url) {
          result.formats.push(video);
        }

      }

      return result;

    });

    return data;

  } catch (err) {

    console.log("YouTube extractor failed:", err.message);

    return null;

  }

}

async function extractPornhub(page) {

  try {

    const data = await page.evaluate(() => {

      const result = {
        title: document.title || null,
        formats: []
      };

      const scripts = [
        ...document.querySelectorAll("script")
      ];

      for (const script of scripts) {

        const text = script.innerText;

        if (
          !text.includes("flashvars") &&
          !text.includes("mediaDefinitions")
        ) {
          continue;
        }

        // -------------------------
        // Try mediaDefinitions JSON
        // -------------------------

        try {

          const mediaMatch =
            text.match(
              /"mediaDefinitions":(\[[\s\S]*?\])/i
            );

          if (mediaMatch) {

            const defs = JSON.parse(
              mediaMatch[1]
            );

            for (const item of defs) {

              if (!item.videoUrl) {
                continue;
              }

              result.formats.push({
                url: item.videoUrl,
                quality: item.quality || null,
                format: item.format || null
              });

            }

          }

        } catch {}

        // -------------------------
        // flashvars parser
        // -------------------------

        try {

          const flashvarsMatch =
            text.match(
              /flashvars_\d+\s*=\s*(\{[\s\S]*?\});/
            );

          if (flashvarsMatch) {

            const json = JSON.parse(
              flashvarsMatch[1]
            );

            if (json.mediaDefinitions) {

              for (const item of json.mediaDefinitions) {

                if (!item.videoUrl) {
                  continue;
                }

                result.formats.push({
                  url: item.videoUrl,
                  quality: item.quality || null,
                  format: item.format || null
                });

              }

            }

          }

        } catch {}

      }

      return result;

    });

    return data;

  } catch (err) {

    console.log("Pornhub extractor failed:", err.message);

    return null;

  }

}

async function extractGenericVideos(page) {

  try {

    const data = await page.evaluate(() => {

      const videos = [
        ...document.querySelectorAll("video")
      ];

      const results = [];

      for (const v of videos) {

        if (
          v.currentSrc &&
          !v.currentSrc.startsWith("blob:")
        ) {

          results.push({
            url: v.currentSrc
          });

        }

        if (
          v.src &&
          !v.src.startsWith("blob:")
        ) {

          results.push({
            url: v.src
          });

        }

        const sources = [
          ...v.querySelectorAll("source")
        ];

        for (const s of sources) {

          if (
            s.src &&
            !s.src.startsWith("blob:")
          ) {

            results.push({
              url: s.src
            });

          }

        }

      }

      return results;

    });

    return data || [];

  } catch {

    return [];

  }

}

async function processRequest(fileName) {

  const requestPath =
    path.join(REQUEST_DIR, fileName);

  const raw =
    fs.readFileSync(requestPath, "utf8");

  const request = JSON.parse(raw);

  const id =
    path.parse(fileName).name;

  console.log(`Processing video request: ${id}`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ]
  });

  const context =
    await browser.newContext({
      viewport: {
        width: 1920,
        height: 1080
      },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    });

  const page = await context.newPage();

  const mediaRequests = [];

  // ===================================
  // NETWORK MONITOR
  // ===================================

  page.on("request", req => {

    try {

      const reqUrl =
        req.url().toLowerCase();

      const type =
        req.resourceType();

      if (

        type === "media" ||

        reqUrl.includes(".mp4") ||
        reqUrl.includes(".m3u8") ||
        reqUrl.includes(".mpd") ||
        reqUrl.includes(".ts") ||

        reqUrl.includes("videoplayback") ||
        reqUrl.includes("playlist") ||
        reqUrl.includes("segment") ||
        reqUrl.includes("manifest")

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

    siteType: "generic",

    videoDetected: false,

    videos: [],

    mediaRequests: [],

    error: null
  };

  try {

    if (!request.url) {
      throw new Error("Missing URL");
    }

    // ===================================
    // OPEN PAGE
    // ===================================

    await safeGoto(page, request.url);

    await sleep(6000);

    result.pageUrl = page.url();

    try {
      result.title = await page.title();
    } catch {}

    // ===================================
    // SITE DETECTION
    // ===================================

    let extracted = null;

    // ===================================
    // YOUTUBE
    // ===================================

    if (isYoutube(result.pageUrl)) {

      result.siteType = "youtube";

      console.log("Using YouTube extractor");

      extracted =
        await extractYoutube(page);

    }

    // ===================================
    // PORNHUB
    // ===================================

    else if (isPornhub(result.pageUrl)) {

      result.siteType = "pornhub";

      console.log("Using Pornhub extractor");

      extracted =
        await extractPornhub(page);

    }

    // ===================================
    // EXTRACTED FORMATS
    // ===================================

    if (
      extracted &&
      extracted.formats &&
      extracted.formats.length
    ) {

      for (const item of extracted.formats) {

        if (!item.url) {
          continue;
        }

        result.videos.push({

          url: item.url,

          quality:
            item.quality || null,

          mimeType:
            item.mimeType || null,

          bitrate:
            item.bitrate || null,

          hasAudio:
            item.hasAudio || false,

          hasVideo:
            item.hasVideo || false,

          streamType:
            detectStreamType(item.url)

        });

      }

    }

    // ===================================
    // GENERIC VIDEO DETECTION
    // ===================================

    const genericVideos =
      await extractGenericVideos(page);

    for (const item of genericVideos) {

      result.videos.push({

        url: item.url,

        quality: null,

        mimeType: null,

        bitrate: null,

        streamType:
          detectStreamType(item.url)

      });

    }

    // ===================================
    // NETWORK FALLBACK
    // ===================================

    for (const req of mediaRequests) {

      result.videos.push({

        url: req.url,

        quality: null,

        mimeType: null,

        bitrate: null,

        streamType:
          detectStreamType(req.url)

      });

    }

    // ===================================
    // CLEANUP
    // ===================================

    result.mediaRequests = mediaRequests;

    result.videos =
      uniqueVideos(result.videos);

    result.videoDetected =
      result.videos.length > 0;

  } catch (err) {

    result.error = err.message;

  }

  await browser.close();

  // ===================================
  // SAVE RESULT
  // ===================================

  fs.writeFileSync(
    path.join(
      RESULT_DIR,
      `${id}.video.json`
    ),
    JSON.stringify(result, null, 2)
  );

  console.log(`Finished video request: ${id}`);
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
      "Video worker failed:",
      err.message
    );

    process.exit(1);
  }

}

main();
