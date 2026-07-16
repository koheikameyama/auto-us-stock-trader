/**
 * cron-job.org にスケジュールを登録/更新する。
 *
 * Usage:
 *   set -a; source .env; set +a
 *   npx tsx scripts/setup-cron-job.ts
 *
 * 動作:
 *   - 同じ title の job があれば PATCH で更新、なければ PUT で新規作成
 *   - GitHub Actions の workflow を workflow_dispatch で起動
 *   - スケジュールはタイムゾーン America/New_York 指定（DST 自動追従）
 *
 * 必要な env:
 *   CRONJOB_API_KEY    cron-job.org の API key
 *   GITHUB_PAT         workflow:write 権限を持つ GitHub Personal Access Token
 *   GITHUB_REPO        "owner/repo"。未設定なら git remote から推測
 *   GITHUB_REF         ブランチ名。デフォルト "main"
 */

import { execSync } from "node:child_process";

const CRONJOB_BASE = "https://api.cron-job.org";

interface ScheduleSpec {
  hours: number[];
  minutes: number[];
  /** 1=Mon ... 5=Fri */
  wdays: number[];
}

interface JobSpec {
  /** cron-job.org 上での識別タイトル（idempotency キーとして使う） */
  title: string;
  /** 起動する GitHub workflow ファイル名 */
  workflowFile: string;
  /** スケジュール（タイムゾーンは America/New_York 固定）*/
  schedule: ScheduleSpec;
}

const JOBS: JobSpec[] = [
  {
    title: "auto-us-stock-trader paper-trading daily",
    workflowFile: "paper-trading-daily.yml",
    // NY 10:00 平日。寄り直後 (09:30-09:45) は spread が広く quote が荒れて
    // limit が touch されにくいので、opening rotation を避けて 30 分後に発注。
    schedule: { hours: [10], minutes: [0], wdays: [1, 2, 3, 4, 5] },
  },
  {
    title: "auto-us-stock-trader us-daily backfill",
    workflowFile: "us-daily.yml",
    schedule: { hours: [18], minutes: [0], wdays: [1, 2, 3, 4, 5] }, // NY 18:00 平日（market close 後 2h、yfinance 反映に余裕）
  },
  {
    title: "auto-us-stock-trader us-social-post daily",
    workflowFile: "us-social-post.yml",
    // NY 18:30 平日。us-daily backfill（18:00 開始・3〜7 分）の完了後に置く。
    // 局面は DB にある最新足で判定するため、backfill 前に投稿すると前日分を出してしまう。
    schedule: { hours: [18], minutes: [30], wdays: [1, 2, 3, 4, 5] },
  },
];

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function detectRepo(): string {
  if (process.env.GITHUB_REPO) return process.env.GITHUB_REPO;
  const url = execSync("git remote get-url origin", { encoding: "utf8" }).trim();
  const m = /github\.com[:/]([^/]+)\/([^/.]+)/.exec(url);
  if (!m) throw new Error(`Could not parse owner/repo from remote: ${url}`);
  return `${m[1]}/${m[2]}`;
}

interface CronJobJob {
  jobId: number;
  title: string;
  enabled: boolean;
  url: string;
}

async function listJobs(apiKey: string): Promise<CronJobJob[]> {
  const res = await fetch(`${CRONJOB_BASE}/jobs`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`cron-job.org list failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { jobs: CronJobJob[] };
  return data.jobs ?? [];
}

interface BuildArgs {
  spec: JobSpec;
  repo: string;
  ref: string;
  githubPat: string;
}

function buildJobBody({ spec, repo, ref, githubPat }: BuildArgs) {
  return {
    job: {
      url: `https://api.github.com/repos/${repo}/actions/workflows/${spec.workflowFile}/dispatches`,
      enabled: true,
      title: spec.title,
      saveResponses: true,
      requestMethod: 1, // POST
      schedule: {
        timezone: "America/New_York",
        hours: spec.schedule.hours,
        minutes: spec.schedule.minutes,
        mdays: [-1],
        months: [-1],
        wdays: spec.schedule.wdays,
      },
      extendedData: {
        headers: {
          Authorization: `Bearer ${githubPat}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          "User-Agent": "cron-job.org auto-us-stock-trader",
        },
        body: JSON.stringify({ ref }),
      },
    },
  };
}

async function createJob(apiKey: string, body: object): Promise<number> {
  const res = await fetch(`${CRONJOB_BASE}/jobs`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { jobId: number };
  return data.jobId;
}

async function updateJob(apiKey: string, jobId: number, body: object): Promise<void> {
  const res = await fetch(`${CRONJOB_BASE}/jobs/${jobId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`update failed: ${res.status} ${await res.text()}`);
}

async function main() {
  const cronJobApiKey = requireEnv("CRONJOB_API_KEY");
  const githubPat = requireEnv("GITHUB_PAT");
  const repo = detectRepo();
  const ref = process.env.GITHUB_REF ?? "main";

  console.log(`Repo: ${repo} @ ${ref}`);
  const existing = await listJobs(cronJobApiKey);

  for (const spec of JOBS) {
    const body = buildJobBody({ spec, repo, ref, githubPat });
    const found = existing.find((j) => j.title === spec.title);
    const sched = `NY ${pad(spec.schedule.hours[0])}:${pad(spec.schedule.minutes[0])} wdays=[${spec.schedule.wdays.join(",")}]`;
    if (found) {
      await updateJob(cronJobApiKey, found.jobId, body);
      console.log(`✅ Updated  jobId=${found.jobId}  ${spec.title}  (${sched})`);
    } else {
      const id = await createJob(cronJobApiKey, body);
      console.log(`✅ Created  jobId=${id}  ${spec.title}  (${sched})`);
    }
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("❌ setup-cron-job failed:", msg);
  process.exit(1);
});
