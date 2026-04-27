# SPY Credit Spread テール耐性検証 — 設計ドキュメント

作成日: 2026-04-28
ロードマップ位置: #3（データ層 #1, #2 完了後の戦略検証フェーズ）

## 目的

SPY Bull Put Credit Spread のテールリスクが許容範囲か検証し、本番取引へ進めるか判断する材料を得る。

## 方針サマリー

- アプローチ A: JP リポ `auto-stock-trader` から既存 Credit Spread コードを移管 → テール耐性検証ロジックを追加実装
- 検証観点: a) ヒストリカル全期間の max DD と勝率 + b) 過去ストレスシナリオでの挙動
- 出力形式: ターミナルサマリー + Markdown レポート（`docs/reports/`）+ CSV
- 最終判定: 7 つの閾値（保守版）すべて PASS で実取引推奨

---

## 全体像

3 フェーズで進行:

```
Phase 1: 既存コード移管
   auto-stock-trader/src/backtest/{us/, core/, types.ts, metrics.ts ...}（git history f1f19e08^ から取得）
        │ コピー + import パス書換 + DB 参照を Prisma 経由に
        ▼
   auto-us-stock-trader/src/backtest/

Phase 2: データ準備
   yfinance で 2007-01-01〜 SPY, ^GSPC, ^VIX を追加 backfill
   （IndexDailyBar / StockDailyBar に投入、ON CONFLICT DO NOTHING で既存と統合）

Phase 3: テール耐性検証
   既存 simulation を回す → equity curve から DD 上位抽出 + 事前定義
   イベントの DD/PnL 抽出 → Markdown レポート出力
```

## ディレクトリ構成

```
auto-us-stock-trader/
├── prisma/
│   └── schema.prisma       既存（変更なし）
├── scripts/data/
│   ├── backfill_index_long.py   新規: 2007〜 SPY/^GSPC/^VIX 取得
│   └── (既存 backfill 群)
└── src/
    ├── lib/
    │   ├── prisma-client.ts     Prisma client シングルトン
    │   └── options-pricing.ts   JP から移管 (BS pricing)
    └── backtest/
        ├── types.ts             JP から移管: SimulatedPosition, DailyEquity 等
        ├── metrics.ts           JP から移管: calculateMetrics
        ├── data-fetcher.ts      JP から移管 + Prisma 化
        ├── trading-costs.ts     JP から移管
        ├── credit-spread/
        │   ├── config.ts        JP から移管 (us-credit-spread-config.ts)
        │   ├── simulation.ts    JP から移管 (us-credit-spread-simulation.ts)
        │   ├── types.ts
        │   ├── us-domain-types.ts  JP us-types.ts より必要部分
        │   └── run.ts
        └── tail-test/           **新規**
            ├── stress-windows.ts     事前定義イベント（COVID, Volmageddon 等）
            ├── dd-extractor.ts       equity curve から DD 上位 N を抽出
            ├── window-analyzer.ts    指定期間の PnL/DD/勝率を計算
            ├── tail-metrics.ts       CVaR, テール統計
            ├── pass-fail.ts          閾値判定
            ├── report.ts             Markdown レポート生成
            ├── run-credit-spread-tail-test.ts   エントリーポイント
            └── __tests__/
                ├── dd-extractor.test.ts
                ├── window-analyzer.test.ts
                ├── tail-metrics.test.ts
                └── pass-fail.test.ts

docs/
├── database-schema.md      既存
├── plans/
│   └── 2026-04-28-credit-spread-tail-test-design.md  ← 本ドキュメント
└── reports/
    └── credit-spread-tail-2026-04-28.md
```

### 命名規則
- JP 移管時 `us-` prefix を全削除（schema が `auto_us_stock_trader` で名前空間分離されているため冗長）
- 例: `us-credit-spread-config.ts` → `credit-spread/config.ts`

---

## Phase 1: 既存コード移管詳細

### 移管元と移管先の対応表

git history `f1f19e08^` から取り出すファイル:

| 移管元（JP） | 移管先（本リポ） | 主な変更 |
|---|---|---|
| `src/backtest/us/us-credit-spread-config.ts` | `src/backtest/credit-spread/config.ts` | import パス書換 |
| `src/backtest/us/us-credit-spread-types.ts` | `src/backtest/credit-spread/types.ts` | import パス書換 |
| `src/backtest/us/us-credit-spread-simulation.ts` | `src/backtest/credit-spread/simulation.ts` | import パス書換 |
| `src/backtest/us/us-credit-spread-run.ts` | `src/backtest/credit-spread/run.ts` | DB 接続を Prisma 経由に書換 |
| `src/backtest/us/us-data-fetcher.ts` | `src/backtest/data-fetcher.ts` | DB 参照書換（後述）|
| `src/backtest/us/us-types.ts` | `src/backtest/credit-spread/us-domain-types.ts` | そのまま |
| `src/backtest/us/us-trading-costs.ts` | `src/backtest/trading-costs.ts` | そのまま |
| `src/core/options-pricing.ts` | `src/lib/options-pricing.ts` | そのまま |
| `src/backtest/types.ts`（DailyEquity, SimulatedPosition 等）| `src/backtest/types.ts` | 必要部分だけ抜粋 |
| `src/backtest/metrics.ts`（calculateMetrics）| `src/backtest/metrics.ts` | 必要部分だけ抜粋 |

### data-fetcher.ts の核心改変

JP 側は `prisma.stockDailyBar.findMany({ where: { market: "US" } })` で読んでいたが、本リポは `market` カラム不在（schema 自体が US 専用）。さらに ^GSPC / ^VIX は `IndexDailyBar` に分離済み。

**変更後 API:**
- `fetchHistoricalFromDB(tickers)` — `auto_us_stock_trader."StockDailyBar"` から読む
- `fetchIndexFromDB(['^GSPC', '^VIX'])` — `auto_us_stock_trader."IndexDailyBar"` から読む

### Prisma 接続
- `src/lib/prisma-client.ts` 新規: シングルトン `prisma` を export
- `.env` の `DATABASE_URL` を読む（ローカル / Railway 切替はそのまま）

### 移管しないもの（YAGNI）
- 他戦略（dual-momentum, gapup, mean-reversion, pead, vix-contango, wheel, momentum）
- `walk-forward-us-credit-spread.ts` 等の WF スクリプト
- `combined-*` 等の複合戦略

### Phase 1 完了基準
- `npx tsx src/backtest/credit-spread/run.ts --start 2020-01-01 --end 2023-12-31` がエラー無く実行
- 結果（spreads 数、勝率、equity curve 最終値）が JP 側で実行した結果と一致 or 妥当

---

## Phase 2: データ追加 backfill

### 既存データの状況

| ticker | 現状最古日 | 必要範囲 | ギャップ |
|---|---|---|---|
| `^GSPC` (IndexDailyBar) | 2023-04-17 | 2007-01-01〜 | 2007〜2023-04 (~16年) |
| `^VIX` (IndexDailyBar) | 2023-04-17 | 2007-01-01〜 | 同上 |
| `SPY` (StockDailyBar) | （要確認）| 2007-01-01〜 | 要追加 |

### 実装

新規スクリプト `scripts/data/backfill_index_long.py`:

```python
TICKERS_INDEX = [("^GSPC", "S&P 500"), ("^VIX", "VIX")]
TICKERS_STOCK = [("SPY", "S&P 500 ETF")]

# yf.download(ticker, start="2007-01-01", interval="1d", auto_adjust=True)
# → IndexDailyBar / StockDailyBar に ON CONFLICT DO NOTHING で投入
```

### 実行プロセス
1. ローカル DB に投入 → 件数確認
2. 簡易 spot check（2008-09 リーマン週の VIX が 80 近くまで跳ねていることを SQL で確認）
3. Railway へ追加投入: Railway 接続でスクリプト直接実行（ON CONFLICT で冪等）

### data-fetcher.ts の対応
特になし。読み込み側なので、IndexDailyBar に古いデータが追加されれば自動的に範囲が拡張される。

### Phase 2 完了基準
- `SELECT MIN(date), MAX(date), COUNT(*) FROM auto_us_stock_trader."IndexDailyBar" WHERE "tickerCode"='^GSPC';` で MIN ≤ 2007-01-03、行数 ≥ 4500
- 同 ^VIX
- `SELECT MIN(date) FROM auto_us_stock_trader."StockDailyBar" WHERE "tickerCode"='SPY';` で MIN ≤ 2007-01-03

---

## Phase 3: テール耐性検証ロジック

### 入力 / 出力

