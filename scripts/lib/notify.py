"""
Slack通知ヘルパー（失敗時のみ通知）
"""

import os
import sys
import traceback
import json
import urllib.request


def get_webhook_url() -> str | None:
    url = os.getenv("SLACK_WEBHOOK_URL")
    if url:
        return url

    env_path = os.path.join(os.path.dirname(__file__), "..", "..", ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("SLACK_WEBHOOK_URL="):
                    return line.split("=", 1)[1].strip('"').strip("'")
    return None


def notify_failure(job_name: str, error: Exception) -> None:
    """ジョブ失敗時のSlack通知"""
    webhook = get_webhook_url()
    if not webhook:
        print("⚠ SLACK_WEBHOOK_URL 未設定のため通知スキップ", flush=True)
        return

    tb = "".join(traceback.format_exception(type(error), error, error.__traceback__))[-1500:]

    payload = {
        "attachments": [
            {
                "color": "danger",
                "title": f"❌ [trading-data-collector] {job_name} 失敗",
                "text": f"```{tb}```",
                "footer": "trading-data-collector",
            }
        ]
    }
    try:
        req = urllib.request.Request(
            webhook,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        print(f"⚠ Slack通知失敗: {e}", flush=True)


def run_with_notify(job_name: str, fn) -> None:
    """ジョブ実行ラッパー：失敗時に通知して exit 1"""
    try:
        fn()
    except Exception as e:
        traceback.print_exc()
        notify_failure(job_name, e)
        sys.exit(1)
