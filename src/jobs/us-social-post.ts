/**
 * US 相場局面モニターの SNS 対応（GitHub Actions cron から日次実行）
 *
 * 1. 日次ログ投稿: 「今日の米国株 相場局面 + 確定トレード成績」を1投稿にまとめ、
 *    Bluesky / Threads に公開投稿し、Slack に成否 + X（手動投稿）リンクを通知。
 * 2. 局面変化アラート: 前営業日と当日で局面レベルが変わったら Slack に通知。
 *
 * 公開投稿のフィルタ（public-performance と共通）: 銘柄名・絶対額は出さず % のみ、
 * 末尾に免責を常時付与、売買推奨表現はしない。cred 未設定なら投稿は no-op。
 */

import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import { postToBluesky } from "../lib/bluesky";
import { postToThreads } from "../lib/threads";
import { sendSlack } from "../paper-trading/slack-notifier";
import { PUBLIC_SITE_URL } from "../lib/constants/web";
import {
  detectRegimeShift,
  getLevelEmoji,
  getLevelLabel,
  type BullMarketResult,
} from "../core/regime-shift-detector";
import {
  buildPerformanceSnapshot,
  type PerformanceSnapshot,
  type ClosedTradePerf,
} from "../core/public-performance";

export const DISCLAIMER = "※個人の自動売買システムの記録です。投資助言ではありません";
const MAX_POST_GRAPHEMES = 300;
const PER_TRADE_DETAIL_MAX = 3;
const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

function fmtPct(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}
function mdLabel(dateStr: string): string {
  const [, m, d] = dateStr.split("-").map(Number);
  return `${m}/${d}`;
}
function graphemeCount(text: string): number {
  return [...text].length;
}

function regimeLineOf(r: BullMarketResult): string {
  const breadthPct = (r.current.breadth * 100).toFixed(1);
  const vix = Number.isFinite(r.current.vix) ? r.current.vix.toFixed(1) : "N/A";
  return `${getLevelEmoji(r.level)} ${getLevelLabel(r.level)} ${r.signalCount}/5 ／ breadth ${breadthPct}% ／ VIX ${vix}`;
}

function perTradeLine(t: ClosedTradePerf): string {
  const ret = fmtPct(t.returnPct);
  if (!t.entry) return `└ ${ret}`;
  return `└ ${ret}（${mdLabel(t.entryDate)} ${t.entry.emoji}breadth ${t.entry.breadthPct.toFixed(0)}%で仕込み）`;
}

/** 投稿本文を組み立てる（純関数）。300 grapheme に収める（超えたら明細→サマリーのみに落とす）。 */
export function renderUsSocialPost(
  dayLabel: string,
  regimeLine: string,
  perf: PerformanceSnapshot,
): string {
  const summaryParts: string[] = [];
  if (perf.month) {
    const pf = perf.month.pf;
    const pfStr = pf == null ? "—" : pf === Infinity ? "∞" : pf.toFixed(2);
    summaryParts.push(`今月 ${perf.month.wins}勝${perf.month.losses}敗 PF ${pfStr}`);
  }
  if (perf.cumulativeReturnPct != null) summaryParts.push(`累計 ${fmtPct(perf.cumulativeReturnPct)}`);
  const summaryLine = summaryParts.join(" ／ ");

  const recent = perf.recentClosed.slice(0, PER_TRADE_DETAIL_MAX);

  const assemble = (withDetail: boolean) =>
    [
      `📊 米国株 相場局面ログ ${dayLabel}`,
      "",
      regimeLine,
      ...(withDetail && recent.length > 0 ? ["直近の決済:", ...recent.map(perTradeLine)] : []),
      ...(summaryLine ? [summaryLine] : []),
      "",
      "▼相場局面を毎日チェック",
      PUBLIC_SITE_URL,
      "",
      DISCLAIMER,
    ].join("\n");

  const full = assemble(true);
  return graphemeCount(full) <= MAX_POST_GRAPHEMES ? full : assemble(false);
}

function buildXIntentUrl(text: string): string {
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
}

/** 日次 SNS 投稿を実行し、Slack に成否 + X リンクを通知する。 */
export async function runDailySocialPost(regime: BullMarketResult): Promise<void> {
  const now = new Date();
  const dayLabel = `${dayjs(now).format("M/D")}(${WEEKDAY_JA[dayjs(now).day()]})`;
  const perf = await buildPerformanceSnapshot();
  const text = renderUsSocialPost(dayLabel, regimeLineOf(regime), perf);

  console.log("--- SNS 投稿内容 ---\n" + text + "\n----------------");

  type PostState = "posted" | "skipped" | "failed";
  const label: Record<PostState, string> = {
    posted: "投稿しました ✅",
    skipped: "未設定で skip ⏭️",
    failed: "失敗 ❌",
  };
  const [bsky, threads] = await Promise.all([
    postToBluesky(text).then(
      (p): PostState => (p ? "posted" : "skipped"),
      (e): PostState => { console.error("Bluesky 投稿失敗:", e); return "failed"; },
    ),
    postToThreads(text).then(
      (p): PostState => (p ? "posted" : "skipped"),
      (e): PostState => { console.error("Threads 投稿失敗:", e); return "failed"; },
    ),
  ]);

  // 両方 cred 未設定（=何も投稿していない）なら Slack へは通知しない（誤送信・ノイズ防止）
  if (bsky === "skipped" && threads === "skipped") {
    console.log("SNS cred 未設定のため投稿スキップ。Slack 通知も送りません。");
    return;
  }

  const xUrl = buildXIntentUrl(text);
  const anyFailed = bsky === "failed" || threads === "failed";
  await sendSlack({
    level: anyFailed ? "warn" : "info",
    text: [
      "🦋 Bluesky / 🧵 Threads 日次投稿",
      `Bluesky: ${label[bsky]}`,
      `Threads: ${label[threads]}`,
      "",
      `📱 X 手動投稿: <${xUrl}|タップして下書きを開く>`,
    ].join("\n"),
  });
}

/** 前営業日と当日で局面レベルが変わっていれば Slack に通知する（状態を持たない比較）。 */
export async function runRegimeChangeAlert(today: BullMarketResult): Promise<void> {
  const yesterday = await detectRegimeShift({
    asOfDate: dayjs().subtract(1, "day").toDate(),
  });
  // データが更新されておらず同じ基準日を見ている場合は変化なし扱い
  if (today.asOfDate.getTime() === yesterday.asOfDate.getTime()) return;
  if (today.level === yesterday.level) return;

  await sendSlack({
    level: "info",
    text: [
      "📶 米国株の相場局面が変化しました",
      `${getLevelEmoji(yesterday.level)} ${getLevelLabel(yesterday.level)} ${yesterday.signalCount}/5` +
        ` → ${getLevelEmoji(today.level)} ${getLevelLabel(today.level)} ${today.signalCount}/5`,
      regimeLineOf(today),
      PUBLIC_SITE_URL,
    ].join("\n"),
  });
  console.log(`局面変化: ${yesterday.level} → ${today.level}`);
}

export async function main() {
  const today = await detectRegimeShift({ asOfDate: new Date() });
  // 局面変化アラート（失敗しても投稿は続行）
  await runRegimeChangeAlert(today).catch((e) => console.error("regime-change-alert 失敗:", e));
  // 日次 SNS 投稿
  await runDailySocialPost(today);
}

const isDirectRun = process.argv[1]?.includes("us-social-post");
if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("us-social-post エラー:", error);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
