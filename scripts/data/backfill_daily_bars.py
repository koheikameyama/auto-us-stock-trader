"""
米国株 日足データ バックフィル

Wikipedia から構成銘柄リストを取得し、
yfinance で3年分のOHLCVを取得して StockDailyBar に INSERT。

Usage:
  python scripts/backfill-us-daily-bars.py                # S&P 500（デフォルト）
  python scripts/backfill-us-daily-bars.py --index sp600  # S&P 600 SmallCap
  python scripts/backfill-us-daily-bars.py --yes           # 確認スキップ
"""

import io
import os
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import urllib.request

import pandas as pd
import yfinance as yf
import psycopg2
import psycopg2.extras

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    env_path = os.path.join(os.path.dirname(__file__), "..", "..", ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("DATABASE_URL="):
                    DATABASE_URL = line.split("=", 1)[1].strip('"').strip("'")
                    break

if not DATABASE_URL:
    print("ERROR: DATABASE_URL が見つかりません")
    sys.exit(1)

SKIP_CONFIRM = "--yes" in sys.argv

# --index フラグ: sp500（デフォルト）or sp600
INDEX_NAME = "sp500"
for i, arg in enumerate(sys.argv):
    if arg == "--index" and i + 1 < len(sys.argv):
        INDEX_NAME = sys.argv[i + 1].lower()
        break

if "localhost" not in DATABASE_URL and "127.0.0.1" not in DATABASE_URL:
    print(f"本番DB に接続します: {DATABASE_URL[:50]}...")
    if not SKIP_CONFIRM:
        print("続行しますか？ (y/N): ", end="")
        if input().strip().lower() != "y":
            print("中止しました")
            sys.exit(0)
    else:
        print("--yes フラグにより確認スキップ")

BATCH_SIZE = 50  # yfinance 一括取得サイズ
PERIOD = "3y"    # 3年分（WF検証に27ヶ月必要）
INSERT_PAGE_SIZE = 500


def get_sp500_tickers() -> list[str]:
    """Wikipedia から S&P 500 構成銘柄リストを取得"""
    url = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    html = urllib.request.urlopen(req).read().decode("utf-8")
    tables = pd.read_html(io.StringIO(html))
    df = tables[0]
    tickers = df["Symbol"].tolist()
    # BRK.B → BRK-B, BF.B → BF-B（yfinance 形式）
    tickers = [t.replace(".", "-") for t in tickers]
    return sorted(tickers)


def get_sp600_tickers() -> list[str]:
    """Wikipedia から S&P 600 SmallCap 構成銘柄リストを取得"""
    url = "https://en.wikipedia.org/wiki/List_of_S%26P_600_companies"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    html = urllib.request.urlopen(req).read().decode("utf-8")
    tables = pd.read_html(io.StringIO(html))
    df = tables[0]
    tickers = df["Symbol"].tolist()
    tickers = [t.replace(".", "-") for t in tickers]
    return sorted(tickers)


def fetch_ohlcv_batch(tickers: list[str]) -> dict:
    """yfinance でバッチ取得"""
    ticker_str = " ".join(tickers)

    try:
        data = yf.download(
            ticker_str,
            period=PERIOD,
            interval="1d",
            group_by="ticker",
            auto_adjust=True,
            progress=False,
            threads=True,
        )
    except Exception as e:
        print(f"  yfinance error: {e}")
        return {}

    results = {}
    if len(tickers) == 1:
        t = tickers[0]
        if not data.empty:
            bars = []
            for idx, row in data.iterrows():
                dt = idx.to_pydatetime() if hasattr(idx, "to_pydatetime") else idx
                if hasattr(dt, "date"):
                    dt = dt.date()
                o, h, l, c, v = row.get("Open"), row.get("High"), row.get("Low"), row.get("Close"), row.get("Volume")
                if all(x is not None and x == x for x in [o, h, l, c, v]):
                    bars.append((str(uuid.uuid4()), t, dt, float(o), float(h), float(l), float(c), int(v), "US"))
            results[t] = bars
    else:
        for t in tickers:
            try:
                ticker_data = data[t]
                if ticker_data.empty:
                    continue
                bars = []
                for idx, row in ticker_data.iterrows():
                    dt = idx.to_pydatetime() if hasattr(idx, "to_pydatetime") else idx
                    if hasattr(dt, "date"):
                        dt = dt.date()
                    o, h, l, c, v = row.get("Open"), row.get("High"), row.get("Low"), row.get("Close"), row.get("Volume")
                    if all(x is not None and x == x for x in [o, h, l, c, v]):
                        bars.append((str(uuid.uuid4()), t, dt, float(o), float(h), float(l), float(c), int(v), "US"))
                if bars:
                    results[t] = bars
            except (KeyError, Exception):
                continue

    return results


def insert_bars(conn, all_bars: list[tuple]):
    """バルクINSERT（ON CONFLICT DO NOTHING）"""
    if not all_bars:
        return 0

    inserted = 0
    with conn.cursor() as cur:
        for i in range(0, len(all_bars), INSERT_PAGE_SIZE):
            batch = all_bars[i:i + INSERT_PAGE_SIZE]
            psycopg2.extras.execute_values(
                cur,
                """
                INSERT INTO "StockDailyBar" (id, "tickerCode", date, open, high, low, close, volume, market)
                VALUES %s
                ON CONFLICT ("tickerCode", date) DO NOTHING
                """,
                batch,
                page_size=INSERT_PAGE_SIZE,
            )
            inserted += cur.rowcount
    conn.commit()
    return inserted


def do_insert(all_bars: list[tuple]) -> int:
    """DB挿入（リトライ付き）"""
    inserted = 0
    for retry in range(3):
        batch_conn = None
        try:
            batch_conn = psycopg2.connect(DATABASE_URL, connect_timeout=30)
            inserted = insert_bars(batch_conn, all_bars)
            batch_conn.close()
            return inserted
        except Exception as e:
            print(f"  DB error (retry {retry + 1}/3): {e}", flush=True)
            if batch_conn:
                try:
                    batch_conn.close()
                except Exception:
                    pass
            if retry < 2:
                time.sleep(5)
            else:
                print("  SKIP: DB挿入に失敗", flush=True)
    return inserted


def main():
    index_label = "S&P 500" if INDEX_NAME == "sp500" else "S&P 600 SmallCap"
    print("=" * 60, flush=True)
    print(f"米国株（{index_label}）日足データ バックフィル", flush=True)
    print("=" * 60, flush=True)

    # 銘柄リスト取得
    print(f"{index_label} 構成銘柄リストを Wikipedia から取得中...", flush=True)
    tickers = get_sp600_tickers() if INDEX_NAME == "sp600" else get_sp500_tickers()
    print(f"対象銘柄: {len(tickers)}件", flush=True)

    conn = psycopg2.connect(DATABASE_URL, connect_timeout=30)

    # 既存の米国株データ確認（.T なし、^ なし）
    with conn.cursor() as cur:
        cur.execute("""
            SELECT COUNT(*) FROM "StockDailyBar"
            WHERE "tickerCode" NOT LIKE '%%.T' AND "tickerCode" NOT LIKE '^%%'
        """)
        existing = cur.fetchone()[0]
    print(f"既存の米国株データ: {existing:,}件", flush=True)
    conn.close()

    total_batches = (len(tickers) + BATCH_SIZE - 1) // BATCH_SIZE
    total_inserted = 0
    total_bars = 0
    failed_tickers: list[str] = []

    # パイプライン: 現バッチのDB挿入中に次バッチをpre-fetch
    with ThreadPoolExecutor(max_workers=1) as executor:
        current_future = executor.submit(fetch_ohlcv_batch, tickers[:BATCH_SIZE])

        for batch_idx in range(total_batches):
            start = batch_idx * BATCH_SIZE
            end = min(start + BATCH_SIZE, len(tickers))
            batch_tickers = tickers[start:end]

            # 次バッチのfetchを先行開始
            next_start = end
            next_batch_tickers = tickers[next_start:next_start + BATCH_SIZE] if next_start < len(tickers) else None
            if next_batch_tickers:
                next_future = executor.submit(fetch_ohlcv_batch, next_batch_tickers)

            print(f"\n[{batch_idx + 1}/{total_batches}] {batch_tickers[0]}〜{batch_tickers[-1]} ({len(batch_tickers)}銘柄)", flush=True)

            results = current_future.result()

            all_bars = []
            for t in batch_tickers:
                bars = results.get(t, [])
                if not bars:
                    failed_tickers.append(t)
                all_bars.extend(bars)
            total_bars += len(all_bars)

            inserted = do_insert(all_bars)
            total_inserted += inserted

            print(f"  取得: {len(results)}/{len(batch_tickers)}銘柄, {len(all_bars)}バー, 新規INSERT: {inserted}件", flush=True)

            if next_batch_tickers:
                current_future = next_future
                time.sleep(1)

    # 最終確認
    final_conn = psycopg2.connect(DATABASE_URL, connect_timeout=30)
    with final_conn.cursor() as cur:
        cur.execute("""
            SELECT MIN(date), MAX(date), COUNT(*)
            FROM "StockDailyBar"
            WHERE "tickerCode" NOT LIKE '%%.T' AND "tickerCode" NOT LIKE '^%%'
        """)
        min_date, max_date, count = cur.fetchone()
    final_conn.close()

    print("\n" + "=" * 60, flush=True)
    print("完了", flush=True)
    print("=" * 60, flush=True)
    print(f"取得バー数: {total_bars:,}", flush=True)
    print(f"新規INSERT: {total_inserted:,}", flush=True)
    print(f"失敗銘柄: {len(failed_tickers)}", flush=True)
    if failed_tickers:
        print(f"  例: {failed_tickers[:10]}", flush=True)
    print(f"米国株DB: {min_date} 〜 {max_date} ({count:,}件)", flush=True)


if __name__ == "__main__":
    main()
