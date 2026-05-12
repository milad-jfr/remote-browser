import { chromium } from "playwright"
import fs from "fs"
import path from "path"
import { execSync } from "child_process"

const STATE_DIR = "state"
const CMD = path.join(STATE_DIR, "command.json")
const RESP = path.join(STATE_DIR, "response.json")
const IMG = path.join(STATE_DIR, "live.jpg")

if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR)

if (!fs.existsSync(CMD)) {
  fs.writeFileSync(CMD, JSON.stringify({ processed: true }, null, 2))
}

if (!fs.existsSync(RESP)) {
  fs.writeFileSync(RESP, JSON.stringify({}, null, 2))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function pushState() {
  try {
    execSync("git add state", { stdio: "ignore" })
    execSync('git commit -m "state update"', { stdio: "ignore" })
    execSync("git push", { stdio: "ignore" })
    console.log("⬆️ state pushed")
  } catch (e) {
    // اگر تغییری نبود یا commit خالی بود، بی‌صدا رد شو
  }
}

;(async () => {
  const browser = await chromium.launch({
    headless: true
  })

  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 }
  })

  await page.goto("https://example.com", { waitUntil: "domcontentloaded" })

  console.log("✅ Worker started")

  // حلقه استریم تصویر
  ;(async () => {
    while (true) {
      try {
        await page.screenshot({
          path: IMG,
          type: "jpeg",
          quality: 60
        })

        pushState()
      } catch (e) {
        console.log("stream error:", e.message)
      }

      await sleep(2000)
    }
  })()

  // حلقه پردازش فرمان
  while (true) {
    try {
      if (fs.existsSync(CMD)) {
        const raw = fs.readFileSync(CMD, "utf8")
        const cmd = JSON.parse(raw)

        if (cmd.processed === false) {
          console.log("➡️ command:", cmd.type)

          if (cmd.type === "navigate" && cmd.url) {
            await page.goto(cmd.url, { waitUntil: "domcontentloaded" })
            fs.writeFileSync(RESP, JSON.stringify({
              ok: true,
              type: "navigate",
              url: cmd.url
            }, null, 2))
          }

          else if (cmd.type === "click") {
            await page.mouse.click(cmd.x, cmd.y)
            fs.writeFileSync(RESP, JSON.stringify({
              ok: true,
              type: "click",
              x: cmd.x,
              y: cmd.y
            }, null, 2))
          }

          else if (cmd.type === "hover") {
            await page.mouse.move(cmd.x, cmd.y)

            const box = await page.evaluate(({ x, y }) => {
              const el = document.elementFromPoint(x, y)
              if (!el) return null
              const r = el.getBoundingClientRect()
              return {
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height
              }
            }, { x: cmd.x, y: cmd.y })

            fs.writeFileSync(RESP, JSON.stringify({
              ok: true,
              type: "hover",
              hover: box
            }, null, 2))
          }

          else if (cmd.type === "type" && typeof cmd.text === "string") {
            await page.keyboard.type(cmd.text)
            fs.writeFileSync(RESP, JSON.stringify({
              ok: true,
              type: "type",
              text: cmd.text
            }, null, 2))
          }

          else if (cmd.type === "keypress" && cmd.key) {
            await page.keyboard.press(cmd.key)
            fs.writeFileSync(RESP, JSON.stringify({
              ok: true,
              type: "keypress",
              key: cmd.key
            }, null, 2))
          }

          else if (cmd.type === "pick") {
            const result = await page.evaluate(({ x, y }) => {
              const el = document.elementFromPoint(x, y)
              if (!el) return null

              function selectorFor(element) {
                if (element.id) return "#" + element.id

                const parts = []
                let current = element

                while (current && current.nodeType === 1 && current.tagName) {
                  let part = current.tagName.toLowerCase()

                  if (current.className && typeof current.className === "string") {
                    const classes = current.className.trim().split(/\s+/).filter(Boolean)
                    if (classes.length) {
                      part += "." + classes.slice(0, 2).join(".")
                    }
                  }

                  const parent = current.parentElement
                  if (parent) {
                    const siblings = [...parent.children].filter(
                      c => c.tagName === current.tagName
                    )
                    if (siblings.length > 1) {
                      const index = siblings.indexOf(current) + 1
                      part += `:nth-of-type(${index})`
                    }
                  }

                  parts.unshift(part)
                  current = current.parentElement

                  if (parts.length >= 4) break
                }

                return parts.join(" > ")
              }

              const r = el.getBoundingClientRect()

              return {
                selector: selectorFor(el),
                box: {
                  x: r.x,
                  y: r.y,
                  width: r.width,
                  height: r.height
                },
                text: (el.innerText || "").slice(0, 200)
              }
            }, { x: cmd.x, y: cmd.y })

            fs.writeFileSync(RESP, JSON.stringify({
              ok: true,
              type: "pick",
              pick: result
            }, null, 2))
          }

          cmd.processed = true
          fs.writeFileSync(CMD, JSON.stringify(cmd, null, 2))

          pushState()
        }
      }
    } catch (e) {
      console.log("command loop error:", e.message)
    }

    await sleep(500)
  }
})()
