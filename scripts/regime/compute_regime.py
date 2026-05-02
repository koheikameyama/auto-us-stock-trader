"""
Risk-on/off レジームフィルター計算スクリプト

XLY/XLP, XLK/XLU の 50DMA クロスから Risk-on/off を判定し、
RegimeSignal テーブルに UPSERT する。

判定ロジック:
- 各 ratio が 50DMA を上抜け = ON、下抜け = OFF
- 両方 ON → RISK_ON (multiplier 1.5)
- 両方 OFF → RISK_OFF (multiplier 0.5)
- 片方ずつ → NEUTRAL (multiplier 1.0)

Usage:
  python scripts/regime/compute_regime.py                # 直近 60 日分を再計算（日次運用）
  python scripts/regime/compute_regime.py --days 3650    # 過去 10 年分を初期化
"""
import argparse
import os
import sys
import uuid

import pandas as pd
import psycopg2
import psycopg2.extras

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib.db import get_database_url

DATABASE_URL = get_database_url()

MA_WINDOW = 50
TICKERS = ["XLY", "XLP", "XLK", "XLU"]
SIZE_MULT = {"RISK_ON": 1.5, "NEUTRAL": 1.0, "RISK_OFF": 0.5}

parser = argparse.ArgumentParser(description="Risk-on/off レジームフィルター計算")
parser.add_argument("--days", type=int, default=60, help="UPSERT 対象日数（デフォルト 60、初期化時は 3650）")
args = parser.parse_args()

conn = psycopg2.connect(DATABASE_URL)
cur = conn.cursor()

# 50DMA 計算のため余分に取得
fetch_days = args.days + MA_WINDOW + 30
cur.execute(
    f'''SELECT "tickerCode", date, close
        FROM auto_us_stock_trader."StockDailyBar"
        WHERE "tickerCode" = ANY(%s)
          AND date >= CURRENT_DATE - INTERVAL '{fetch_days} days'
        ORDER BY date''',
    (TICKERS,),
)
rows = cur.fetchall()

if not rows:
    print("ERROR: ETF データが見つかりません（XLY/XLP/XLK/XLU を先に backfill_rotation_etfs.py で取得してください）", flush=True)
    sys.exit(1)

df = pd.DataFrame(rows, columns=["ticker", "date", "close"])
df["close"] = df["close"].astype(float)
pivot = df.pivot(index="date", columns="ticker", values="close")

# 4 銘柄全て揃っている日のみ採用
required = set(TICKERS)
present = set(pivot.columns)
missing = required - present
if missing:
    print(f"ERROR: 必要な ETF が DB にありません: {missing}", flush=True)
    sys.exit(1)
pivot = pivot.dropna(subset=TICKERS)

# Ratio + 50DMA
pivot["xlyXlpRatio"] = pivot["XLY"] / pivot["XLP"]
pivot["xlkXluRatio"] = pivot["XLK"] / pivot["XLU"]
pivot["xlyXlp50dma"] = pivot["xlyXlpRatio"].rolling(MA_WINDOW).mean()
pivot["xlkXlu50dma"] = pivot["xlkXluRatio"].rolling(MA_WINDOW).mean()
pivot = pivot.dropna(subset=["xlyXlp50dma", "xlkXlu50dma"])

# UPSERT 対象は最新 args.days 日分のみ
pivot_target = pivot.tail(args.days)

def state(ratio: float, ma: float) -> str:
    return "ON" if ratio > ma else "OFF"

def combined(s_xlyxlp: str, s_xlkxlu: str) -> str:
    if s_xlyxlp == "ON" and s_xlkxlu == "ON":
        return "RISK_ON"
    if s_xlyxlp == "OFF" and s_xlkxlu == "OFF":
        return "RISK_OFF"
    return "NEUTRAL"

regime_rows = []
for date, row in pivot_target.iterrows():
    s_xlyxlp = state(row["xlyXlpRatio"], row["xlyXlp50dma"])
    s_xlkxlu = state(row["xlkXluRatio"], row["xlkXlu50dma"])
    c = combined(s_xlyxlp, s_xlkxlu)
    regime_rows.append((
        str(uuid.uuid4()),
        date,
        float(row["xlyXlpRatio"]),
        float(row["xlyXlp50dma"]),
        s_xlyxlp,
        float(row["xlkXluRatio"]),
        float(row["xlkXlu50dma"]),
        s_xlkxlu,
        c,
        SIZE_MULT[c],
    ))

psycopg2.extras.execute_values(
    cur,
    '''INSERT INTO auto_us_stock_trader."RegimeSignal"
       (id, date, "xlyXlpRatio", "xlyXlp50dma", "xlyXlpState",
        "xlkXluRatio", "xlkXlu50dma", "xlkXluState",
        "combinedState", "sizeMultiplier", "updatedAt")
       VALUES %s
       ON CONFLICT (date) DO UPDATE SET
         "xlyXlpRatio"    = EXCLUDED."xlyXlpRatio",
         "xlyXlp50dma"    = EXCLUDED."xlyXlp50dma",
         "xlyXlpState"    = EXCLUDED."xlyXlpState",
         "xlkXluRatio"    = EXCLUDED."xlkXluRatio",
         "xlkXlu50dma"    = EXCLUDED."xlkXlu50dma",
         "xlkXluState"    = EXCLUDED."xlkXluState",
         "combinedState"  = EXCLUDED."combinedState",
         "sizeMultiplier" = EXCLUDED."sizeMultiplier",
         "updatedAt"      = NOW()''',
    regime_rows,
    template="(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())",
    page_size=500,
)
conn.commit()

# サマリ出力
counts = {"RISK_ON": 0, "NEUTRAL": 0, "RISK_OFF": 0}
for r in regime_rows:
    counts[r[8]] += 1
total = len(regime_rows)
print(f"完了: {total}日 UPSERT")
if total > 0:
    for s in ["RISK_ON", "NEUTRAL", "RISK_OFF"]:
        n = counts[s]
        print(f"  {s}: {n} ({100*n/total:.1f}%)")
    last = regime_rows[-1]
    print(f"  最新: {last[1]} = {last[8]} (mult={last[9]}, XLY/XLP={last[4]}, XLK/XLU={last[7]})")

cur.close()
conn.close()
