import fs from "fs";
import { execSync } from "child_process";
import { chromium } from "playwright";

const CMD = "state/command.json";
const RES = "state/response.json";
const IMG = "state/live.jpg";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeReadJSON(path) {
  try {
    if (!fs.existsSync(path)) return null;

    const raw = fs.readFileSync(path, "utf8").trim();

    if (!raw) return null;

    return JSON.parse(raw);
  } catch (err) {
    console.log("invalid json ignored");
    return null;
  }
}

function writeJSON(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

function gitPush(message = "update state") {
  try {
    execSync("git config user.name github-actions");
    execSync("git config user.email github-actions@github.com");

    execSync("git add state", { stdio: "ignore" });

    try {
      execSync(`git commit -m "${message}"`, { stdio: "ignore" });
    } catch {}

    execSync("git pull --rebase", { stdio: "ignore" });
    execSync("git push", { stdio: "ignore" });
  } catch (err) {
    console.log("git push failed");
  }
}

async function main() {
  console.log("worker started");

  const browser = await chromium.launch({
    headless: true,
  });

  const page = await browser.newPage({
    viewport: {
      width: 1280,
      height: 720,
    },
  });

  await page.goto("https://example.com");

  let lastCommandId = null;

  while (true) {
    try {
      // live frame
      await page.screenshot({
        path: IMG,
        type: "jpeg",
        quality: 60,
      });

      const cmd = safeReadJSON(CMD);

      // no command
      if (!cmd) {
        await sleep(1000);
        continue;
      }

      // already processed
      if (cmd.id && cmd.id === lastCommandId) {
        await sleep(500);
        continue;
      }

      console.log("command:", cmd);

      let result = {
        ok: true,
      };

      // navigate
      if (cmd.type === "navigate") {
        await page.goto(cmd.url, {
          waitUntil: "domcontentloaded",
        });

        result.url = page.url();
      }

      // click
      if (cmd.type === "click") {
        await page.mouse.click(cmd.x, cmd.y);

        result.clicked = {
          x: cmd.x,
          y: cmd.y,
        };
      }

      // hover
      if (cmd.type === "hover") {
        await page.mouse.move(cmd.x, cmd.y);

        result.hovered = {
          x: cmd.x,
          y: cmd.y,
        };
      }

      // type
      if (cmd.type === "type") {
        await page.keyboard.type(cmd.text || "");

        result.typed = cmd.text || "";
      }

      // keypress
      if (cmd.type === "keypress") {
        await page.keyboard.press(cmd.key);

        result.key = cmd.key;
      }

      // pick element
      if (cmd.type === "pick") {
        const data = await page.evaluate(
          ({ x, y }) => {
            const el = document.elementFromPoint(x, y);

            if (!el) return null;

            return {
              tag: el.tagName,
              text: (el.innerText || "").slice(0, 200),
              id: el.id,
              class: el.className,
            };
          },
          {
            x: cmd.x,
            y: cmd.y,
          }
        );

        result.element = data;
      }

      // fresh screenshot after action
      await page.screenshot({
        path: IMG,
        type: "jpeg",
        quality: 60,
      });

      writeJSON(RES, {
        command: cmd,
        result,
        timestamp: Date.now(),
      });

      // mark processed
      writeJSON(CMD, {
        processed: true,
        id: cmd.id || null,
      });

      lastCommandId = cmd.id || null;

      gitPush(`command ${cmd.type}`);
    } catch (err) {
      console.log("worker loop error:", err.message);

      try {
        writeJSON(RES, {
          ok: false,
          error: err.message,
          timestamp: Date.now(),
        });

        gitPush("worker error");
      } catch {}
    }

    await sleep(1000);
  }
}

main().catch(console.error);
