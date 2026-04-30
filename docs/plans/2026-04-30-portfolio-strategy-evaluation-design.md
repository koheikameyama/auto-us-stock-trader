# Portfolio Strategy Evaluation — 設計ドキュメント

作成日: 2026-04-30
ロードマップ位置: Phase F（paper trading 90 日観察と並行、別セッションで進行）
前提: SPY Credit Spread の paper trading 開始済み（KOH-454 系列）

## 目的

SPY Credit Spread の portfolio 補完候補を、credit-spread との相関の低さを主軸に評価し、本番 portfolio 構成判断（KOH-458 / KOH-459）の材料を得る。

## 方針サマリー

- 評価対象は roadmap で予定されていた 7 戦略を Tier 分類で絞り込み（Tier 1: 3 戦略フル評価 / Tier 2: 2 戦略ライト評価 / Tier 3: 2 戦略は理論的重複のため scope 外）
- データ backfill は戦略ごとに必要最低限の期間で実施
- 実装は Dual Momentum 単独で 1 サイクル → tail-test framework 抽象化 → 残り並列実装のハイブリッド進行
- ファイル移管は credit-spread と同じパターン（git history `f1f19e08^` から JP リポのコードを取り出し、移管と同時に純関数化リファクタを行う = α-1）
- 最終 deliverable: 戦略間の相関行列 + portfolio 化判断レポート

---

## スコープ（Tier 分類）

| Tier | 戦略 | 評価深度 | 理由 |
|---|---|---|---|
| 1 | Dual Momentum | フル tail-test | 弱気局面で defensive、最大 diversifier 期待 |
| 1 | PEAD | フル tail-test | 単独株 idiosyncratic、vol regime 非依存 |
| 1 | Momentum (時系列) | フル tail-test | 上下両トレンドで稼ぐ、vol exposure なし |
| 2 | Gap-up | ライト評価 | 個別株 momentum、bull regime 寄りで diversification 限定的 |
| 2 | Mean-reversion | ライト評価 | 個別株 short-vol 的、tail で credit-spread と共倒れリスク |
| 3 | **Wheel** | **scope 外** | 個別株版 short-vol、credit-spread と高相関 |
| 3 | **VIX contango** | **scope 外** | vol spike で credit-spread と同時死亡（2018 Volmageddon） |

### Tier 別 deliverable

- **Tier 1**: 移管 + 純関数化リファクタ + tail-test 適用 + Markdown レポート + pass/fail 判定
- **Tier 2**: 移管 + 純関数化リファクタ + 全期間 metrics + credit-spread との **相関係数のみ** 算出（pass/fail 判定なし、Tier 1 結果を踏まえ格上げ判断）
- **Tier 3**: 本ドキュメントに「除外理由」を明記、実装なし

---

## 全体像とフェーズ構成

```
Phase 0: Dual Momentum 単体で 1 サイクル回す（実例 1 つ）
   ├ Step 0-1: JP 移管 (us-dual-momentum-*.ts → dual-momentum/) + 純関数化 + テスト
   ├ Step 0-2: データ backfill（rotation ETFs 2007〜、既存 backfill_rotation_etfs.py 拡張）
   ├ Step 0-3: tail-test を credit-spread のフレームのまま適用（手動配線）
   └ Step 0-4: レポート出力 + 結果評価

Phase 1: tail-test framework 抽象化リファクタ
   ├ Step 1-1: credit-spread と dual-momentum 2 例から共通 interface を抽出
   │           (StrategyResult: { equityCurve, trades, config })
   ├ Step 1-2: tail-test/ 配下を strategy-agnostic に書き換え
   │           (dd-extractor, window-analyzer, tail-metrics は equityCurve のみで動く)
   ├ Step 1-3: pass-fail 閾値を戦略ごとに設定可能に
   └ Step 1-4: 既存 credit-spread の tail-test が同じ結果を再現することを snapshot test で確認

Phase 2: PEAD + Momentum 並列実装（別セッションで dispatch 可能）
   ├ Strategy A: PEAD
   │   ├ JP 移管 + 純関数化 + テスト
   │   ├ データ backfill（earnings 2015〜、S&P500 個別株 2015〜）
   │   ├ 抽象化済み framework に接続
   │   └ レポート出力
   └ Strategy B: Momentum
       ├ JP 移管 + 純関数化 + テスト
       ├ データ backfill（インデックス + 主要 ETF 2007〜、概ね既存データで足りる想定）
       ├ 抽象化済み framework に接続
       └ レポート出力

Phase 3: Tier 2 ライト評価
   ├ Gap-up 移管 + 純関数化 + 相関係数のみ算出
   └ Mean-reversion 移管 + 純関数化 + 相関係数のみ算出

Phase 4: Portfolio 化判断
   ├ 全 5 戦略 × credit-spread の相関行列を出力
   ├ Tier 1 の中で最も diversifying かつ単独でも筋の良い戦略を選定
   ├ Tier 2 を格上げするか判断
   └ portfolio 構成案を docs/reports/ に記録（実装は別タスク KOH-XXX）
```

