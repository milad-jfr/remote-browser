import puppeteer from "puppeteer";
import fs from "fs/promises";

const SESSION_DIR = "./sessions";

await fs.mkdir(SESSION_DIR, { recursive: true });

async function ensurePage(browser) {

  const pages = await browser.pages();

  if (pages.length > 0) {
    return pages[0];
  }

  return await browser.newPage();
}

export default {

  async fetch(request, env) {

    try {

      const url = new URL(request.url);

      //
      // HEALTH
      //

      if (url.pathname === "/health") {

        return new Response(
          JSON.stringify({
            ok: true
          }),
          {
            headers: {
              "content-type":
                "application/json"
            }
          }
        );

      }

      //
      // MAIN
      //

      const data =
        await request.json();

      const {
        sessionId,
        action
      } = data;

      if (!sessionId) {

        return Response.json({
          error: "missing sessionId"
        }, {
          status: 400
        });

      }

      const userDataDir =
        `${SESSION_DIR}/${sessionId}`;

      //
      // BROWSER
      //

      const browser =
        await puppeteer.launch({
          headless: true,
          userDataDir,
          defaultViewport: {
            width: 1920,
            height: 1080
          },
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled"
          ]
        });

      const page =
        await ensurePage(browser);

      //
      // ACTIONS
      //

      switch (action) {

        //
        // OPEN URL
        //

        case "open":

          if (!data.url) {
            throw new Error("missing url");
          }

          await page.goto(
            data.url,
            {
              waitUntil: "networkidle2",
              timeout: 60000
            }
          );

          break;

        //
        // LEFT CLICK
        //

        case "click":

          await page.mouse.click(
            data.x,
            data.y
          );

          await page.waitForTimeout(1000);

          break;

        //
        // RIGHT CLICK
        //

        case "rightclick":

          await page.mouse.click(
            data.x,
            data.y,
            {
              button: "right"
            }
          );

          await page.waitForTimeout(500);

          break;

        //
        // MOUSE DOWN
        //

        case "mousedown":

          await page.mouse.move(
            data.x,
            data.y
          );

          await page.mouse.down();

          break;

        //
        // MOUSE MOVE
        //

        case "mousemove":

          await page.mouse.move(
            data.x,
            data.y
          );

          break;

        //
        // MOUSE UP
        //

        case "mouseup":

          await page.mouse.move(
            data.x,
            data.y
          );

          await page.mouse.up();

          await page.waitForTimeout(500);

          break;

        //
        // SCROLL
        //

        case "scroll":

          await page.mouse.wheel({
            deltaY:
              data.deltaY || 0
          });

          await page.waitForTimeout(500);

          break;

        //
        // TYPE TEXT
        //

        case "type":

          if (!data.text) {
            throw new Error("missing text");
          }

          await page.keyboard.type(
            data.text,
            {
              delay: 20
            }
          );

          break;

        //
        // SINGLE KEY
        //

        case "keypress":

          if (!data.key) {
            throw new Error("missing key");
          }

          await page.keyboard.press(
            data.key
          );

          break;

        //
        // HOTKEYS
        //

        case "hotkey":

          if (
            !Array.isArray(data.keys)
          ) {
            throw new Error(
              "missing keys"
            );
          }

          for (
            const key of data.keys
          ) {

            await page.keyboard.down(
              key
            );

          }

          for (
            const key of [...data.keys].reverse()
          ) {

            await page.keyboard.up(
              key
            );

          }

          break;

        //
        // PASTE
        //

        case "paste":

          if (!data.text) {
            throw new Error(
              "missing paste text"
            );
          }

          await page.evaluate(
            async (text) => {

              await navigator.clipboard.writeText(
                text
              );

            },
            data.text
          );

          await page.keyboard.down(
            "Control"
          );

          await page.keyboard.press(
            "V"
          );

          await page.keyboard.up(
            "Control"
          );

          break;

        //
        // SCREENSHOT
        //

        case "screenshot":

          break;

        //
        // UNKNOWN
        //

        default:

          throw new Error(
            `unknown action: ${action}`
          );

      }

      //
      // WAIT RENDER
      //

      await page.waitForTimeout(500);

      //
      // SCREENSHOT
      //

      const screenshot =
        await page.screenshot({
          type: "jpeg",
          quality: 70,
          fullPage: false
        });

      //
      // RESULT
      //

      const result = {
        ok: true,
        action,
        title: await page.title(),
        url: page.url(),
        timestamp: Date.now(),
        screenshot:
          Buffer.from(
            screenshot
          ).toString("base64")
      };

      //
      // CLOSE
      //

      await browser.close();

      //
      // RESPONSE
      //

      return new Response(
        JSON.stringify(result),
        {
          headers: {
            "content-type":
              "application/json"
          }
        }
      );

    } catch (err) {

      return new Response(
        JSON.stringify({
          ok: false,
          error: err.message,
          stack: err.stack
        }),
        {
          status: 500,
          headers: {
            "content-type":
              "application/json"
          }
        }
      );

    }

  }

};
