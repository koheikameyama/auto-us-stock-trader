#!/usr/bin/env bash
set -euo pipefail

# web サーバー（相場局面モニター）は共有 DB を「読む」だけ（+ waitlist 書込）。
# マイグレーションはこの常駐プロセスからは実行しない:
#   - DB は JP リポと共有で _prisma_migrations が混在するため、web 起動ごとに
#     migrate deploy を走らせると失敗レコード（P3009）で起動がクラッシュループし得る。
#   - スキーマ変更は手書き migration SQL を CI(db-migrate-deploy.yml) の migrate deploy で適用する。
exec npx tsx src/worker.ts