### 判断ゲート

- **Phase 0 終了時**: Dual Momentum 単独 metrics が極端に悪ければ（CAGR < 0%, Max DD > 50% 等）即時 scope 外判断
- **Phase 1 終了時**: 抽象化が破綻していたら一度 credit-spread に戻して立て直し
- **Phase 4**: portfolio 化を実行するかは別 design doc で再判断（KOH-458 の input になる）

---

## 共通フレーム抽象化（Phase 1 詳細）

### 抽象化のキー設計

戦略ごとに「trade」の形が違う（spread / position / rotation slot）ので、共通 interface は **equity curve ベース**にする。trade 詳細は戦略固有メトリクスに閉じる。

### 共通 interface

```ts
// src/backtest/framework/strategy-result.ts
export interface StrategyResult {
  strategyName: string;             // "credit-spread" | "dual-momentum" | ...
  config: unknown;                  // 戦略固有 config（レポートのメタ情報）
  period: { start: string; end: string };
  equityCurve: DailyEquity[];       // { date, equity, cash } の配列
  initialBudget: number;
  trades: TradeSummary[];           // 戦略横断で必要な最小情報のみ
  strategySpecificMetrics?: unknown; // 戦略固有メトリクス（spread の MAE 等）
}

export interface TradeSummary {
  entryDate: string;
  closeDate: string | null;         // open ポジは null
  pnl: number;
  pnlPct: number;                   // initialBudget 比 or position 比
  category?: string;                // 戦略固有カテゴリ（"win" | "loss" | "stopOut" 等）
}
```

### tail-test/ の strategy-agnostic 化

| ファイル | 変更内容 |
|---|---|
| `dd-extractor.ts` | 入力を `equityCurve` のみに（既にそうなっている想定、確認だけ） |
| `window-analyzer.ts` | 入力を `equityCurve` + `trades` に（spread → trade に rename） |
| `tail-metrics.ts` | 入力を `equityCurve` + `trades` に |
| `pass-fail.ts` | **戦略ごとに閾値 config を受け取る** ように変更 |
| `report.ts` | `strategyName` をタイトルに反映、戦略固有メトリクスは optional セクションで描画 |
| `stress-windows.ts` | 共通（変更なし、全戦略同じ tail event で評価） |
| `correlation.ts` | **新規**: 2 戦略の equityCurve 相関係数算出 |

### pass-fail config 例

```ts
// src/backtest/credit-spread/tail-test-thresholds.ts
export const CREDIT_SPREAD_THRESHOLDS = {
  winRate: 0.70, profitFactor: 1.3, cagr: 0.10,
  maxDD: 0.25, cvar5Multiplier: 0.5, stressMaxDD: 0.30, stressMinPnl: -0.50,
};

// src/backtest/dual-momentum/tail-test-thresholds.ts
export const DUAL_MOMENTUM_THRESHOLDS = {
  winRate: null,           // 月次 rotation で win rate 概念が薄い → スキップ
  profitFactor: 1.0,
  cagr: 0.07,
  maxDD: 0.30,             // dual momentum は drawdown が credit-spread より大きくて自然
  cvar5Multiplier: null,
  stressMaxDD: 0.35,
  stressMinPnl: -0.40,
};
```

