// dispatcher.js

import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const REQUEST_DIR = "./request";

// =========================
// SLEEP
// =========================

function sleep(ms) {

  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );

}

// =========================
// GIT PULL
// =========================

function gitPull() {

  try {

    execSync("git pull origin main", {
      stdio: "inherit"
    });

  } catch (err) {

    console.error("git pull failed:", err.message);

  }

}

// =========================
// PUSH RESULTS
// =========================

function gitSync() {

  try {

    execSync("git add .", {
      stdio: "inherit"
    });

    try {

      execSync(`git commit -m "update results"`, {
        stdio: "inherit"
      });

    } catch {

      console.log("nothing to commit");

    }

    execSync("git push origin main", {
      stdio: "inherit"
    });

  } catch (err) {

    console.error("git sync failed:", err.message);

  }

}

// =========================
// PROCESS REQUEST
// =========================

async function processRequest(file) {

  const requestPath =
    path.join(REQUEST_DIR, file);

  let request;

  try {

    request = JSON.parse(
      fs.readFileSync(
        requestPath,
        "utf8"
      )
    );

  } catch (err) {

    console.error(
      "invalid request:",
      file
    );

    return;
  }

  const type =
    request.type || "browser";

  console.log(
    `processing ${file} (${type})`
  );

  try {

    // =========================
    // RUN WORKER
    // =========================

    if (type === "video") {

      execSync(
        `node video.worker.js "${file}"`,
        {
          stdio: "inherit"
        }
      );

    } else {

      execSync(
        `node browser.worker.js "${file}"`,
        {
          stdio: "inherit"
        }
      );

    }

    // =========================
    // REMOVE REQUEST
    // =========================

    if (fs.existsSync(requestPath)) {

      fs.unlinkSync(requestPath);

    }

    // =========================
    // PUSH RESULTS
    // =========================

    gitSync();

    console.log(`done: ${file}`);

  } catch (err) {

    console.error(
      `worker failed for ${file}`
    );

    console.error(err.message);

  }

}

// =========================
// MAIN
// =========================

async function main() {

  try {

    const files = fs
      .readdirSync(REQUEST_DIR)
      .filter(f => f.endsWith(".json"))
      .sort();

    if (files.length === 0) {

      console.log("no requests");

      return;
    }

    for (const file of files) {

      await processRequest(file);

    }

  } catch (err) {

    console.error(
      "dispatcher error:",
      err.message
    );

  }

}

// =========================
// RUN FOREVER
// =========================

async function runForever() {

  console.log(
    "dispatcher started..."
  );

  while (true) {

    gitPull();

    await main();

    await sleep(2000);

  }

}

runForever();
