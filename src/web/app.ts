/**
 * Hono アプリ定義・ルート登録（米国株 相場局面モニター）。
 *
 * このリポの web は「相場局面モニター」公開ページ専用（JP の admin ダッシュボードは無い）。
 * ルート「/」= 公開ページ。/admin/* のみ Basic 認証で保護する。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Hono, type Context } from "hono";
import { basicAuth } from "hono/basic-auth";

import regimeRoute from "./routes/regime";
import waitlistRoute from "./routes/waitlist";
import publicRoute, { renderPublicRegimePage } from "./routes/public";

export const app = new Hono();

// Health check（認証なし）
app.get("/api/health", (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() }),
);

// ── ロゴ・アイコン（STOCK BUDDY US、起動時に一度だけ読み込む） ──
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "assets");
/** ファイルを（Node Buffer のプーリングを考慮して）正確な ArrayBuffer として読む */
function readAsset(name: string): ArrayBuffer {
  const b = readFileSync(join(ASSETS_DIR, name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

const FAVICON_ICO = readAsset("favicon.ico");
const ICON_192 = readAsset("icon-192.png");
const ICON_512 = readAsset("icon-512.png");
const OG_IMAGE = readAsset("og-image.png");
const OG_BANNER = readAsset("og-banner.png");

function serveAsset(contentType: string, body: ArrayBuffer) {
  return (c: Context) => {
    c.header("Content-Type", contentType);
    c.header("Cache-Control", "public, max-age=604800");
    return c.body(body);
  };
}

app.get("/favicon.ico", serveAsset("image/x-icon", FAVICON_ICO));
app.get("/icon-192.png", serveAsset("image/png", ICON_192));
app.get("/icon-512.png", serveAsset("image/png", ICON_512));
app.get("/og-image.png", serveAsset("image/png", OG_IMAGE));
app.get("/og-banner.png", serveAsset("image/png", OG_BANNER));

// Service Worker（オフライン時の最終取得ページ＋アイコンをキャッシュ）
// - ナビゲーション: network-first（常に最新の相場局面を表示、オフライン時のみキャッシュ）
// - アイコン等の静的アセット: cache-first
const SERVICE_WORKER = `
const CACHE = 'stockbuddy-us-v1';
const ASSETS = ['/', '/favicon.ico', '/icon-192.png', '/icon-512.png', '/manifest.json'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin/')) return;
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('/')))
    );
    return;
  }
  e.respondWith(caches.match(req).then((r) => r || fetch(req)));
});
`;

app.get("/sw.js", (c) => {
  c.header("Content-Type", "application/javascript; charset=utf-8");
  c.header("Cache-Control", "no-cache");
  c.header("Service-Worker-Allowed", "/");
  return c.body(SERVICE_WORKER);
});

// PWA マニフェスト
app.get("/manifest.json", (c) =>
  c.json({
    name: "US 相場局面モニター",
    short_name: "StockBuddy US",
    description: "米国株（S&P 500）の相場局面を毎日ひと目で。",
    start_url: "/",
    display: "standalone",
    background_color: "#1a234f",
    theme_color: "#1a234f",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  }),
);

// /admin/* のみ Basic 認証（登録メール管理など内部用）
app.use("/admin/*", async (c, next) => {
  const auth = basicAuth({
    username: process.env.BASIC_AUTH_USER || "admin",
    password: process.env.BASIC_AUTH_PASS || "",
  });
  return auth(c, next);
});

// ルート「/」= 公開ページ（相場局面モニター）
app.get("/", (c) => renderPublicRegimePage(c));

// 公開ページ（/live）と メール登録（/live/waitlist）
app.route("/live", publicRoute);

// 相場局面 API（/api/regime は公開、/api/regime/full も現状は公開サブセットの拡張）
app.route("/api/regime", regimeRoute);

// ウェイトリスト管理（Basic 認証内側）
app.route("/admin/waitlist", waitlistRoute);