`null` 閾値はスキップ判定（credit-spread の "data unavailable" と同じ仕組み）。

### 移行戦略

1. Phase 1 開始時、`tail-test/` を `framework/tail-test/` (共通) と `<strategy>/tail-test-thresholds.ts` (戦略固有) に分離
2. credit-spread の tail-test が同じ結果を再現する snapshot test を追加（リグレッション防止）
3. dual-momentum を framework に接続して動作確認

---

## データ要件と backfill

### 戦略別データ要件

| 戦略 | 必要データ | 期間 | 既存スクリプト | 追加 backfill |
|---|---|---|---|---|
| Dual Momentum | rotation ETFs (SPY, EFA, AGG, BIL 等) | 2007-01-01〜 | `backfill_rotation_etfs.py` | 期間延長のみ |
| PEAD | S&P500 個別株 daily + earnings calendar | 2015-01-01〜 | `backfill_daily_bars.py`, `backfill_earnings.py` | 期間確認、不足分追加 |
| Momentum (時系列) | SPY + 主要 ETF (QQQ, IWM, GLD, TLT 等) | 2007-01-01〜 | `backfill_index.py`, `backfill_rotation_etfs.py` | universe 拡張の可能性 |
| Gap-up | S&P500 個別株 daily | 2015-01-01〜 | `backfill_daily_bars.py` | 既存で概ね充足 |
| Mean-reversion | S&P500 個別株 daily | 2015-01-01〜 | `backfill_daily_bars.py` | 既存で概ね充足 |

### backfill 実行プロトコル

各戦略の Phase 開始時に以下を実行:

1. **現状確認 SQL**: `SELECT MIN(date), MAX(date), COUNT(*)` で必要 universe の状況を確認
2. **不足分のみ backfill**: 既存スクリプトに `--start` / `--end` を渡して差分のみ取得（ON CONFLICT DO NOTHING で冪等）
3. **spot check**: 既知の極値日（2008-09-15 リーマン、2020-03-16 COVID 暴落、2018-02-05 Volmageddon）でデータが存在するか確認
4. **Railway 反映**: ローカル確認後、同じスクリプトで本番 DB へ投入

### 注意点

- **PEAD の earnings 古いデータ**: yfinance の earnings 取得は近年データのみ対応の可能性あり。Phase 2 開始時に取得可能性を確認し、不可なら `2015〜` を `2018〜` に短縮 or 別 source（zacks スクレイピング等は YAGNI）
- **個別株の delisting 銘柄**: 過去 universe の survivorship bias 問題は既存 JP 実装で対応済みかどうかを移管時に確認、未対応なら現状の制約として明記し補正は YAGNI

### 共通フレームへの影響なし

データ取得は data-fetcher.ts レイヤーの責務。tail-test framework は equityCurve 入力なのでデータ依存なし。

---

## ディレクトリ構成

