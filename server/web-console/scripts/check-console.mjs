import { chromium } from "playwright";

const base = process.argv[2] ?? "http://127.0.0.1:5173";
const errors = [];

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (err) => errors.push(String(err)));
page.on("console", (msg) => {
  if (msg.type() === "error") {
    errors.push(msg.text());
  }
});

await page.goto(`${base}/console`, { waitUntil: "networkidle", timeout: 30000 });
await page.waitForTimeout(2000);

const banner = await page.locator(".banner.error").textContent().catch(() => null);
console.log("Banner:", banner?.slice(0, 200) ?? "(none)");
console.log("Page errors:", errors.length ? errors.join("\n") : "(none)");

await browser.close();
process.exit(errors.length || banner?.includes("could not load") ? 1 : 0);
