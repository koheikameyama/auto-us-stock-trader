-- CreateTable
CREATE TABLE "StockDailyBar" (
    "id" TEXT NOT NULL,
    "tickerCode" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockDailyBar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EarningsDate" (
    "id" TEXT NOT NULL,
    "tickerCode" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EarningsDate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndexDailyBar" (
    "id" TEXT NOT NULL,
    "tickerCode" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IndexDailyBar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stock" (
    "id" TEXT NOT NULL,
    "tickerCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sector" TEXT,
    "industry" TEXT,
    "marketCap" BIGINT,
    "indexNames" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Stock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockDailyBar_tickerCode_date_idx" ON "StockDailyBar"("tickerCode", "date" DESC);

-- CreateIndex
CREATE INDEX "StockDailyBar_date_idx" ON "StockDailyBar"("date");

-- CreateIndex
CREATE UNIQUE INDEX "StockDailyBar_tickerCode_date_key" ON "StockDailyBar"("tickerCode", "date");

-- CreateIndex
CREATE INDEX "EarningsDate_date_idx" ON "EarningsDate"("date");

-- CreateIndex
CREATE UNIQUE INDEX "EarningsDate_tickerCode_date_key" ON "EarningsDate"("tickerCode", "date");

-- CreateIndex
CREATE INDEX "IndexDailyBar_date_idx" ON "IndexDailyBar"("date");

-- CreateIndex
CREATE UNIQUE INDEX "IndexDailyBar_tickerCode_date_key" ON "IndexDailyBar"("tickerCode", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Stock_tickerCode_key" ON "Stock"("tickerCode");

-- CreateIndex
CREATE INDEX "Stock_tickerCode_idx" ON "Stock"("tickerCode");
