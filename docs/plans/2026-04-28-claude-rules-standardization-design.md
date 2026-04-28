# Claude Code ルール整備 — 設計ドキュメント

**日付**: 2026-04-28
**対象**: auto-us-stock-trader（新規 CLAUDE.md 作成 + 3 リポ標準化テンプレ確立）

## 背景・目的

- `auto-us-stock-trader` には現状 CLAUDE.md が存在しない
- 兄弟リポ（`auto-crypto-trader` / `auto-fx-trader`）は CLAUDE.md 構造がバラバラ（crypto は `docs/claude/` 分割、fx は単一ファイル）
- グローバル `~/.claude/CLAUDE.md` は肥大化しているがリポ固有ルールと混ざっていない（責務分離は維持されている）

**目的**:
1. us-stock-trader 用の CLAUDE.md を新規作成
2. 3 つのトレーダー系リポで CLAUDE.md と Cursor rules の章立てを標準化（横展開は別タスク）

## 方針

**ハイブリッド構成**: 薄い `CLAUDE.md`（概要 + リンク）+ `.cursor/rules/*.mdc`（領域別技術ルール）

`.mdc` の glob による自動スコープを最大活用し、CLAUDE.md は 30-40 行程度に収める。

## ファイル構成

```
auto-us-stock-trader/
├── CLAUDE.md                       # ~35 行: 概要 + Phase + リンク
└── .cursor/
    └── rules/
        ├── global.mdc              # alwaysApply: true
        ├── python-data.mdc         # globs: scripts/**/*.py
        └── prisma-db.mdc           # globs: prisma/**, **/*.prisma
```

**Phase 進行で追加**:
- `typescript-trading.mdc`（取引層着手時、glob: `src/**/*.ts`）
- `backtest.mdc`（BT 移管時、glob: `src/backtest/**`, `scripts/walk-forward/**`）

YAGNI: 現時点で不要なファイルは作らない。

## .mdc フロントマター標準

```yaml
---
description: <1行で何のルールか>
globs: <パターン or 空>
alwaysApply: <true (= globなし常時) / false>
---
```

## 各 .mdc ファイルの内容

### `global.mdc` (alwaysApply: true)

リポ固有の全体ルール（グローバル `~/.claude/CLAUDE.md` と重複しない）:

- **禁止事項**: `prisma db push` / `prisma migrate resolve --applied` 使用禁止（再掲、忘却防止）
- **PR 運用**: Linear 連携必須（`Fixes KOH-XX`）、Claude Code 情報を含めない
- **DB 命名**: 米国データは将来 `us` schema に移行予定（現状 `public.StockDailyBar (market="US")`）
- **タイムゾーン**: コード内の日付は UTC、ログ表示は JST
- **言語分業**: Python = データ収集、TypeScript = 取引/バックテスト

### `python-data.mdc` (globs: `scripts/**/*.py`)

- **DB 接続**: psycopg2 + `execute_values` でバッチ INSERT（N+1 禁止）
- **冪等性**: 全スクリプトで `ON CONFLICT DO NOTHING` を必ず付ける
- **yfinance**: 並列度 1-3、レート制限を意識、空結果は休場日として skip
- **CLI 引数**: `--yes`（本番DB確認スキップ）、`--index sp500/sp600` 互換維持
- **ロギング**: 失敗時は Slack Webhook 通知（GitHub Actions 経由）

### `prisma-db.mdc` (globs: `prisma/**, **/*.prisma`)

- スキーマ変更時のチェックリスト（migrate dev → コミット → 本番 deploy）
- `resolve --applied` 禁止の理由（過去事故 2 回: 2026-02-22, 2026-02-27）

## CLAUDE.md（ルート）の中身

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

## 標準テンプレ（3 リポ共通）

**CLAUDE.md（薄い、~40 行）の章立て**:
1. プロジェクト概要（1-2 文 + README リンク）
2. ロール（プロの XX トレーダーとして）
3. 現在の Phase（✅/🚧/📋）
4. ルール構成（`.cursor/rules/` 一覧表）
5. 関連ドキュメント
6. グローバル設定参照

**`.cursor/rules/` 共通最小セット**:
- `global.mdc` (always): リポ固有の禁止事項・運用
- `<lang/domain>.mdc` (glob): 領域別技術ルール

## スコープ

**今回の作業範囲は auto-us-stock-trader のみ**。

横展開（crypto/fx への適用）は別タスク。今回は「テンプレ確立」を us で完了させる。

## グローバル CLAUDE.md への追記

`~/.claude/CLAUDE.md` に 1 行だけ追加:

> トレーダー系リポの新規作成時は、`auto-us-stock-trader` の `CLAUDE.md` + `.cursor/rules/` 構成を雛形として参照する。

専用テンプレディレクトリ（`~/.claude/templates/`）は作らない（YAGNI、腐敗リスク）。

## 検討した代替案

### 代替案 1: crypto 型分割スタイル（`docs/claude/*.md`）
却下理由: `.mdc` の glob 自動スコープが使えず、Cursor との連携が弱い。

### 代替案 2: fx 型単一ファイル
却下理由: 規模拡大時に分割移行コストが発生。最初から分けた方が運用が楽。

### 代替案 3: CLAUDE.md と `.mdc` で内容重複（完全並走）
却下理由: 同期コストが高く、ルール乖離が発生する。

## 成功基準

- [ ] `auto-us-stock-trader/CLAUDE.md` が作成され、35-40 行に収まっている
- [ ] `.cursor/rules/global.mdc` / `python-data.mdc` / `prisma-db.mdc` が作成されている
- [ ] 各 .mdc に正しいフロントマター（description / globs / alwaysApply）が設定されている
- [ ] `~/.claude/CLAUDE.md` に雛形参照ルールが 1 行追記されている
- [ ] グローバル `~/.claude/CLAUDE.md` の内容と本リポ固有ルールに重複がない

## アウトオブスコープ

- crypto / fx リポへの横展開（別タスク）
- `~/.claude/templates/` の作成（YAGNI）
- `typescript-trading.mdc` / `backtest.mdc` の作成（Phase 進行時に追加）
- グローバル `~/.claude/CLAUDE.md` のスリム化（今回は追記のみ）