```
auto-us-stock-trader/
├── prisma/
│   └── schema.prisma                   既存（変更なし）
├── scripts/data/
│   ├── backfill_daily_bars.py          既存
│   ├── backfill_earnings.py            既存
│   ├── backfill_index.py               既存
│   ├── backfill_rotation_etfs.py       既存（期間延長のみ）
│   └── backfill_vol_etfs.py            既存（Tier 3 用、本プロジェクトでは使わない）
└── src/
    ├── lib/
    │   ├── prisma-client.ts            既存
    │   └── options-pricing.ts          既存
    └── backtest/
        ├── types.ts                    既存（DailyEquity 等）+ TradeSummary 追加
        ├── metrics.ts                  既存
        ├── data-fetcher.ts             既存
        ├── trading-costs.ts            既存
        │
        ├── framework/                  **新規**: 戦略横断の共通レイヤー
        │   ├── strategy-result.ts      StrategyResult / TradeSummary 定義
        │   ├── tail-test/              ← 旧 src/backtest/tail-test/ から移動
        │   │   ├── stress-windows.ts
        │   │   ├── dd-extractor.ts
        │   │   ├── window-analyzer.ts
        │   │   ├── tail-metrics.ts
        │   │   ├── pass-fail.ts
        │   │   ├── report.ts
        │   │   ├── correlation.ts      **新規**: equityCurve 相関係数算出
        │   │   └── __tests__/
        │   └── multi-strategy-report.ts **新規**: 全戦略の相関行列レポート（Phase 4）
        │
        ├── credit-spread/              既存 + tail-test-thresholds.ts 抽出
        │   ├── config.ts / simulation.ts / types.ts / us-domain-types.ts / run.ts
        │   ├── tail-test-thresholds.ts **新規**: 抽出された credit-spread 固有閾値
        │   ├── run-tail-test.ts        ← 旧 run-credit-spread-tail-test.ts から移動
        │   └── __tests__/
        │
        ├── dual-momentum/               **新規 (Phase 0)**
        │   ├── config.ts / simulation.ts / types.ts / run.ts
        │   ├── tail-test-thresholds.ts
        │   ├── run-tail-test.ts
        │   └── __tests__/
        │
        ├── pead/                        **新規 (Phase 2-A)**
        ├── momentum/                    **新規 (Phase 2-B)**
        ├── gapup/                       **新規 (Phase 3, ライト評価)**
        └── mean-reversion/               **新規 (Phase 3, ライト評価)**

docs/
├── plans/
│   ├── 2026-04-30-portfolio-strategy-evaluation-design.md  ← 本ドキュメント
│   └── (既存 plans)
└── reports/
    ├── credit-spread-tail-YYYY-MM-DD.md     既存
    ├── dual-momentum-tail-YYYY-MM-DD.md     新規
    ├── pead-tail-YYYY-MM-DD.md              新規
    ├── momentum-tail-YYYY-MM-DD.md          新規
    ├── tier2-light-evaluation-YYYY-MM-DD.md gapup + mean-reversion 統合レポート
    └── portfolio-correlation-matrix-YYYY-MM-DD.md  Phase 4 最終レポート
```

### 命名規則

- credit-spread と同様に `us-` prefix を全削除（schema が US 専用名前空間）
- 戦略フォルダ名は kebab-case
- tail-test 実行スクリプトは `run-tail-test.ts`（戦略フォルダ内に閉じる）

---

## テスト戦略

### 移管 + 純関数化（α-1）の TDD パターン

credit-spread のリファクタ（commit `74ebb3a`, `fc003ef`, `56b53ca`, `18493fd`）と同じ流れ:

1. JP 移管直後の simulation.ts はクラス / 状態持ち / 副作用混在 → そのままでは TDD 困難
2. **純関数として抽出**: `evaluateSpread`, `generateEntrySignal`, `calcDDStopState` のような副作用なし関数を切り出す
3. **TDD で純関数のテストを先に書く** → 既存挙動を再現する固定入力での expected output で書く
4. simulation.ts は純関数を呼ぶラッパーになる

### 戦略別 純関数化候補（移管時に詳細決定）

| 戦略 | 抽出候補（仮説） |
|---|---|
| Dual Momentum | `selectTopMomentumAssets(prices, lookback) → string[]`<br>`shouldRotate(currentDate, lastRotation, frequency) → boolean`<br>`calculateRotationOrders(current, target, equity) → Order[]` |
| PEAD | `calculateEarningsSurprise(actual, estimate) → number`<br>`generatePEADSignal(surprise, gap, volume, filters) → Signal \| null`<br>`evaluatePEADExit(position, currentDate, holdDays) → ExitDecision` |
| Momentum (時系列) | `calculateTrendScore(prices, lookback) → number`<br>`generateMomentumSignal(score, threshold) → Signal \| null`<br>`evaluateMomentumExit(position, score) → ExitDecision` |
| Gap-up | `evaluateGapQuality(prevClose, openPrice, volume) → GapMetrics`<br>`generateGapupSignal(metrics, filters) → Signal \| null` |
| Mean-reversion | `calculateMeanReversionScore(prices, lookback, zscore) → number`<br>`generateMeanRevSignal(score, threshold) → Signal \| null` |

