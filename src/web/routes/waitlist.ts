/**
 * ウェイトリスト（先行案内メール）管理。Basic 認証の内側（app.ts で /admin/* を保護）。
 * 公開ホストには露出しない。登録済みメールの一覧・件数・削除を提供する。
 */

import { Hono } from "hono";
import { prisma } from "../../lib/prisma";

const app = new Hono();

/** GET /admin/waitlist — 登録一覧（新しい順） */
app.get("/", async (c) => {
  const [count, entries] = await Promise.all([
    prisma.waitlistEntry.count(),
    prisma.waitlistEntry.findMany({
      orderBy: { createdAt: "desc" },
      take: 500,
      select: { id: true, email: true, source: true, createdAt: true },
    }),
  ]);
  return c.json({ count, entries });
});

/** POST /admin/waitlist/:id/delete — 1件削除 */
app.post("/:id/delete", async (c) => {
  const id = c.req.param("id");
  await prisma.waitlistEntry.delete({ where: { id } }).catch(() => {});
  return c.json({ ok: true });
});

export default app;
