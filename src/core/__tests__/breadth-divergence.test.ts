/**
 * breadth-divergence.ts のユニットテスト（KOH-560）
 */

import { describe, it, expect } from "vitest";
import {
  detectBreadthDivergence,
  BREADTH_DIVERGENCE_PARAMS,
  type BreadthDivergenceResult,
} from "../../core/breadth-divergence";
import type { BreadthHistoryPoint } from "../../core/breadth-history";

// ────────────────────────────────────────────────────────────────────────────
// テスト用ヘルパー
// ────────────────────────────────────────────────────────────────────────────

function makeDays(n: number, startDate = "2024-01-01"): Date[] {
  const start = new Date(startDate);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d;
  });
}

function makeBreadthSeries(
  values: number[],
  startDate = "2024-01-01",
): BreadthHistoryPoint[] {
  return makeDays(values.length, startDate).map((date, i) => ({
    date,
    breadth: values[i],
  }));
}

function makeSpxSeries(
  values: number[],
  startDate = "2024-01-01",
): { date: Date; close: number }[] {
  return makeDays(values.length, startDate).map((date, i) => ({
    date,
    close: values[i],
  }));
}

// ────────────────────────────────────────────────────────────────────────────
// テストケース
// ────────────────────────────────────────────────────────────────────────────

describe("detectBreadthDivergence", () => {
  const LOOKBACK = 5;

  describe("NONE: 指数が高値圏にない場合", () => {
    it("最終値が高値から大きく下落していれば NONE", () => {
      // 高値 100、最終値 90 → 10% 下落（margin 1.5% を大きく超える）
      const spx = makeSpxSeries([95, 98, 100, 96, 90]);
      const breadth = makeBreadthSeries([0.6, 0.62, 0.65, 0.63, 0.60]);

      const result = detectBreadthDivergence(breadth, spx, LOOKBACK);

      expect(result.state).toBe("NONE");
    });
  });

  describe("DIVERGING: 指数が高値圏にあるが breadth が未追随", () => {
    it("指数が高値圏 (1.5%以内) で breadth が下落していれば DIVERGING", () => {
      // 高値 100、最終値 99.5 → 0.5% 差（高値圏内）
      // breadth: 65% → 60% （-5pp 下落 = 未追随）
      const spx = makeSpxSeries([96, 98, 100, 99.8, 99.5]);
      const breadth = makeBreadthSeries([0.65, 0.64, 0.63, 0.61, 0.60]);

      const result = detectBreadthDivergence(breadth, spx, LOOKBACK);

      expect(result.state).toBe("DIVERGING");
      expect(result.breadthTrendPP).toBeCloseTo(-0.05);
      expect(result.sinceDate).not.toBeNull();
    });

    it("breadth が横ばい（変化なし）でも DIVERGING（閾値 = 0pp）", () => {
      const spx = makeSpxSeries([97, 99, 100, 99.5, 99.2]);
      const breadth = makeBreadthSeries([0.62, 0.62, 0.62, 0.62, 0.62]);

      const result = detectBreadthDivergence(breadth, spx, LOOKBACK);

      expect(result.state).toBe("DIVERGING");
    });
  });

  describe("CONFIRMING: 指数高値圏に breadth も追随", () => {
    it("指数が高値圏で breadth が上昇していれば CONFIRMING", () => {
      // 高値 100、最終値 99.8（高値圏内）
      // breadth: 55% → 65% （+10pp 上昇 = 追随）
      const spx = makeSpxSeries([96, 97.5, 99, 99.5, 99.8]);
      const breadth = makeBreadthSeries([0.55, 0.58, 0.60, 0.63, 0.65]);

      const result = detectBreadthDivergence(breadth, spx, LOOKBACK);

      expect(result.state).toBe("CONFIRMING");
    });
  });

  describe("データ不足の場合", () => {
    it("breadth が1件以下なら NONE を返す", () => {
      const spx = makeSpxSeries([100]);
      const breadth = makeBreadthSeries([0.6]);

      const result = detectBreadthDivergence(breadth, spx, LOOKBACK);

      expect(result.state).toBe("NONE");
    });

    it("spx が空なら NONE を返す", () => {
      const breadth = makeBreadthSeries([0.6, 0.62]);

      const result = detectBreadthDivergence(breadth, [], LOOKBACK);

      expect(result.state).toBe("NONE");
    });
  });

  describe("戻り値の構造", () => {
    it("spxHigh / spxLatest / breadthLatest が正しく計算される", () => {
      const spx = makeSpxSeries([95, 100, 99.5, 99.8, 99.7]);
      const breadth = makeBreadthSeries([0.62, 0.64, 0.63, 0.61, 0.60]);

      const result = detectBreadthDivergence(breadth, spx, LOOKBACK);

      expect(result.spxHigh).toBe(100);
      expect(result.spxLatest).toBe(99.7);
      expect(result.breadthLatest).toBeCloseTo(0.60);
    });
  });

  describe("lookback のデフォルト値", () => {
    it("lookback を省略すると BREADTH_DIVERGENCE_PARAMS.LOOKBACK_DAYS が使われる", () => {
      const n = BREADTH_DIVERGENCE_PARAMS.LOOKBACK_DAYS + 5;
      const spx = makeSpxSeries(Array.from({ length: n }, (_, i) => 100 + i));
      const breadth = makeBreadthSeries(
        Array.from({ length: n }, (_, i) => 0.5 + i * 0.01),
      );

      // デフォルト LOOKBACK_DAYS でも例外なく動作すること
      expect(() => detectBreadthDivergence(breadth, spx)).not.toThrow();
    });
  });
});
