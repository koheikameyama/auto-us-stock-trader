/**
 * cron-job.org にスケジュールを登録/更新する。
 *
 * Usage:
 *   set -a; source .env; set +a
 *   npx tsx scripts/setup-cron-job.ts
 *
 * 動作:
 *   - 既に同じ title の job があれば PATCH で更新、なければ PUT で新規作成
 *   - GitHub Actions の paper-trading-daily.yml を workflow_dispatch で起動
 *   - スケジュール: NY 時間 平日 09:35（market open + 5min）
 *
 * 必要な env:
 *   CRONJOB_API_KEY    cron-job.org の API key
 *   GITHUB_PAT         workflow:write 権限を持つ GitHub Personal Access Token
 *   GITHUB_REPO        "owner/repo"。未設定なら git remote から推測
 *   GITHUB_WORKFLOW    workflow ファイル名。デフォルト "paper-trading-daily.yml"
 *   GITHUB_REF         ブランチ名。デフォルト "main"
 */

import { execSync } from "node:child_process";

const JOB_TITLE = "auto-us-stock-trader paper-trading daily";
const CRONJOB_BASE = "https://api.cron-job.org";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function detectRepo(): string {
  if (process.env.GITHUB_REPO) return process.env.GITHUB_REPO;
  const url = execSync("git remote get-url origin", { encoding: "utf8" }).trim();
  // https://github.com/owner/repo.git or git@github.com:owner/repo.git
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

interface CronJobJobsResponse {
  jobs: CronJobJob[];
}

async function listJobs(apiKey: string): Promise<CronJobJob[]> {
  const res = await fetch(`${CRONJOB_BASE}/jobs`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`cron-job.org list failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as CronJobJobsResponse;
  return data.jobs ?? [];
}

interface JobConfig {
  title: string;
  url: string;
  authHeaderValue: string;
  body: string;
}

function buildJobBody(cfg: JobConfig) {
  return {
    job: {
      url: cfg.url,
      enabled: true,
      title: cfg.title,
      saveResponses: true,
      requestMethod: 1, // POST
      schedule: {
        timezone: "America/New_York",
        hours: [9],
        minutes: [35],
        mdays: [-1],
        months: [-1],
        wdays: [1, 2, 3, 4, 5], // Mon-Fri
      },
      extendedData: {
        headers: {
          Authorization: cfg.authHeaderValue,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          "User-Agent": "cron-job.org auto-us-stock-trader",
        },
        body: cfg.body,
      },
    },
  };
}

async function createJob(apiKey: string, cfg: JobConfig): Promise<number> {
  const res = await fetch(`${CRONJOB_BASE}/jobs`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildJobBody(cfg)),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { jobId: number };
  return data.jobId;
}

async function updateJob(apiKey: string, jobId: number, cfg: JobConfig): Promise<void> {
  const res = await fetch(`${CRONJOB_BASE}/jobs/${jobId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildJobBody(cfg)),
  });
  if (!res.ok) throw new Error(`update failed: ${res.status} ${await res.text()}`);
}

async function main() {
  const cronJobApiKey = requireEnv("CRONJOB_API_KEY");
  const githubPat = requireEnv("GITHUB_PAT");
  const repo = detectRepo();
  const workflow = process.env.GITHUB_WORKFLOW ?? "paper-trading-daily.yml";
  const ref = process.env.GITHUB_REF ?? "main";

  const cfg: JobConfig = {
    title: JOB_TITLE,
    url: `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
    authHeaderValue: `Bearer ${githubPat}`,
    body: JSON.stringify({ ref }),
  };

  console.log(`Target: ${cfg.url}`);
  console.log(`Schedule: NY weekdays 09:35`);

  const jobs = await listJobs(cronJobApiKey);
  const existing = jobs.find((j) => j.title === JOB_TITLE);

  if (existing) {
    console.log(`Updating existing job (id=${existing.jobId})...`);
    await updateJob(cronJobApiKey, existing.jobId, cfg);
    console.log(`✅ Updated job ${existing.jobId}`);
  } else {
    console.log("Creating new job...");
    const id = await createJob(cronJobApiKey, cfg);
    console.log(`✅ Created job ${id}`);
  }
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("❌ setup-cron-job failed:", msg);
  process.exit(1);
});
