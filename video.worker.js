import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const REQUEST_DIR = "./request";
const RESULT_DIR = "./result";

if (!fs.existsSync(REQUEST_DIR)) {
  fs.mkdirSync(REQUEST_DIR, { recursive: true });
}

if (!fs.existsSync(RESULT_DIR)) {
  fs.mkdirSync(RESULT_DIR, { recursive: true });
}

const OWNER = "milad-jfr";
const REPO = "remote-browser";
const BRANCH = "main";

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
    title: null,
    downloads: [],
    error: null
  };

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

    const outputTemplate =
      path.join(
        tempDir,
        `${id}.%(ext)s`
      );

    // دانلود اجباری کیفیت پایین
    const cmd = `
yt-dlp \
-f "best[height<=240][ext=mp4]/worst[height<=240]/worst" \
--merge-output-format mp4 \
--no-playlist \
-o "${outputTemplate}" \
"${request.url}"
`;

    console.log("Running yt-dlp...");
    console.log(cmd);

    execSync(cmd, {
      stdio: "inherit"
    });

    const files =
      fs.readdirSync(tempDir);

    if (!files.length) {

      throw new Error("Download failed");

    }

    const downloadedFile =
      path.join(tempDir, files[0]);

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

    result.error = err.message;

  }

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
