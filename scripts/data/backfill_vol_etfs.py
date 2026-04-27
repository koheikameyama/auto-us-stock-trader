"""
VIX関連ETF/ETNデータバックフィル: VXX, SVXY, UVXY (SVIXは2022年以降データのみ)
"""
import os
import sys
import uuid
import pandas as pd
import yfinance as yf
import psycopg2
import psycopg2.extras

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib.db import get_database_url

DATABASE_URL = get_database_url()

TICKERS = ["VXX", "SVXY", "UVXY", "SVIX", "VIXY"]
PERIOD = "5y"

print(f"VIX関連ETF取得: {TICKERS}")
conn = psycopg2.connect(DATABASE_URL)
cur = conn.cursor()

total_inserted = 0
for ticker in TICKERS:
    try:
        df = yf.download(ticker, period=PERIOD, progress=False, auto_adjust=False)
        if df.empty:
            print(f"  {ticker}: データなし")
            continue
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)
        df = df.dropna()

        rows = []
        for date, row in df.iterrows():
            rows.append((
                str(uuid.uuid4()),
                ticker,
                date.date(),
                float(row["Open"]),
                float(row["High"]),
                float(row["Low"]),
                float(row["Close"]),
                int(row["Volume"]) if not pd.isna(row["Volume"]) else 0,
            ))

        psycopg2.extras.execute_values(
            cur,
            """
            INSERT INTO auto_us_stock_trader."StockDailyBar" (id, "tickerCode", date, open, high, low, close, volume)
            VALUES %s
            ON CONFLICT ("tickerCode", date) DO NOTHING
            """,
            rows,
            page_size=500,
        )
        inserted = cur.rowcount
        total_inserted += inserted
        print(f"  {ticker}: {len(rows)}日分取得, 新規INSERT {inserted}件 (期間: {df.index[0].date()} ~ {df.index[-1].date()})")
    except Exception as e:
        print(f"  {ticker}: エラー {e}")

conn.commit()
cur.close()
conn.close()
print(f"完了: 新規INSERT合計 {total_inserted}件")
