# Claude Code ルール整備 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** auto-us-stock-trader に CLAUDE.md と `.cursor/rules/*.mdc` を新規作成し、3 リポ標準テンプレを確立する。

**Architecture:** 薄い `CLAUDE.md`（概要 + リンク、~35 行）+ glob スコープ付き `.cursor/rules/*.mdc`（領域別技術ルール）のハイブリッド構成。グローバル `~/.claude/CLAUDE.md` と内容重複しないリポ固有ルールのみ記載。

**Tech Stack:** Markdown（CLAUDE.md）、MDC（Cursor rules、YAML フロントマター + Markdown 本文）

**Reference:** [docs/plans/2026-04-28-claude-rules-standardization-design.md](2026-04-28-claude-rules-standardization-design.md)

---

### Task 1: ルート CLAUDE.md を作成

**Files:**
- Create: `CLAUDE.md`

**Step 1: ファイル作成**

設計ドキュメントの「CLAUDE.md（ルート）の中身」セクションそのままを書き出す（35 行）。内容:

```markdown
# auto-us-stock-trader — Claude Code 向け プロジェクト指示

## プロジェクト概要

米国株自動トレードシステム。データ収集 → バックテスト → 取引執行を段階的に拡張中。

詳細は [README.md](README.md)。

## ロール

**プロの US 株 / オプショントレーダーとして仕様を考える。**

- 米国市場の特性（時間帯、決算、earnings drift、SPY オプション流動性）を常に意識
- 「素人が便利だと思う機能」ではなく「プロが実戦で使える機能」を優先

## 現在の Phase

- ✅ データ収集層（yfinance → PostgreSQL、GitHub Actions 稼働中）
- 🚧 バックテスト層（auto-stock-trader リポに暫定配置、本リポへ移管予定）
- 📋 取引層（IBKR / Webull、未着手）

## ルール構成

このリポは **CLAUDE.md（概要） + `.cursor/rules/*.mdc`（領域別技術ルール）** で運用。

| ファイル | スコープ | 内容 |
|---|---|---|
| `.cursor/rules/global.mdc` | 常時 | 禁止事項、PR 運用、DB 命名、言語分業 |
| `.cursor/rules/python-data.mdc` | `scripts/**/*.py` | psycopg2 バッチ、yfinance、冪等性 |
| `.cursor/rules/prisma-db.mdc` | `prisma/**` | migrate dev 必須、resolve --applied 禁止 |

Phase 進行に応じて追加: `typescript-trading.mdc`（取引層着手時）、`backtest.mdc`（BT 移管時）。

## 関連ドキュメント

- [docs/database-schema.md](docs/database-schema.md) — US schema 設計
- [docs/plans/](docs/plans/) — 設計・実装プラン

## グローバル設定

ユーザー global rules（`~/.claude/CLAUDE.md`）に従う。
本ファイル / `.cursor/rules/` はリポ固有ルールのみ記載（global と重複しない）。
```

**Step 2: 検証**

Run: `wc -l CLAUDE.md`
Expected: 35-40 行の範囲

Run: `head -1 CLAUDE.md`
Expected: `# auto-us-stock-trader — Claude Code 向け プロジェクト指示`

**Step 3: コミット**

```bash
git add CLAUDE.md
git commit -m "docs: ルート CLAUDE.md を新規作成

概要 + Phase + .cursor/rules/ 一覧の薄い構成。
詳細ルールは .cursor/rules/*.mdc に分割。"
```

---

### Task 2: `.cursor/rules/` ディレクトリと global.mdc を作成

**Files:**
- Create: `.cursor/rules/global.mdc`

**Step 1: ディレクトリ存在確認**

Run: `ls -d .cursor/rules 2>/dev/null || echo "NOT_EXIST"`
Expected: `NOT_EXIST`（新規作成のため）

**Step 2: ファイル作成**

`.cursor/rules/global.mdc` を作成。Write ツールで親ディレクトリも自動作成される。内容:

```markdown
---
description: auto-us-stock-trader リポ全体に常時適用されるルール
globs:
alwaysApply: true
---

# 全体ルール（auto-us-stock-trader）

グローバル `~/.claude/CLAUDE.md` に従いつつ、本リポ固有のルールを以下に定義する。

## 禁止事項（再掲・忘却防止）

- `prisma db push` は使用禁止 → `prisma migrate dev --name <change>` を必ず使う
- `prisma migrate resolve --applied` は使用禁止 → 過去 2 回事故あり（2026-02-22, 2026-02-27）

## PR 運用

- PR 本文に必ず `Fixes KOH-XX`（Linear タスク ID）を含める
- コミット / PR 本文に Claude Code 情報（Generated with Claude Code, Co-Authored-By）を**含めない**
- マージは手動（Claude は PR 作成まで）

## DB 命名

- 米国データは将来 `us` schema に移行予定
- 現状は暫定的に `public.StockDailyBar (market="US")` に投入
- 新規 US 専用テーブルを追加する場合は `us` schema を前提に設計する

## タイムゾーン

- コード内の日付・時刻は **UTC** で保存
- ログ・ユーザー向け表示は **JST**（Asia/Tokyo）に変換

## 言語分業

- **Python**: データ収集（`scripts/data/`）、バックエンドバッチ
- **TypeScript**: 取引執行、バックテスト（移管後）
- 取引コードに Python を混ぜない、データ収集に TS を混ぜない
```

**Step 3: 検証**

Run: `head -5 .cursor/rules/global.mdc`
Expected: フロントマター（`---`、`description:`、`globs:`、`alwaysApply: true`、`---`）

**Step 4: コミット**

```bash
git add .cursor/rules/global.mdc
git commit -m "feat(rules): .cursor/rules/global.mdc を追加

リポ全体に常時適用されるルール（禁止事項、PR 運用、DB 命名、
タイムゾーン、言語分業）。グローバル CLAUDE.md と重複しない
リポ固有ルールのみ記載。"
```

---

### Task 3: python-data.mdc を作成

**Files:**
- Create: `.cursor/rules/python-data.mdc`

**Step 1: ファイル作成**

内容:

```markdown
---
description: Python データ収集スクリプト（scripts/**/*.py）のルール
globs: scripts/**/*.py
alwaysApply: false
---