### テストレベル

| レベル | 対象 | 内容 |
|---|---|---|
| ユニット | 上記 純関数 | 既知入力 → 期待出力、境界条件、null/empty ハンドリング |
| ユニット | framework/tail-test/* | 既存の credit-spread テストを保持、戦略横断で動作することを確認 |
| ユニット | framework/correlation.ts | 既知 equityCurve から Pearson 相関係数算出が正しいか |
| snapshot | credit-spread tail-test | Phase 1 抽象化リファクタ前後で結果が完全一致 |
| integration smoke | 各戦略の `run-tail-test.ts` | 短期間（例: 2020-01-01〜2022-12-31）で完走 |
| 既存実装再現 | 移管した simulation.ts | JP 側の既知結果と spreads/trades 数 +/- 1 件以内で一致を手動 spot check |

### TDD 適用範囲

- 新規純関数: TDD 必須
- framework 抽象化: TDD（既存 tail-test の挙動を snapshot で固めてから書き換え）
- データレイヤー（data-fetcher 拡張）: 統合 smoke のみ、ユニット TDD は YAGNI

---

## 合否判定 / 相関評価 / portfolio 化判断

### Tier 1 各戦略の pass/fail（戦略個別）

credit-spread と同じく 7 閾値構造を踏襲、ただし戦略特性に合わせて調整:

| # | 名前 | credit-spread | Dual Momentum | PEAD | Momentum |
|---|---|---|---|---|---|
| 1 | Win Rate | ≥ 70% | null (skip) | ≥ 55% | ≥ 50% |
| 2 | Profit Factor | ≥ 1.3 | ≥ 1.0 | ≥ 1.5 | ≥ 1.3 |
| 3 | CAGR | ≥ 10% | ≥ 7% | ≥ 8% | ≥ 8% |
| 4 | Max DD | ≤ 25% | ≤ 30% | ≤ 35% | ≤ 30% |
| 5 | CVaR 5% | ≥ -(maxLoss × 0.5) | null (skip) | trade ベース算出 | trade ベース算出 |
| 6 | テール期間 DD（最悪） | ≤ 30% | ≤ 35% | ≤ 40% | ≤ 35% |
| 7 | テール期間 PnL（最悪） | ≥ -50% | ≥ -40% | ≥ -45% | ≥ -45% |

注: 上記は **初期値（暫定）**。Phase 0 の Dual Momentum 結果を見て微調整する余地あり。

### 相関評価（framework/correlation.ts）

Phase 4 で実施:

```ts
calculateCorrelationMatrix(strategies: StrategyResult[]) → CorrelationMatrix
```

- 入力: 全戦略の equity curve（同期間にアラインメント、欠損日は前日値で fill）
- 算出: **日次リターン**の Pearson 相関係数（equity 水準ではなく差分で算出、トレンド除去）
- 期間: 全戦略のデータ範囲が重なる最長期間（実質 2015〜現在）
- 出力: 戦略ペアごとの相関係数 + tail event 期間に絞った "stress correlation"（通常は相関が上振れる現象を可視化）

### 相関判定の解釈ガイド

| 相関係数（vs credit-spread） | 解釈 | portfolio 採用 |
|---|---|---|
| ≤ 0.0 | 負相関（理想） | 採用候補 |
| 0.0 〜 0.3 | 低相関 | 採用候補 |
| 0.3 〜 0.6 | 中相関 | 慎重判断（リターンとの兼ね合い） |
| ≥ 0.6 | 高相関 | 重複として除外 |

### portfolio 化判断ロジック（Phase 4）

1. Tier 1 で個別 pass した戦略を抽出
2. credit-spread との相関係数で並べる
3. 上位（最も低相関）から 1〜2 戦略を補完候補に選定
4. 補完候補の同時運用シミュレーション（等資金 50/50 or 70/30 等）の equity curve を組成
5. portfolio としての pass/fail 判定:
   - portfolio Max DD ≤ credit-spread 単独の Max DD（diversification effect の証明）
   - portfolio CAGR ≥ credit-spread 単独の CAGR × 0.9（リターン犠牲が許容範囲）
   - stress correlation が tail で 0.8 を超えないこと
6. 結果を `portfolio-correlation-matrix-YYYY-MM-DD.md` に記録

### 判定スキップの扱い

credit-spread と同じく `pass: null` で記録、`overallPass` 計算には含めない。

---

## スケジュール / Linear タスク化

### スケジュール（目安）

| Phase | 内容 | 工数目安 |
|---|---|---|
| Phase 0 | Dual Momentum: 移管 + 純関数化 + 既存 tail-test 適用 + レポート | 2〜3 日 |
| Phase 1 | tail-test framework 抽象化リファクタ + correlation.ts 追加 | 1〜2 日 |
| Phase 2-A | PEAD: 移管 + 純関数化 + データ backfill + tail-test + レポート | 2〜3 日 |
| Phase 2-B | Momentum: 移管 + 純関数化 + データ backfill + tail-test + レポート | 2〜3 日 |
| Phase 3 | Tier 2: Gap-up + Mean-reversion ライト評価 | 1〜2 日 |
| Phase 4 | 相関行列 + portfolio 化判断レポート | 1 日 |

合計目安: **9〜14 日**（Phase 2-A / 2-B 並列化次第で短縮可能）

### Linear タスク化案

| Linear ID | 内容 | 依存 |
|---|---|---|
| KOH-XXX | Phase 0: Dual Momentum 移管 + 純関数化 + tail-test 適用 | KOH-454 と並行可 |
| KOH-XXX | Phase 1: framework 抽象化リファクタ + correlation.ts | Phase 0 |
| KOH-XXX | Phase 2-A: PEAD 実装 + 評価 | Phase 1 |
| KOH-XXX | Phase 2-B: Momentum 実装 + 評価 | Phase 1（2-A と並列可） |
| KOH-XXX | Phase 3: Gap-up + Mean-reversion ライト評価 | Phase 1 |
| KOH-XXX | Phase 4: portfolio 化判断レポート | Phase 2-A, 2-B（Tier 1 揃ってから） |

各 Linear タスクは Done 時に `docs/reports/` 配下のレポートを成果物として紐付ける。

### Paper Trading との並行運用

- credit-spread paper trading 90 日（Phase F、KOH-454 系）と本プロジェクトは独立、並行進行可
- 本プロジェクトは **データ層と backtest コードのみ** を触る（取引層に影響なし）
- Paper trading 結果と Phase 4 portfolio 判断をマージするタイミングは KOH-458 最終評価で

---

## YAGNI 原則による不採用一覧

- **Tier 3（Wheel, VIX contango）の実装** — 理論的に credit-spread と高相関のため除外
- **Monte Carlo シミュレーション** — credit-spread の design でも YAGNI、本プロジェクトでも継続して YAGNI
- **戦略間の動的リバランス（Risk Parity, MVO）** — まずは等資金 / 簡易固定比率で評価
- **Walk-Forward analysis** — 全戦略で WF まで実装するとスコープ膨張
- **HTML/PDF レポート、グラフ画像** — credit-spread と同じく Markdown + CSV のみ
- **ユーザーパラメータ感度分析** — 戦略ごとに 1 set の固定パラメータで評価
- **Survivorship bias 補正** — 既存 universe で評価
- **Tier 2 を pass/fail まで判定** — Tier 2 はライト評価のみ、格上げ判断時に再度フル評価

これらは将来必要になった時点で別タスクで追加。

---

## 終了基準

Phase 4 の `portfolio-correlation-matrix-YYYY-MM-DD.md` に以下が記録された時点で本プロジェクト完了:

- Tier 1 全 3 戦略の相関係数 vs credit-spread
- Tier 2 2 戦略の相関係数 vs credit-spread
- 推奨 portfolio 構成（credit-spread + 補完戦略 0〜2 個）
- portfolio 採用に踏み切るかの judgment（YES / 保留 / NO）

判定結果は KOH-458（最終評価）の input になる。
