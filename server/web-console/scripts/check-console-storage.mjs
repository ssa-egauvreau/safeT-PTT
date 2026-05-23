import { chromium } from "playwright";

const base = process.argv[2] ?? "http://127.0.0.1:4173";
const cases = [
  ["empty", null],
  ["huge expanded", JSON.stringify({ open: [1, 2, 3, 4, 5, 6, 7, 8], expanded: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], primary: 1, layoutVersion: 13, workspaceLayout: {} })],
  ["bad layout", JSON.stringify({ open: [1], expanded: [1], primary: 1, layoutVersion: 13, workspaceLayout: { "1": { colSpan: 999, rowSpan: 999 } } })],
  ["old version", JSON.stringify({ open: [1, 2], expanded: [1, 2], primary: 1, layoutVersion: 1, workspaceLayout: { "1": { colSpan: 2, rowSpan: 2 } } })],
];

const browser = await chromium.launch();

for (const [label, raw] of cases) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  if (raw) {
    await page.addInitScript((value) => {
      localStorage.setItem("securityradio.console.state", value);
    }, raw);
  }
  await page.goto(`${base}/console`, { waitUntil: "networkidle", timeout: 30000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  const banner = await page.locator(".banner.error").textContent().catch(() => null);
  console.log(`[${label}] banner=${banner?.slice(0, 80) ?? "none"} errors=${errors[0]?.slice(0, 120) ?? "none"}`);
  await page.close();
}

await browser.close();
