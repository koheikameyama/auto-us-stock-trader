# Phase 4: Portfolio 相関分析レポート — 2026-05-01

## 結論

不採用 (credit-spread 単独運用推奨) — どの diversifier も Sharpe / MaxDD の同時改善を達成せず

## 評価期間

- 期間: 2015-01-01 〜 2026-05-01
- 各戦略 initial budget: $3,300
- 評価日数: 2845 営業日
- 総 trade 数: credit-spread=384, dual-momentum=23, pead=242, momentum=888

## 単独メトリクス

| 戦略 | CAGR | Sharpe | Max DD |
|---|---|---|---|
| credit-spread | 11.65% | 0.92 | 19.67% |
| dual-momentum | 7.13% | 0.52 | 33.10% |
| pead | -2.38% | -1.45 | 24.59% |
| momentum | -14.77% | -2.10 | 83.72% |

## 相関行列 (Pearson, 日次リターン)

| | credit-spread | dual-momentum | pead | momentum |
|---|---|---|---|---|
| credit-spread | 1.000 | 0.470 | 0.062 | 0.210 |
| dual-momentum | 0.470 | 1.000 | 0.059 | 0.185 |
| pead | 0.062 | 0.059 | 1.000 | 0.034 |
| momentum | 0.210 | 0.185 | 0.034 | 1.000 |

## 50/50 Portfolio 評価

| 基準 | credit-spread 単独 |
|---|---|
| CAGR | 11.65% |
| Sharpe | 0.92 |
| Max DD | 19.67% |

| Portfolio | CAGR | Sharpe | Max DD | vs CS Sharpe | vs CS MaxDD | 判定 |
|---|---|---|---|---|---|---|
| credit-spread + dual-momentum (50/50) | 9.68% | 0.85 | 21.42% | -0.07 | +1.75% | reject |
| credit-spread + pead (50/50) | 6.86% | 0.87 | 17.36% | -0.05 | -2.31% | reject |
| credit-spread + momentum (50/50) | 5.43% | 0.59 | 19.53% | -0.33 | -0.14% | reject |

判定基準: portfolio Sharpe > credit-spread Sharpe **AND** portfolio MaxDD < credit-spread MaxDD で "candidate"。

## 判定詳細

### credit-spread + dual-momentum (50/50)

- 判定: **棄却**
- 理由: Sharpe -0.07（劣化または同等）、MaxDD +1.75%（拡大または同等）
- Portfolio CAGR 9.68%, Sharpe 0.85, MaxDD 21.42%

### credit-spread + pead (50/50)

- 判定: **棄却**
- 理由: Sharpe -0.05（劣化または同等）、MaxDD 縮小
- Portfolio CAGR 6.86%, Sharpe 0.87, MaxDD 17.36%

### credit-spread + momentum (50/50)

- 判定: **棄却**
- 理由: Sharpe -0.33（劣化または同等）、MaxDD 縮小
- Portfolio CAGR 5.43%, Sharpe 0.59, MaxDD 19.53%


## 次のステップ

- credit-spread 単独で paper-trading 継続
- 本番運用判断 (KOH-459) の input は credit-spread 単独 metrics
- Phase 3 (Tier 2) ライト評価で diversifier 候補を追加検討
