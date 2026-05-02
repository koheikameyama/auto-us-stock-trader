"""
Macro event カレンダー seed

data/macro_events.csv を読み込んで MacroEvent テーブルに UPSERT する。
FOMC / CPI / NFP / PPI など、SPY のボラティリティを動かす公的イベントの日付を
バックテスト時の event-aware sizing/filter で参照するための事前データ。

Usage:
  python scripts/data/seed_macro_events.py
  python scripts/data/seed_macro_events.py --csv data/macro_events.csv
"""
import argparse
import csv
import os
import sys
import uuid
from urllib.parse import urlparse, urlunparse, parse_qsl, urlencode

import psycopg2
import psycopg2.extras

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib.db import get_database_url


def _normalize_dsn(url: str) -> str:
    """Prisma 用の `?schema=...` を psycopg2 が受け付けないので除去する。"""
    parsed = urlparse(url)
    query = [(k, v) for k, v in parse_qsl(parsed.query) if k != "schema"]
    return urlunparse(parsed._replace(query=urlencode(query)))

DEFAULT_CSV = os.path.join(
    os.path.dirname(__file__), "..", "..", "data", "macro_events.csv"
)


def load_csv(path: str) -> list[tuple[str, str, str, str | None]]:
    rows: list[tuple[str, str, str, str | None]] = []
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        for r in reader:
            date = r["date"].strip()
            event_type = r["eventType"].strip()
            description = (r.get("description") or "").strip() or None
            if not date or not event_type:
                continue
            rows.append((str(uuid.uuid4()), date, event_type, description))
    return rows


def main():
    parser = argparse.ArgumentParser(description="MacroEvent seed loader")
    parser.add_argument(
        "--csv", default=DEFAULT_CSV, help="CSV path (default: data/macro_events.csv)"
    )
    args = parser.parse_args()

    csv_path = os.path.abspath(args.csv)
    if not os.path.exists(csv_path):
        print(f"ERROR: CSV not found: {csv_path}", flush=True)
        sys.exit(1)

    rows = load_csv(csv_path)
    print(f"Loaded {len(rows)} rows from {csv_path}")
    if not rows:
        return

    conn = psycopg2.connect(_normalize_dsn(get_database_url()))
    cur = conn.cursor()
    try:
        psycopg2.extras.execute_values(
            cur,
            """
            INSERT INTO auto_us_stock_trader."MacroEvent"
                (id, date, "eventType", description, "updatedAt")
            VALUES %s
            ON CONFLICT (date, "eventType") DO UPDATE SET
                description = EXCLUDED.description,
                "updatedAt"  = NOW()
            """,
            [(rid, d, t, desc) for rid, d, t, desc in rows],
            template="(%s, %s, %s, %s, NOW())",
            page_size=500,
        )
        upserted = cur.rowcount
        conn.commit()

        # 集計レポート
        cur.execute(
            'SELECT "eventType", COUNT(*) FROM auto_us_stock_trader."MacroEvent" GROUP BY "eventType" ORDER BY "eventType"'
        )
        breakdown = cur.fetchall()
        print(f"UPSERT 完了: {upserted}件")
        for et, cnt in breakdown:
            print(f"  {et}: {cnt}")
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