```
入力: USCreditSpreadBacktestConfig（移管済 config.ts）
       + ^GSPC/^VIX データ（2007〜2026）
       + 検証期間 startDate, endDate（既定: 2007-01-03 〜 yesterday）

出力: TailTestResult
       ├ baseMetrics: 全期間の勝率 / PF / CAGR / Max DD / CVaR
       ├ ddRanking: 上位 5 の DD ピリオド配列
       │   ├ peakDate, troughDate, recoveryDate
       │   ├ ddPct, ddDollar
       │   ├ matchedEvent: "COVID-19" | null
       │   └ tradesInPeriod: SimulatedSpread[]
       ├ stressWindows: 事前定義イベント別の結果配列
       │   └ 各 window: name, start, end, pnlInWindow, ddInWindow, spreadCount, winRate, dataAvailable
       └ verdict: PassFailVerdict
```

### stress-windows.ts（事前定義イベント）

```ts
export const STRESS_WINDOWS: StressWindow[] = [
  { name: "Lehman / 2008 GFC",         start: "2008-09-01", end: "2009-03-31" },
  { name: "Flash Crash",                start: "2010-05-01", end: "2010-05-31" },
  { name: "EU Debt Crisis",             start: "2011-08-01", end: "2011-10-31" },
  { name: "China Black Monday",         start: "2015-08-15", end: "2015-09-30" },
  { name: "Volmageddon",                start: "2018-02-01", end: "2018-02-28" },
  { name: "Q4 2018 Selloff",            start: "2018-10-01", end: "2018-12-31" },
  { name: "COVID-19",                   start: "2020-02-15", end: "2020-04-30" },
  { name: "2022 Bear",                  start: "2022-01-01", end: "2022-10-31" },
  { name: "Aug 2024 Yen Carry Unwind",  start: "2024-08-01", end: "2024-08-15" },
];
```

### dd-extractor.ts（DD 上位抽出アルゴリズム）

```
1. equityCurve を走査して running max を追跡
2. 各日の ddPct = (running_max - equity[i]) / running_max
3. 連続 DD 期間を識別（peak → trough → recovery）
   recovery = equity が peak まで戻った最初の日（戻らなければ末尾）
4. 各期間を ddPct 降順でソート
5. 上位 5 を返却
6. 各期間に matchedEvent をタグ付け（peakDate/troughDate が STRESS_WINDOWS のいずれかと重なれば）
```

### window-analyzer.ts

各 STRESS_WINDOWS について:
1. window 期間内の equity[start] と equity[end] から PnL 計算
2. window 内の running max → trough で DD 計算
3. window 内に entryDate or closeDate がある closed spreads を集計（spreadCount, winRate, totalPnl）

データ範囲外（手元データに無い期間）は `dataAvailable: false` で表示し、判定対象から除外。

### tail-metrics.ts

```ts
calculateTailMetrics(spreads, equityCurve) → {
  cvar5: number,        // 下位 5% トレードの平均損失
  cvar1: number,        // 下位 1%
  worstSpread: SimulatedSpread,
  worstDay: { date, dailyPnl },
  consecutiveLossCount: number,
}
```

### VIX レジーム別パフォーマンス

3 バケット: VIX > 30 / 20 〜 30 / ≤ 20。各バケットで取引日数、spread 数、勝率、PnL/spread を集計。

### YAGNI（採用しない）
- Monte Carlo シミュレーション
- パラメータ感度分析
- 細かいレジーム分類

---

## 合否判定基準（pass-fail.ts）

### 既定閾値（保守版、ハードコード）

| # | 名前 | 閾値 | 算出元 | カテゴリ |
|---|---|---|---|---|
| 1 | Win Rate | ≥ 70% | baseMetrics.winRate | 平時 |
| 2 | Profit Factor | ≥ 1.3 | sum(wins) / abs(sum(losses)) | 平時 |
| 3 | CAGR | ≥ 10% / 年 | baseMetrics | 平時 |
| 4 | Max DD（全期間） | ≤ 25% | ddRanking[0].ddPct | 平時 |
| 5 | CVaR 5% | ≥ -(maxLoss × 0.5) | tailMetrics.cvar5 | テール |
| 6 | テール期間 DD（最悪） | ≤ 30% | max(stressWindow.dd) | テール |
| 7 | テール期間 PnL（最悪） | ≥ -50%（initialBudget 比）| min(stressWindow.pnlPct) | テール |

### 判定構造

```ts
interface PassFailVerdict {
  overallPass: boolean;         // 全閾値を通れば true
  checks: ThresholdCheck[];     // 各閾値の詳細
  summary: string;              // "PASS: 7/7 checks" 等
}

interface ThresholdCheck {
  name: string;
  category: "平時" | "テール";
  actual: number;
  threshold: number;
  pass: boolean | null;  // null = data unavailable, skipped
  comment?: string;
}
```

