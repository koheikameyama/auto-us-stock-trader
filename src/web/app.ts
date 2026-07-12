/**
 * Hono アプリ定義・ルート登録（米国株 相場局面モニター）。
 *
 * このリポの web は「相場局面モニター」公開ページ専用（JP の admin ダッシュボードは無い）。
 * ルート「/」= 公開ページ。/admin/* のみ Basic 認証で保護する。
 */

import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";

import regimeRoute from "./routes/regime";
import waitlistRoute from "./routes/waitlist";
import publicRoute, { renderPublicRegimePage } from "./routes/public";

export const app = new Hono();

// Health check（認証なし）
app.get("/api/health", (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() }),
);

// favicon は未配置。404 ノイズを避けるため 204 を返す。
app.get("/favicon.ico", (c) => c.body(null, 204));

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
