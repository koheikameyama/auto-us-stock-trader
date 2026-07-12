/**
 * Web Worker - 常駐プロセス（相場局面モニター 公開ページ）
 *
 * データ収集・売買は GitHub Actions / cron-job.org が担当するため、この worker は
 * 共有 PostgreSQL を読んで公開ページ・API を配信する web サーバーに徹する。
 * Railway 上で `npm start`（= tsx src/worker.ts）で起動。
 */

import { serve } from "@hono/node-server";
import { app } from "./web/app";
import { prisma } from "./lib/prisma";

const port = parseInt(process.env.PORT || "3000", 10);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`=== US 相場局面モニター 起動 ===`);
  console.log(`  Public page: http://localhost:${info.port}/`);
  console.log(`  API:         http://localhost:${info.port}/api/regime`);
  console.log(`  UTC time:    ${new Date().toISOString()}`);
  console.log(`================================`);
});

async function shutdown(signal: string) {
  console.log(`\n${signal} 受信、シャットダウン中...`);
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