# Python データ収集ルール

## DB 接続・書き込み

- **psycopg2 + `execute_values` でバッチ INSERT** を使う（N+1 禁止）
- ループ内での DB 接続・個別 INSERT は禁止
- 接続は 1 回、コミットは最後に 1 回

```python
import psycopg2.extras

psycopg2.extras.execute_values(
    cur,
    """
    INSERT INTO "Stock" (ticker, name, sector)
    VALUES %s
    ON CONFLICT (ticker) DO UPDATE SET name = EXCLUDED.name
    """,
    [(s.ticker, s.name, s.sector) for s in stocks],
    page_size=100
)
```

## 冪等性

- 全スクリプトで `ON CONFLICT DO NOTHING` または `ON CONFLICT DO UPDATE` を必ず付ける
- 同日に複数回実行しても安全であること

## yfinance

- 並列度は **1-3** に抑える（既存スクリプト準拠、レート制限回避）
- 取得結果が空の場合は休場日として skip（米国 holiday 判定は yfinance 任せ）
- yfinance のレスポンスはバージョン依存があるので、重要フィールドはアサーションで防御

## CLI 引数

- `--yes`: 本番 DB 接続時の確認スキップ（既存スクリプトとの互換維持）
- `--index sp500` / `--index sp600`: daily_bars 系で対象インデックスを指定
- 既存スクリプトの引数仕様を変更する場合は README の表も同時更新

## ロギング・通知

- 失敗時は GitHub Actions 経由で Slack Webhook 通知
- 個別スクリプトに通知ロジックを書かない（GHA workflow 側で集約）
```

**Step 2: 検証**

Run: `grep -E "^globs:" .cursor/rules/python-data.mdc`
Expected: `globs: scripts/**/*.py`

**Step 3: コミット**

```bash
git add .cursor/rules/python-data.mdc
git commit -m "feat(rules): .cursor/rules/python-data.mdc を追加

scripts/**/*.py 配下に自動適用される技術ルール
（psycopg2 バッチ、冪等性、yfinance 並列度、CLI 引数互換）。"
```

---

### Task 4: prisma-db.mdc を作成

**Files:**
- Create: `.cursor/rules/prisma-db.mdc`

**Step 1: ファイル作成**

内容:

```markdown
---
description: Prisma スキーマ・マイグレーション関連のルール
globs: prisma/**, **/*.prisma
alwaysApply: false
---

# Prisma / DB マイグレーションルール

## スキーマ変更時のフロー

1. `prisma/schema.prisma` を編集
2. `npx prisma migrate dev --name <change>` を実行（マイグレーションファイル生成）
3. 生成された `prisma/migrations/<timestamp>_<change>/migration.sql` をコミット
4. 本番デプロイ時は `npx prisma migrate deploy` で適用

## 禁止コマンド

### `prisma db push`

