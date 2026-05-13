export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method !== "POST") {
        return new Response("Use POST", { status: 405 });
      }

      const body = await request.json();

      const {
        action,
        url,
        x,
        y,
        text,
        width = 1280,
        height = 720,
      } = body;

      const browser = await puppeteer.launch(env.MYBROWSER);

      const page = await browser.newPage();

      await page.setViewport({
        width,
        height,
      });

      const sleep = (ms) =>
        new Promise((resolve) => setTimeout(resolve, ms));

      // باز کردن صفحه
      if (url) {
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });

        await sleep(1500);
      }

      // کلیک
      if (action === "click") {
        await page.mouse.click(x, y);

        await sleep(1500);
      }

      // تایپ
      if (action === "type") {
        if (!text) {
          throw new Error("Missing text for type action");
        }

        await page.keyboard.type(text, {
          delay: 20,
        });

        await sleep(1500);
      }

      // paste text
      if (action === "paste_text") {
        if (!text) {
          throw new Error("Missing text for paste_text action");
        }

        await page.fill(
          "input:focus, textarea:focus",
          text
        );

        await sleep(1500);
      }

      // اسکرول
      if (action === "scroll") {
        await page.mouse.wheel(0, y);

        await sleep(1500);
      }

      // اسکرین‌شات
      const screenshot = await page.screenshot({
        type: "jpeg",
        quality: 70,
      });

      await browser.close();

      return new Response(screenshot, {
        headers: {
          "Content-Type": "image/jpeg",
          "Access-Control-Allow-Origin": "*",
        },
      });

    } catch (err) {
      return new Response(
        JSON.stringify({
          error: err.message,
          stack: err.stack,
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }
  },
};
