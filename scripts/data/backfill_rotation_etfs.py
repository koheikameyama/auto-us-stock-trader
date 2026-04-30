"""
Dual Momentum 用ETFバックフィル: SPY (米株), EFA (海外株), AGG (米国総合債券)
Antonacci 古典的 GEM (Global Equities Momentum) 構成

Usage:
  python scripts/data/backfill_rotation_etfs.py                                    # 直近10年（デフォルト）
  python scripts/data/backfill_rotation_etfs.py --start 2007-01-01                 # 期間指定
  python scripts/data/backfill_rotation_etfs.py --tickers SPY,EFA,AGG              # 銘柄指定
  python scripts/data/backfill_rotation_etfs.py --start 2007-01-01 --tickers SPY,EFA,AGG
"""
import argparse
import os, sys, uuid
import pandas as pd
import yfinance as yf
import psycopg2
import psycopg2.extras

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib.db import get_database_url

DATABASE_URL = get_database_url()

DEFAULT_TICKERS = ["SPY", "EFA", "AGG", "QQQ", "IWM", "TLT", "GLD", "BND"]
PERIOD = "10y"

parser = argparse.ArgumentParser(description="Dual Momentum 用 ETF backfill")
parser.add_argument("--start", default=None, help="開始日 YYYY-MM-DD（指定時は PERIOD を上書き）")
parser.add_argument("--tickers", default=None, help="カンマ区切り銘柄リスト（デフォルト: SPY,EFA,AGG,QQQ,IWM,TLT,GLD,BND）")
args = parser.parse_args()

TICKERS = [t.strip() for t in args.tickers.split(",")] if args.tickers else DEFAULT_TICKERS

print(f"ETF取得: {TICKERS}")
if args.start:
    print(f"  期間: {args.start} ~ 今日")
else:
    print(f"  期間: 直近 {PERIOD}")

conn = psycopg2.connect(DATABASE_URL)
cur = conn.cursor()

total = 0
for ticker in TICKERS:
    try:
        if args.start:
            df = yf.download(ticker, start=args.start, progress=False, auto_adjust=False)
        else:
            df = yf.download(ticker, period=PERIOD, progress=False, auto_adjust=False)
        if df.empty:
            print(f"  {ticker}: なし"); continue
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)
        df = df.dropna()

        rows = [(str(uuid.uuid4()), ticker, d.date(),
                 float(r["Open"]), float(r["High"]), float(r["Low"]), float(r["Close"]),
                 int(r["Volume"]) if not pd.isna(r["Volume"]) else 0)
                for d, r in df.iterrows()]
        psycopg2.extras.execute_values(
            cur,
            'INSERT INTO auto_us_stock_trader."StockDailyBar" (id, "tickerCode", date, open, high, low, close, volume) VALUES %s ON CONFLICT ("tickerCode", date) DO NOTHING',
            rows, page_size=500
        )
        ins = cur.rowcount
        total += ins
        print(f"  {ticker}: {len(rows)}日, INSERT {ins} ({df.index[0].date()}~{df.index[-1].date()})")
    except Exception as e:
        print(f"  {ticker}: エラー {e}")

conn.commit()
cur.close()
conn.close()
print(f"完了: {total}件")
