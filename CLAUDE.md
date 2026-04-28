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
