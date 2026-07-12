#!/usr/bin/env bash
set -euo pipefail

# 本番デプロイ時にマイグレーションを適用（migrate deploy は未適用の migration のみを
# 順次適用する。reset は行わない）。共有 DB のため drift 検査つき migrate dev は使わない。
npx prisma migrate deploy

# web サーバー起動（Hono）
exec npx tsx src/worker.ts
