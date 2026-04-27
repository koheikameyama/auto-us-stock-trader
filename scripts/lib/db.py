"""
DB接続ヘルパー
"""

import os
import sys


def get_database_url() -> str:
    """DATABASE_URL を取得（環境変数 → .env の順）"""
    url = os.getenv("DATABASE_URL")
    if url:
        return url

    # .env から読み込み（ローカル開発用）
    env_path = os.path.join(os.path.dirname(__file__), "..", "..", ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("DATABASE_URL="):
                    return line.split("=", 1)[1].strip('"').strip("'")

    print("ERROR: DATABASE_URL が環境変数にも .env にも見つかりません", flush=True)
    sys.exit(1)
