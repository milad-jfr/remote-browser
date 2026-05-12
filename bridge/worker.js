import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { execSync } from "child_process";

const CMD_DIR = "bridge/commands";
const RES_DIR = "bridge/results";

async function main() {
  if (!fs.existsSync(CMD_DIR)) fs.mkdirSync(CMD_DIR, { recursive: true });
  if (!fs.existsSync(RES_DIR)) fs.mkdirSync(RES_DIR, { recursive: true });

  console.log("🚀 Worker started…");

  const browser = await chromium.launch();
  const page = await browser.newPage();

  while (true) {
    const cmds = fs.readdirSync(CMD_DIR)
      .filter(f => f.endsWith(".json"))
      .sort();

    if (cmds.length === 0) {
      console.log("⏳ No commands…");
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }

    const file = cmds[0];
    const full = path.join(CMD_DIR, file);
    const data = JSON.parse(fs.readFileSync(full, "utf8"));

    console.log("⚡ Running:", file, data.type);

    if (data.type === "navigate") {
      await page.goto(data.url);
    }

    // simple screenshot output
    const shotName = `frame_${Date.now()}.jpg`;
    await page.screenshot({ path: `${RES_DIR}/${shotName}`, quality: 50 });

    const result = {
      ok: true,
      cmd: file,
      frame: shotName,
      url: page.url()
    };

    fs.writeFileSync(`${RES_DIR}/${file}`, JSON.stringify(result, null, 2));

    // delete command
    fs.unlinkSync(full);

    // push results
    execSync(`git add .`, { stdio: "ignore" });
    try {
      execSync(`git commit -m "worker update"`, { stdio: "ignore" });
      execSync(`git push`, { stdio: "ignore" });
    } catch (e) {}

    console.log("✅ Done.");
  }
}

main();
