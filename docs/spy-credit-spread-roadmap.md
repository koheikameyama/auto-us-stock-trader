# SPY Credit Spread 本番投入ロードマップ

最終更新: 2026-05-24

## 現状サマリ

- ✅ backtest 設計済（[src/backtest/us/us-credit-spread-*](../src/backtest/us/), walk-forward 27 通り）
- ✅ paper-trading 稼働中（[src/paper-trading/](../src/paper-trading/)、Alpaca paper）
- ✅ Alpaca US Live 開設済（2026/05）
- ✅ IBKR (IBSJ) 口座開設済（2026/05）
- ❌ Alpaca Options Level 3 未承認（申請者は options 未経験）
- ❌ IBKR (IBSJ) options 取引承認 未承認の可能性大（Phase 4 まで保留）
- ❌ live vs backtest 乖離レポート未着手
- ❌ IV skew / slippage の backtest 反映未実装

**broker 方針**: **Alpaca 主軸（取引）+ IBKR 両替所（入金経路）の併用**。
- 取引・API 連携: Alpaca 一本（Phase 2-3）
- JPY → USD 入金: IBSJ で内部両替 → Alpaca へ USD wire
- Phase 4 で IBKR を取引メインに移行

**律速**: broker 選定より **「options 経験形成」と「backtest 信頼性」**。

## Phase 定義

| Phase | 状態 | 規模 | 主証券 |
|---|---|---|---|
| 1.0 | backtest 設計 | n/a | n/a |
| **1.5** | **paper-trading 稼働（現在地）** | $3,300 paper | Alpaca paper |
| 2.0 | live "smoke test" | **1 contract、max loss ≤ $400** | Alpaca live |
| 3.0 | 小ロット live | 2〜3 contracts、口座 $10〜30k | Alpaca live (L3 必要) |
| 4.0 | スケール運用 | 口座 $50k+、レバレッジ活用 | IBKR に移行 |

**Phase 移行はカレンダー駆動ではなくゲート駆動**。下記ゲートを満たして初めて次 Phase。

## Live 移行ゲート（Phase 1.5 → 2.0）

下記 **全条件達成** で Phase 2 開始可。

1. paper-trading の実 fill credit と backtest credit の乖離が **直近 8 週で < 10%**
2. **IV skew と slippage を backtest に織り込んだ** walk-forward が依然 edge 正（Sharpe / CAGR が改修前から大幅劣化していない）
3. paper の DD が想定（DD hard stop 15%）内に収まる確認 - 期間中に **VIX 25 超のスパイク 1 回以上** を含む
4. **Options Agreement 起因の安全装置 3 件** がコードに実装され、paper-trading で動作確認済み（次節「Alpaca Options Agreement リスク対策」参照）

### Phase 2 → 3 ゲート

- Phase 2 で **最低 30 spreads** の live fill 履歴
- live PnL の期待値が backtest 期待値の **80% 以上**
- max loss 事象が発生した場合、想定通り max loss で止まったこと（システムが死ななかった）

### Phase 3 → 4 ゲート

- 口座価値が IBKR Portfolio Margin 最低基準（$110k）到達
- Phase 3 の年間 Sharpe ≥ 1.0
- IBKR への broker 抽象化リファクタ完了

## Alpaca Options Agreement リスク対策

