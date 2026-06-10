#!/usr/bin/env node
/**
 * Capture real product screenshots for public marketing pages.
 * Requires: API on :8080, Vite on :5173, local Postgres with seeded admin.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const BASE = process.env.MARKETING_SHOT_BASE ?? "http://127.0.0.1:5173";
const API = process.env.MARKETING_SHOT_API ?? "http://127.0.0.1:8080";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "../web-console/public/marketing/screenshots");

const ADMIN = {
  agency_slug: "default",
  username: "admin",
  password: "radio-admin",
};

async function loginViaApi() {
  const res = await fetch(`${API}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  if (!res.ok) {
    throw new Error(`login failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function ensureRadioUser(token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const list = await fetch(`${API}/v1/admin/users`, { headers });
  const data = await list.json();
  const existing = data.users?.find((u) => u.username === "unit412");
  if (existing) {
    return { username: "unit412", password: "unit412" };
  }
  const create = await fetch(`${API}/v1/admin/users`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      username: "unit412",
      display_name: "Unit 412",
      password: "unit412",
      role: "radio",
      unit_id: "412",
    }),
  });
  if (!create.ok) {
    console.warn("[screenshots] could not create radio user:", await create.text());
    return null;
  }
  return { username: "unit412", password: "unit412" };
}

async function seedToken(page, token) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
  await page.evaluate((t) => {
    localStorage.setItem("securityradio.token", t);
  }, token);
}

async function shot(page, name, opts = {}) {
  const path = join(OUT, name);
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path, type: "webp", quality: 90, ...opts });
  console.log(`[screenshots] ${name}`);
}

async function clickAdminTab(page, label) {
  await page.waitForSelector(".admin-body .tab");
  await page.evaluate((tabLabel) => {
    const buttons = [...document.querySelectorAll(".admin-body .tab")];
    const btn = buttons.find((b) => b.textContent?.trim() === tabLabel);
    if (!btn) throw new Error(`tab not found: ${tabLabel}`);
    btn.click();
  }, label);
  await new Promise((r) => setTimeout(r, 400));
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { token, user } = await loginViaApi();
  await ensureRadioUser(token);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--font-render-hinting=none"],
    defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
  });

  try {
    const page = await browser.newPage();

    // Signup (public)
    await page.goto(`${BASE}/signup`, { waitUntil: "networkidle2" });
    await page.waitForSelector(".lp-signup-card");
    await shot(page, "signup.webp", { clip: { x: 280, y: 80, width: 720, height: 620 } });

    // Command dispatch console
    await seedToken(page, token);
    await page.goto(`${BASE}/console`, { waitUntil: "networkidle2" });
    await page.waitForSelector(".app-shell");
    await new Promise((r) => setTimeout(r, 800));
    await shot(page, "command-console.webp");

    // Control — users
    await page.goto(`${BASE}/admin`, { waitUntil: "networkidle2" });
    await page.waitForSelector(".admin-body");
    await clickAdminTab(page, "Users");
    await page.waitForSelector(".panel");
    await shot(page, "control-users.webp");

    // Control — downloads (setup + android guide)
    await clickAdminTab(page, "Downloads");
    await page.waitForSelector(".downloads-section");
    await shot(page, "control-downloads.webp");

    // Control — channels (setup step 2)
    await clickAdminTab(page, "Channels");
    await page.waitForSelector(".panel");
    await shot(page, "control-channels.webp");

    // Radio portal (mobile-friendly web UI)
    const radioLogin = await fetch(`${API}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agency_slug: "default",
        username: "unit412",
        password: "unit412",
      }),
    });
    if (radioLogin.ok) {
      const radioSession = await radioLogin.json();
      const radioPage = await browser.newPage();
      await radioPage.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
      await seedToken(radioPage, radioSession.token);
      await radioPage.goto(`${BASE}/radio`, { waitUntil: "networkidle2" });
      await radioPage.waitForSelector(".rp-shell", { timeout: 15000 });
      await new Promise((r) => setTimeout(r, 800));
      await shot(radioPage, "mobile-radio-portal.webp");
      await radioPage.close();
    } else {
      console.warn("[screenshots] radio login skipped:", await radioLogin.text());
    }
  } finally {
    await browser.close();
  }

  console.log("[screenshots] done →", OUT);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
