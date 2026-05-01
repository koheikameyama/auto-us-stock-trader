export type Level = "info" | "warn" | "error" | "critical";

export interface SlackMessage {
  text: string;
  level: Level;
}

const COLOR: Record<Level, string> = {
  info: "good",
  warn: "warning",
  error: "danger",
  critical: "danger",
};

export async function sendSlack(msg: SlackMessage): Promise<void> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  const prefix =
    msg.level === "critical"
      ? "<!channel> 🚨 "
      : msg.level === "error"
        ? "❌ "
        : msg.level === "warn"
          ? "⚠️ "
          : "✅ ";
  // トップレベル text は通知センター/モバイル push のプレビュー用に短くする。
  // 本文（multi-line）は attachments[].text のみに置く（ここで両方フルにすると Slack が二重に表示する）。
  const previewLine = msg.text.split("\n")[0].replace(/\*/g, "");
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: prefix + previewLine,
        attachments: [{ color: COLOR[msg.level], text: msg.text, mrkdwn_in: ["text"] }],
      }),
    });
  } catch {
    // best-effort: do not let notification failure crash the runner
  }
}

function fmtMoney(n: number, opts: { signed?: boolean } = {}): string {
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (opts.signed) return `${n >= 0 ? "+" : "-"}$${abs}`;
  return `${n < 0 ? "-" : ""}$${abs}`;
}

function fmtMoneyInt(n: number, opts: { signed?: boolean } = {}): string {
  const abs = Math.round(Math.abs(n)).toLocaleString("en-US");
  if (opts.signed) return `${n >= 0 ? "+" : "-"}$${abs}`;
  return `${n < 0 ? "-" : ""}$${abs}`;
}

// ─── Event-line formatters (short, one line; bundled into Daily Summary) ───

export function formatEntrySuccess(p: {
  shortStrike: number;
  longStrike: number;
  expiry: string;
  filledCredit: number | null;
}): string {
  return `*ENTRY* SPY ${p.shortStrike}/${p.longStrike} · exp ${p.expiry} · credit *${fmtMoney(p.filledCredit ?? 0)}*`;
}

export function formatCloseSuccess(p: {
  shortStrike: number;
  longStrike: number;
  reason: string;
  netPnl: number | null;
  daysHeld: number;
}): string {
  return `*CLOSE* (${p.reason}) SPY ${p.shortStrike}/${p.longStrike} · P&L *${fmtMoney(p.netPnl ?? 0, { signed: true })}* · ${p.daysHeld}d`;
}

export function formatExpire(p: {
  shortStrike: number;
  longStrike: number;
  reason: string;
  netPnl: number | null;
}): string {
  return `*EXPIRED* (${p.reason}) SPY ${p.shortStrike}/${p.longStrike} · P&L *${fmtMoney(p.netPnl ?? 0, { signed: true })}*`;
}

export function formatEntrySkip(
  reason: string,
  ctx: { spy: number; vix: number; sma50?: number | null },
): string {
  const sma = ctx.sma50?.toFixed(2) ?? "n/a";
  return `*SKIP* (${reason}) SPY=${ctx.spy} VIX=${ctx.vix.toFixed(2)} SMA50=${sma}`;
}

// ─── Standalone alerts (multi-line; sent on their own) ───

export function formatDDStop(
  action: "ACTIVATED" | "DEACTIVATED",
  peak: number,
  equity: number,
): string {
  const dd = ((1 - equity / peak) * 100).toFixed(2);
  return [
    `*DD stop ${action}*`,
    `• Peak    ${fmtMoneyInt(peak)}`,
    `• Equity  ${fmtMoneyInt(equity)}`,
    `• DD      *${dd}%*`,
  ].join("\n");
}

export function formatErrorAlert(
  category: string,
  message: string,
  ctx?: object,
): string {
  const lines = [`*${category}*`, message];
  if (ctx) lines.push(`ctx: \`${JSON.stringify(ctx)}\``);
  return lines.join("\n");
}

export function formatKillSwitch(reason: string): string {
  return [`*Kill switch active*`, `Reason: ${reason}`].join("\n");
}

export function formatDuplicateOrder(detail: string): string {
  return [`*Duplicate order detected*`, detail].join("\n");
}

// ─── Daily summary header + events list ───

export function formatDailySummary(s: {
  date: string;
  openCount: number;
  equity: number;
  dailyPnl: number;
  events?: string[];
}): string {
  const head = [
    `*📊 Daily Summary* — ${s.date}`,
    `• Equity   *${fmtMoneyInt(s.equity)}*  (Δ ${fmtMoney(s.dailyPnl, { signed: true })})`,
    `• Open     ${s.openCount}`,
  ].join("\n");
  if (!s.events || s.events.length === 0) return `${head}\n\n_No events today._`;
  const events = s.events.map((e) => `• ${e}`).join("\n");
  return `${head}\n\n*Events*\n${events}`;
}