[Alpaca Securities Customer Options Agreement (V1.2024.02)](https://files.alpaca.markets/disclosures/library/ALPACA+SECURITIES+LLC++OPTIONS+AGREEMENT.pdf) には credit spread 自動運用に直撃する条項がある。Phase 2 移行前に以下 3 件をコードと運用に組み込む。

### 1. Expiry 前強制クローズ（Sec 6 対策）

**問題**: Agreement Sec 6 で「資金不足判定時に Alpaca は OCC に対し long put を行使させない指示が可能」。
short put が assigned されながら long put が discarded されると、defined-risk のはずが short stock の unlimited 損失に転化する。

**対策**:
- **expiry 5 営業日前に全 OPEN spread を強制クローズ** （現状の 21-DTE rule より厳しい）
- [src/backtest/credit-spread/spread-evaluator.ts](../src/backtest/credit-spread/spread-evaluator.ts) と paper-trading の close logic に閾値追加
- 設定: `forcedCloseDaysBeforeExpiry: 5`（USCreditSpreadBacktestConfig に追加）

### 2. Self Kill-switch を Alpaca margin call より先に発動（Sec 10 対策）

**問題**: Sec 10「margin call 未対応時、**通知なし** で Alpaca が強制決済可能」。flash crash で最悪のタイミングで切られるリスク。

**対策**:
- 現状 DD hard stop 15% → **10% で self kill-switch 発動** に引き下げ
- 一気に切らず、段階的に: DD 10% → 新規 entry 停止、DD 12% → 全 spread 強制クローズ
- margin 余力は常に collateral の **150% 以上** を維持（現金担保 buffer）
- 設定: `selfKillSwitchDDThreshold: 0.10` / `selfKillSwitchHardCloseDDThreshold: 0.12`

### 3. TOS 月次確認の運用化（Sec 18(e) 対策）

**問題**: Sec 18(e)「Alpaca は予告なく規約を変更可能、継続使用で同意とみなす」。

**対策**:
- 月初の運用 checklist に **「Options Agreement の更新有無確認」** を追加
- スクリプト化: PDF を月初に取得 → SHA256 ハッシュ比較 → 変更検知で Slack 通知
- 配置: `scripts/paper-trading/check_tos_updates.py`

### その他、運用上の留意点

| Section | 内容 | 運用対応 |
|---|---|---|
| Sec 7 | expiry 当日は新規 opening が制限され得る | 強制クローズを expiry 当日でなく **5 営業日前** に前倒し（Sec 6 対策と兼用） |
| Sec 9 | minimum equity 要件を予告なく変更可能 | 月次 TOS 確認で検知（Sec 18(e) 対策と兼用） |
| Sec 11 | PFOF あり、約定品質が NBBO 劣後の可能性 | live vs backtest 乖離レポートで継続監視 |
| Sec 14(d) | vol spike 中の execution 不全は免責 | self kill-switch で先に降りる前提（Sec 10 対策と兼用） |
| Sec 17 | 紛争は FINRA DR 仲裁のみ、日本での提訴不可 | **Phase 2 規模を 1 contract / max loss $400 に厳守**（争いに行けない前提でサイズ管理） |

## 証券会社の役割分担: Alpaca 主軸 + IBKR 両替所

### 全 Phase 共通の運用構造

```
[ JPY 銀行口座 ]
        │ JPY 入金（無料 or 数百円）
        ↓
[ IBSJ (IBKR) ] ── JPY → USD 内部両替（spot + 0.0002 ≒ ゼロ）
        │ USD wire（月1回まで無料、以降 $10-25/件）
        ↓
[ Alpaca US ] ── credit spread 自動取引（既存実装）
```

### フェーズ別主証券（取引面）

| Phase | 取引 broker | 入金経路 | 理由 |
|---|---|---|---|
| 1.5 | Alpaca paper | n/a | 既に稼働中、API シンプル |
| 2.0 | Alpaca live | IBSJ → Alpaca | 既存実装そのまま、L3 承認後即開始 |
| 3.0 | Alpaca live | IBSJ → Alpaca | API DX、low overhead |
| 4.0 | **IBKR に移行** | 直接 IBKR 入金 | Portfolio Margin / Box Spread Loan 活用 |

戦略の核: **「Alpaca で Phase 2-3 を完走 → Phase 4 で IBKR 取引に移行」**。IBKR の口座は Phase 1.5 から **両替所として常用**。

### Alpaca を取引主軸にした理由

1. **既存実装が完成**: [order-manager.ts](../src/paper-trading/order-manager.ts)、[alpaca-client.ts](../src/paper-trading/alpaca-client.ts) で multi-leg credit spread が動作中
2. **API DX**: REST + Bearer token、サーバレス可、SDK 公式メンテ
3. **承認 turnaround**: L2 申請の応答が数日〜1 週間と速い
4. **IBKR API の運用負荷**: TWS/IB Gateway 常時起動、daily 23:45 ET 再起動、週次 2FA、ib_insync 依存などが Phase 4 規模になるまでは投資 ROI が薄い

### IBKR を「両替所」として使う理由

- **IBSJ の JPY → USD 内部両替が実質ゼロコスト**（spot + 0.0002 円程度）
- **直接 SWIFT 入金より $100〜1,200 安い**（規模次第、後述）
- **IBKR の月 1 回まで無料送金枠**で wire 手数料も実質ゼロ
- **取引面では IBKR API を一切触らない** → 運用負荷増加なし（GUI で月 1 回両替＆送金するのみ）

### Alpaca vs IBKR 比較表

| 項目 | Alpaca US | IBKR (IBSJ) |
|---|---|---|
| 口座開設 | ✅ Live 済 (2026/05) | ✅ 済 (2026/05) |
| Options 取引承認 | ❌ Level 3 未承認 | ❌ 未承認の可能性大 |
| Portfolio Margin | ❌ Reg-T のみ | ✅ あり（$110k+） |
| Box Spread Loan | ❌ | ✅ 4〜5% で資金調達可 |
| Multi-leg API | ✅ シンプル（REST、JSON） | △ TWS/IB Gateway 必須、複雑 |
| Commission | $0.65/contract | $0.65/contract（tier 制で逓減） |
| 円→USD 入金 | △ 外部送金、手数料あり | ✅ 内部両替、効率良 |
| 既存実装 | ✅ [alpaca-client.ts](../src/paper-trading/alpaca-client.ts) 完成 | ❌ 未着手 |
| 想定運用 Phase | 1.5〜3 | 4（必要なら 2 の代替） |

### コード上の負債

両替所運用では **コード変更ゼロ**（IBKR 側は手動 GUI のみ）。Phase 4 で IBKR を取引主軸にする際に以下が発生:

- broker interface 定義（中規模リファクタ、実 2〜4 週）
- `Position` / `TradingOrder` スキーマに broker 列追加
- 移行期 2〜4 週の並走運用

**Phase 4 移行時にまとめてやる** 方針。Phase 2/3 で IBKR を fallback に使う場合は最小限の wrapper を書く。

## 入金フロー（Phase 1.5〜3）

### 月次運用

```
[月初]
1. 日本の銀行から IBSJ JPY 口座へ国内振込
   - 振込料: 無料（同行内）or 数百円
2. IBSJ 内で JPY → USD 両替
   - レート: spot + 0.0002 円程度（実質ゼロ）
   - 所要: リアルタイム
3. IBSJ USD → Alpaca へ USD wire
   - IBKR 月 1 回まで無料、以降 $10〜25/件
   - Alpaca 側 incoming: 無料（中継銀行手数料は OUR 指定で sender 負担）
   - 所要: 1〜2 営業日
```

### コスト試算

| 入金経路 | $10k 入金コスト | $30k 入金コスト | $100k 入金コスト |
|---|---|---|---|
| 直接 SWIFT（megabank → Alpaca） | $100-150 | $250-400 | $750-1,200 |
| **IBSJ 両替経由（月 1 回無料枠内）** | **¥0-数千** | **¥0-数千** | **¥0-数千** |
| Wise USD 経由 | $45-55 | $135-165 | $450-550 |

**月 1 回に絞れば実質ゼロコスト**。複数回必要なら 2 回目以降 $10-25/件。

### 要確認事項

- IBSJ の「月 1 回無料送金枠」が公式に有効か（申込規約で要確認）
- Alpaca 側で incoming wire が中継銀行手数料を取られないか（取られる場合は OUR 指定で sender 全負担）
- Alpaca の "third-party transfer" ポリシー（IBSJ 名義は本人名義扱いで通常問題ないはずだが、初回は確認推奨）

## Alpaca Options Level 3 申請戦略

**前提**: 申請者は options 未経験。即 L3 申請は reject 確率高。

### 3段戦略

```
2026/05-06 ── Level 2 申請（long option のみ、未経験で通る）
             │
2026/06-07 ── Alpaca L2 内で long SPY put/call を 10〜20 回取引
             │   ※ 投機ではなく履歴形成。少額（1 contract、$30〜100 損失上限）
             │   ※ long call / long put 両方、異なる DTE で意図的に分散
             │
2026/08    ── Level 3 再申請（経験ありを明示）
             │
2026/09    ── L3 承認 想定（90% 程度）
```

期間ロス: **2〜3 ヶ月**。即 L3 申請して reject 履歴をつけるリスクを回避。

### Fallback: L3 が 2026/10 までに通らない場合

優先順:

1. **A**. L3 再々申請（追加履歴 + Alpaca サポート問い合わせ）
2. **B**. IBKR (IBSJ) で options 承認を申請、IBKR ルートで Phase 2 開始
   - IBKR 用最小 wrapper 実装（実 2〜4 週のリファクタ）
3. **C**. 履歴形成期間をさらに 3〜6 ヶ月延長 → 再申請

最低でも **B が現実的なバックアップ** として機能するよう、IBKR 口座は維持する。

## 本格運用までのロードマップ

```
2026/05 [今] ── Phase 1.5（paper-trading 稼働中）
              │
              ├─ Alpaca Level 2 申請（即日）
              ├─ live vs backtest 乖離レポート開始
              ├─ IV skew / slippage backtest 改修着手
              │
2026/06-07 ── Alpaca L2 内で long option 履歴形成（10〜20 回）
              │
2026/08    ── Alpaca Level 3 再申請
              │
2026/09    ── L3 承認想定 / Phase 2 ゲート再評価
              │
2026/10    ── 【Phase 2.0 開始想定】1 contract smoke test
              │
2026/Q4-2027/Q1 ── Phase 3.0 移行ゲート評価
              │
2027/Q2-Q3 ── Phase 4.0 移行検討（IBKR Portfolio Margin）
```

**カレンダーは目安**。各 Phase 移行はゲート達成が条件。

### Phase 2 前倒し / 後ろ倒し条件

- **前倒し（〜2026/Q3）**: 履歴形成短縮（10 → 5 回）+ 検証ゲート早期達成の同時成立が必要
- **後ろ倒し（〜2027/Q1）**: Alpaca L3 が reject、Fallback B (IBKR) ルートに切替えで実装コスト分遅延

## 本番投入に向けた残作業（優先順）

### 即時（今日〜今週）

1. **Alpaca Options Level 2 申請**（即日完了可）
2. **IBSJ → Alpaca 送金テスト**（$1,000 程度で一往復）
   - 確認項目: 所要日数、中継銀行手数料の有無、Alpaca KYC 追加要求の有無、月 1 回無料枠の動作
   - L3 承認 / 本番投入の直前に詰まらないよう、今のうちに実測
3. **live vs backtest 乖離レポート** のスクリプト着手
   - 目的: paper-trading の実 fill credit を DB から集計、同期間の backtest credit と比較
   - 出力: 週次の乖離率 + 原因切り分け
   - 配置: `scripts/paper-trading/diff_report.py` or `src/paper-trading/diff-report.ts`

### 短期（〜2026/06）

4. **IV skew 簡易モデルを backtest に追加**
   - OTM 1σ ごとに IV +2〜3pt のオフセット
   - [src/core/options-pricing.ts](../src/core/options-pricing.ts) に skew 関数追加、`signal-generator.ts` で使用
5. **slippage モデルを backtest に追加**
   - entry credit × 0.95 or − $0.05 fixed のうち保守的な方
   - `signal-generator.ts` の `estimatedCredit` で減算
6. **long option 履歴形成開始**（Alpaca L2 で SPY long put/call、少額、10〜20 回）

### 中期（〜2026/08）

7. **walk-forward 再実行**（IV skew / slippage 反映後）
   - 全 27 パラメータ組み合わせで edge 維持を確認
   - edge 消失パラメータがあれば config から除外
8. **stress test シナリオ追加**
   - 2018-02、2020-03、2022-Q4、2024-08 の vol spike 期間で個別検証
   - DD hard stop が機能することを確認
9. **Alpaca Level 3 再申請**

### Options Agreement 起因（Phase 2 開始前に必須）

10. **Expiry 5 営業日前の強制クローズ実装**（Sec 6 対策）
    - [src/backtest/credit-spread/spread-evaluator.ts](../src/backtest/credit-spread/spread-evaluator.ts) と paper-trading の close logic に `forcedCloseDaysBeforeExpiry: 5` 追加
    - paper-trading で 1 サイクル動作確認
11. **Self kill-switch 強化**（Sec 10 対策）
    - DD threshold を 15% → 10%(entry stop) / 12%(hard close) に二段化
    - margin 余力 150% buffer のチェック追加
    - [src/paper-trading/kill-switch.ts](../src/paper-trading/kill-switch.ts) に実装
12. **TOS 月次確認スクリプト**（Sec 18(e) 対策）
    - `scripts/paper-trading/check_tos_updates.py` 作成
    - PDF ハッシュ比較 → Slack 通知
    - GitHub Actions で月初実行

### Phase 2 開始時

13. **smoke test 運用フロー固定**（kill-switch、Slack 通知、daily diff）
14. **L3 reject 時の fallback パス**（IBKR 移行手順を doc 化、コードは reject 時に着手）

## レバレッジロードマップ

| Phase | レバレッジ手段 | 想定タイミング |
|---|---|---|
| 1.5〜3 | レバレッジなし、現金担保のみ | 〜2027/Q1 |
| 4.0〜 | IBKR Portfolio Margin | 2027/Q2〜 |
| 4.0〜 | IBKR Box Spread Loan で低金利資金調達（4〜5%、Reg-T margin loan より安価） | 2027/Q2〜 |

### Portfolio Margin 要件

- 口座価値 **$110k 以上**（IBSJ 同条件）
- 過去の取引履歴・経験確認あり
- Phase 3 で実績を積んでから検討

### Box Spread Loan

- SPX/SPY の deep ITM/OTM call spread で資金調達（Treasury 同等の金利）
- IBKR の Portfolio Margin と併用で資本効率最大化
- 実例: `SPX 1Y box spread @ SOFR + 25bps` で借入可

---

## 次にやること（推奨アクション）

| いつ | 何を | 理由 |
|---|---|---|
| **今日** | Alpaca Options Level 2 申請 | L3 取得への第一歩、即日完了可 |
| **今週** | IBSJ → Alpaca 送金テスト（$1,000） | 入金経路を本番前に実測、月 1 無料枠の動作確認 |
| **今週** | live vs backtest 乖離レポートのスクリプト着手 | Phase 2 ゲートのデータ収集を即時開始 |
| **〜2026/06** | IV skew / slippage を backtest に反映 | Phase 2 ゲート #2 達成の前提 |
| **〜2026/06** | Options Agreement 対策 3 件（強制クローズ・kill-switch・TOS 監視） | Phase 2 ゲート #4 達成の前提 |
| **2026/06-07** | Alpaca L2 で long option 取引履歴形成（10〜20 回） | L3 承認確率向上 |
| **2026/08** | Alpaca Level 3 再申請 | 経験ありで再挑戦 |
| **L3 承認後** | Phase 2.0 smoke test 開始（1 contract） | 本格 live への第一歩 |

---

## 関連ドキュメント

- [README.md](../README.md) - リポ概要
- [docs/paper-trading-operations.md](paper-trading-operations.md) - paper-trading 運用
- [docs/database-schema.md](database-schema.md) - DB スキーマ
- [docs/plans/2026-04-30-paper-trading-design.md](plans/2026-04-30-paper-trading-design.md) - paper-trading 設計
