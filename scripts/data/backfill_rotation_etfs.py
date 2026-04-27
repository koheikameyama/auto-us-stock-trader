"""
Dual Momentum 用ETFバックフィル: SPY (米株), EFA (海外株), AGG (米国総合債券)
Antonacci 古典的 GEM (Global Equities Momentum) 構成
"""
import os, sys, uuid
import pandas as pd
import yfinance as yf
import psycopg2
import psycopg2.extras

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib.db import get_database_url

DATABASE_URL = get_database_url()

TICKERS = ["SPY", "EFA", "AGG", "QQQ", "IWM", "TLT", "GLD", "BND"]
PERIOD = "10y"

print(f"ETF取得: {TICKERS}")
conn = psycopg2.connect(DATABASE_URL)
cur = conn.cursor()

total = 0
for ticker in TICKERS:
    try:
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