### データ不足時の扱い
事前定義 stress window のうち、データ範囲外なものは判定スキップ（`pass: null`、`overallPass` 計算には含めない）。

---

## レポート出力（report.ts）

### 出力先
- `docs/reports/credit-spread-tail-YYYY-MM-DD.md`
- 同階層に CSV: `equity-curve.csv`, `spreads.csv`

### Markdown レポート構造（抜粋）

```markdown
# SPY Credit Spread テール耐性検証レポート — 2026-04-28

## 結論
✅ **PASS**（7/7 checks）

実取引推奨: YES

## 設定
- 期間 / 原資産 / shortPutDelta / spreadWidth / DTE / PT / フィルター / 初期資金

## 平時メトリクス
| 指標 | 値 | 閾値 | 判定 |

## テールメトリクス
| 指標 | 値 | 閾値 | 判定 |

## DD 上位 5 期間
| Rank | Peak | Trough | Recovery | DD% | DD$ | 期間 | 一致イベント |

## 事前定義イベント別分析
| イベント | 期間 | spread 数 | 勝率 | PnL | DD |

## VIX レジーム別パフォーマンス
| VIX Bucket | 取引日数 | spread 数 | 勝率 | PnL/spread |

## 結論詳細
- 平時 / テール / 推奨アクション
```

### 標準出力（ターミナル）

```
=== SPY Credit Spread Tail-Risk Test ===
Period: 2007-01-03 ~ 2026-04-27
Total spreads: 412
Win rate: 75.3% [PASS]
Max DD:   22.1% [PASS]
CVaR 5%:  -$240 [PASS]
Worst stress event: Lehman / 2008 GFC (DD 22.5%)

Verdict: ✅ PASS (7/7 checks)
Report: docs/reports/credit-spread-tail-2026-04-28.md
```

### YAGNI
- HTML / PDF 出力
- グラフ画像
- 履歴比較

---

## テスト戦略

| レベル | 対象 | テスト内容 |
|---|---|---|
| ユニット | dd-extractor, window-analyzer, tail-metrics, pass-fail | 既知入力からの算出が正しいか、境界条件 |
| integration smoke | エンドツーエンド | 小規模 equity curve + spreads で完走 |
| 既存コード再現 | 移管した simulation.ts | JP 側既知結果と一致を手動 spot check |

### フレームワーク
- `vitest` を `package.json` に追加
- 設定: `vitest.config.ts` 最小限

### TDD 採用範囲
- 新規 `tail-test/` 配下: TDD で書く
- 移管コード: TDD 不要（既存実装の移植）

---

## 全体スケジュール

```
Phase 1: 移管（半日〜1日）
   ├ git history からファイル抽出
   ├ src/backtest/ に配置 + import 書換 + data-fetcher の Prisma 化
   ├ vitest 導入
   └ smoke run（2020-2023 で credit-spread/run.ts が動く）

Phase 2: データ追加 backfill（30分〜1時間）
   └ scripts/data/backfill_index_long.py 実行（local + Railway）

Phase 3: テール検証実装（1〜2日）
   ├ tail-test/ 配下を TDD で実装
   ├ stress-windows 定義
   ├ Markdown レポート生成
   └ run-credit-spread-tail-test.ts

Phase 4: 検証実行 + 結果評価（半日）
   ├ 検証走らせて docs/reports/ に出力
   ├ 結果を Linear に投稿
   └ PASS なら次（IBKR/Webull 実装フェーズ）へ進む判断
```

### Linear タスク化案

| Linear | 内容 | 依存 |
|---|---|---|
| KOH-447 | Credit Spread BT コード移管（Phase 1）| KOH-446 |
| KOH-448 | 2007〜の SPY/^GSPC/^VIX backfill（Phase 2）| なし |
| KOH-449 | テール検証ロジック実装 + 検証実行（Phase 3 + 4）| KOH-447, KOH-448 |

---

## YAGNI 原則による不採用一覧

- Monte Carlo シミュレーション
- パラメータ感度分析
- BacktestRun 等の DB 永続化テーブル
- 警告レベル（WARN）の判定
- 過去ベンチマークとの比較
- HTML / PDF レポート
- グラフ画像出力
- E2E テスト（実 yfinance 呼び）
- BS pricing のユニットテスト
- パフォーマンステスト
- CLI フラグでの閾値オーバーライド
- 個別株（S&P500/600 全銘柄）の 2007〜遡及 backfill

これらは将来必要になった時点で別タスクで追加。