- 開発中のプロトタイプ用。**本番では絶対に使わない**
- マイグレーション履歴が残らず、チーム・環境間でスキーマ差分が出る

### `prisma migrate resolve --applied`

- **使用禁止**
- 理由: SQL を実行せず「適用済み」とマークするだけのコマンド
- 過去 2 回（2026-02-22, 2026-02-27）に同じ事故が発生:
  `.env` が本番 DB を指している状態で実行 → カラム未作成のまま「適用済み」扱いに
- シャドウ DB エラーが出ても `migrate dev` で解決すること

## チェックリスト

スキーマ変更 PR 作成前:

- [ ] `prisma migrate dev` でマイグレーションファイルを生成した
- [ ] `prisma/migrations/` 配下のファイルを Git にコミットした
- [ ] 本番デプロイ手順は `migrate deploy` を使う前提で書いている
- [ ] `db push` / `resolve --applied` を使っていない
```

**Step 2: 検証**

Run: `grep -E "^globs:" .cursor/rules/prisma-db.mdc`
Expected: `globs: prisma/**, **/*.prisma`

**Step 3: コミット**

```bash
git add .cursor/rules/prisma-db.mdc
git commit -m "feat(rules): .cursor/rules/prisma-db.mdc を追加

prisma/** 配下のスキーマ・マイグレーションルール
（migrate dev 必須、db push 禁止、resolve --applied 禁止）。"
```

---

### Task 5: グローバル ~/.claude/CLAUDE.md に雛形参照ルールを追記

**Files:**
- Modify: `~/.claude/CLAUDE.md`

**Step 1: 追記位置を確認**

Run: `grep -n "## ブランチ運用" ~/.claude/CLAUDE.md`
Expected: 該当セクションの行番号が表示される

末尾もしくは「## モデル選択」セクションの直前あたりに追記する。

**Step 2: Edit ツールで追記**

ファイル末尾、`## モデル選択` セクションの前に以下のセクションを追加:

```markdown
## トレーダー系リポの雛形

新規にトレーダー系リポ（株/FX/暗号通貨など）を作成する際は、
`auto-us-stock-trader` の `CLAUDE.md` + `.cursor/rules/` 構成を雛形として参照する。

- ルート `CLAUDE.md`: 概要 + Phase + `.cursor/rules/` 一覧（~35 行）
- `.cursor/rules/global.mdc`: 常時適用のリポ固有ルール
- `.cursor/rules/<domain>.mdc`: glob スコープ付き領域別ルール
```

**Step 3: 検証**

Run: `grep -A 3 "トレーダー系リポの雛形" ~/.claude/CLAUDE.md`
Expected: 追記したセクションが表示される

**Step 4: コミット**

`~/.claude/` が Git 管理下の場合のみコミット。確認:

Run: `cd ~/.claude && git status 2>/dev/null && cd -`

- Git 管理下なら: ユーザーに「~/.claude/CLAUDE.md の変更をコミットしますか？」と確認してから実行
- Git 管理下でなければ: ファイル変更のみで終了

---

### Task 6: 全体検証

**Step 1: ファイル一覧確認**

Run: `find CLAUDE.md .cursor/rules -type f 2>/dev/null`
Expected:
```
CLAUDE.md
.cursor/rules/global.mdc
.cursor/rules/python-data.mdc
.cursor/rules/prisma-db.mdc
```

**Step 2: 各 .mdc のフロントマター検証**

Run: `for f in .cursor/rules/*.mdc; do echo "=== $f ==="; head -5 $f; done`

Expected: 各ファイルが以下のいずれかのフロントマター形式を持つ
- `global.mdc`: `alwaysApply: true`、`globs:` は空
- `python-data.mdc` / `prisma-db.mdc`: `alwaysApply: false`、`globs:` にパターン

**Step 3: グローバルとの重複チェック**

Run: `grep -l "fish_add_path\|JST\|N+1" .cursor/rules/*.mdc 2>/dev/null`
Expected: マッチなし or 最小限（グローバル CLAUDE.md と重複していないこと）

**Step 4: 設計成功基準のレビュー**

[docs/plans/2026-04-28-claude-rules-standardization-design.md](2026-04-28-claude-rules-standardization-design.md) の「成功基準」セクションを開き、以下を確認:

- [ ] CLAUDE.md が 35-40 行に収まっている
- [ ] 3 つの .mdc ファイルが正しいフロントマターで作成されている
- [ ] `~/.claude/CLAUDE.md` に雛形参照ルールが追記されている
- [ ] グローバルとリポ固有ルールに重複がない

**Step 5: 最終確認**

ユーザーに完了報告し、追加修正の有無を確認する。
