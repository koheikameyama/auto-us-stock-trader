/**
 * Black-Scholes オプション価格計算
 *
 * 外部依存なし。累積正規分布は Abramowitz & Stegun 近似を使用。
 * Wheel戦略バックテストで使用。将来的に日本株オプションにも対応可能。
 */

/** 累積正規分布 N(x) — Abramowitz & Stegun 7.1.26 近似 */
function cdf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);

  return 0.5 * (1.0 + sign * y);
}

function calcD1(S: number, K: number, T: number, r: number, sigma: number): number {
  return (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
}

function calcD2(d1: number, sigma: number, T: number): number {
  return d1 - sigma * Math.sqrt(T);
}

/** コールオプション価格 */
export function bsCallPrice(S: number, K: number, T: number, r: number, sigma: number): number {
  if (T <= 0 || sigma <= 0) return Math.max(0, S - K);
  const d1 = calcD1(S, K, T, r, sigma);
  const d2 = calcD2(d1, sigma, T);
  return S * cdf(d1) - K * Math.exp(-r * T) * cdf(d2);
}

/** プットオプション価格 */
export function bsPutPrice(S: number, K: number, T: number, r: number, sigma: number): number {
  if (T <= 0 || sigma <= 0) return Math.max(0, K - S);
  const d1 = calcD1(S, K, T, r, sigma);
  const d2 = calcD2(d1, sigma, T);
  return K * Math.exp(-r * T) * cdf(-d2) - S * cdf(-d1);
}

/**
 * Put IV に skew を適用する（equity put skew の線形近似）。
 *
 * OTM が深い put ほど IV が高い、という現実の skew を再現する。
 * credit spread では long（深 OTM）の IV が short より高くなり、フラット IV より
 * クレジットが薄くなる。backtest の忠実度向上用（live は skewSlope 未指定で無効）。
 *
 * @param baseIv ATM 基準 IV（例 VIX/100）
 * @param spot 現在株価
 * @param strike 対象 strike
 * @param skewSlope skew の傾き（0/負=無効、正で OTM ほど IV↑）
 */
export function skewedPutIv(baseIv: number, spot: number, strike: number, skewSlope: number): number {
  if (!skewSlope || skewSlope <= 0 || spot <= 0) return baseIv;
  const otm = Math.max((spot - strike) / spot, 0); // put の OTM 度合い（0〜）
  return baseIv * (1 + skewSlope * otm);
}

/** コールデルタ: 0〜1 */
export function bsCallDelta(S: number, K: number, T: number, r: number, sigma: number): number {
  if (T <= 0 || sigma <= 0) return S >= K ? 1 : 0;
  const d1 = calcD1(S, K, T, r, sigma);
  return cdf(d1);
}

/** プットデルタ: -1〜0 */
export function bsPutDelta(S: number, K: number, T: number, r: number, sigma: number): number {
  if (T <= 0 || sigma <= 0) return S <= K ? -1 : 0;
  const d1 = calcD1(S, K, T, r, sigma);
  return cdf(d1) - 1;
}

/**
 * 目標デルタに最も近いストライク価格を探索
 *
 * @param spotPrice 現在の株価
 * @param targetDelta 目標デルタ（プットなら負値 e.g. -0.20、コールなら正値 e.g. 0.30）
 * @param tte 満期までの時間（年）
 * @param riskFreeRate 無リスク金利
 * @param iv インプライドボラティリティ（年率）
 * @param optionType "put" | "call"
 * @param strikeStep ストライク刻み（デフォルト $0.50）
 */
export function findStrikeForTargetDelta(params: {
  spotPrice: number;
  targetDelta: number;
  tte: number;
  riskFreeRate: number;
  iv: number;
  optionType: "put" | "call";
  strikeStep?: number;
}): { strike: number; delta: number; premium: number } {
  const { spotPrice, targetDelta, tte, riskFreeRate, iv, optionType, strikeStep = 0.5 } = params;

  const deltaFn = optionType === "put" ? bsPutDelta : bsCallDelta;
  const priceFn = optionType === "put" ? bsPutPrice : bsCallPrice;

  // プット: spotから下へ探索、コール: spotから上へ探索
  const direction = optionType === "put" ? -1 : 1;
  const startK = Math.round(spotPrice / strikeStep) * strikeStep;

  let bestStrike = startK;
  let bestDelta = deltaFn(spotPrice, startK, tte, riskFreeRate, iv);
  let bestDiff = Math.abs(bestDelta - targetDelta);

  for (let i = 1; i <= 200; i++) {
    const K = startK + direction * i * strikeStep;
    if (K <= 0) break;

    const delta = deltaFn(spotPrice, K, tte, riskFreeRate, iv);
    const diff = Math.abs(delta - targetDelta);

    if (diff < bestDiff) {
      bestDiff = diff;
      bestStrike = K;
      bestDelta = delta;
    }

    // 目標を通り過ぎたら終了
    if (optionType === "put" && delta > targetDelta && delta > bestDelta) break;
    if (optionType === "call" && delta < targetDelta && delta < bestDelta) break;
  }

  const premium = priceFn(spotPrice, bestStrike, tte, riskFreeRate, iv);

  return {
    strike: Math.round(bestStrike * 100) / 100,
    delta: Math.round(bestDelta * 10000) / 10000,
    premium: Math.round(premium * 100) / 100,
  };
}
