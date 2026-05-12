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
  } catch {
    return null;
  }
}

function writeJSON(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

function gitPush(message = "update") {
  try {
    execSync("git config user.name github-actions");
    execSync("git config user.email github-actions@github.com");

    execSync("git add state", {
      stdio: "ignore",
    });

    try {
      execSync(`git commit -m "${message}"`, {
        stdio: "ignore",
      });
    } catch {}

    execSync("git push", {
      stdio: "ignore",
    });
  } catch (err) {
    console.log("push failed");
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
      // IMPORTANT:
      // discard local changes
      // so git pull can work
      try {
        execSync("git reset --hard", {
          stdio: "ignore",
        });

        execSync("git pull", {
          stdio: "ignore",
        });
      } catch (err) {
        console.log("git sync failed");
      }

      const cmd = safeReadJSON(CMD);

      if (!cmd) {
        console.log("waiting for command...");
      } else if (cmd.id === lastCommandId) {
        console.log("already processed");
      } else {
        console.log("processing:", cmd);

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

        // pick
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

        // screenshot after action
        await page.screenshot({
          path: IMG,
          type: "jpeg",
          quality: 60,
        });

        // response
        writeJSON(RES, {
          ok: true,
          command: cmd,
          result,
          timestamp: Date.now(),
        });

        // mark command processed
        lastCommandId = cmd.id;

        writeJSON(CMD, {
          processed: true,
          id: cmd.id,
        });

        gitPush(`command ${cmd.type}`);

        console.log("done");
      }

      // always keep live image fresh
      await page.screenshot({
        path: IMG,
        type: "jpeg",
        quality: 60,
      });

      gitPush("live frame");
    } catch (err) {
      console.log("worker error:", err.message);
    }

    await sleep(2000);
  }
}

main().catch(console.error);
