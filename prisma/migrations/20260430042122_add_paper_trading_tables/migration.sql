-- CreateTable
CREATE TABLE "TradingOrder" (
    "id" TEXT NOT NULL,
    "ibkrOrderId" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "orderType" TEXT NOT NULL,
    "shortStrike" DOUBLE PRECISION NOT NULL,
    "longStrike" DOUBLE PRECISION NOT NULL,
    "expiry" DATE NOT NULL,
    "quantity" INTEGER NOT NULL,
    "limitPrice" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "filledAt" TIMESTAMP(3),
    "filledPrice" DOUBLE PRECISION,
    "commission" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "positionId" TEXT,

    CONSTRAINT "TradingOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "shortStrike" DOUBLE PRECISION NOT NULL,
    "longStrike" DOUBLE PRECISION NOT NULL,
    "expiry" DATE NOT NULL,
    "contracts" INTEGER NOT NULL,
    "creditReceived" DOUBLE PRECISION NOT NULL,
    "entryDate" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL,
    "closeDate" TIMESTAMP(3),
    "closeReason" TEXT,
    "closeSpreadPrice" DOUBLE PRECISION,
    "netPnl" DOUBLE PRECISION,
    "totalCommission" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyEquitySnapshot" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "cash" DOUBLE PRECISION NOT NULL,
    "positionsValue" DOUBLE PRECISION NOT NULL,
    "totalEquity" DOUBLE PRECISION NOT NULL,
    "openPositionCount" INTEGER NOT NULL,
    "ddStopActive" BOOLEAN NOT NULL,
    "runningPeak" DOUBLE PRECISION NOT NULL,
    "ddStopActivatedDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyEquitySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignalLog" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "signalType" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignalLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErrorLog" (
    "id" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "category" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "context" JSONB,
    "resolved" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ErrorLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TradingOrder_ibkrOrderId_key" ON "TradingOrder"("ibkrOrderId");

-- CreateIndex
CREATE INDEX "TradingOrder_status_idx" ON "TradingOrder"("status");

-- CreateIndex
CREATE INDEX "TradingOrder_submittedAt_idx" ON "TradingOrder"("submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TradingOrder_symbol_shortStrike_longStrike_expiry_submitted_key" ON "TradingOrder"("symbol", "shortStrike", "longStrike", "expiry", "submittedAt");

-- CreateIndex
CREATE INDEX "Position_state_idx" ON "Position"("state");

-- CreateIndex
CREATE INDEX "Position_entryDate_idx" ON "Position"("entryDate");

-- CreateIndex
CREATE UNIQUE INDEX "DailyEquitySnapshot_date_key" ON "DailyEquitySnapshot"("date");

-- CreateIndex
CREATE INDEX "DailyEquitySnapshot_date_idx" ON "DailyEquitySnapshot"("date");

-- CreateIndex
CREATE INDEX "SignalLog_date_idx" ON "SignalLog"("date");

-- CreateIndex
CREATE INDEX "SignalLog_signalType_idx" ON "SignalLog"("signalType");

-- CreateIndex
CREATE INDEX "ErrorLog_occurredAt_idx" ON "ErrorLog"("occurredAt");

-- CreateIndex
CREATE INDEX "ErrorLog_category_idx" ON "ErrorLog"("category");

-- AddForeignKey
ALTER TABLE "TradingOrder" ADD CONSTRAINT "TradingOrder_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE SET NULL ON UPDATE CASCADE;
