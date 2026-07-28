-- CreateTable
CREATE TABLE "auto_us_stock_trader"."IvSkewSnapshot" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "dte" INTEGER NOT NULL,
    "expiry" DATE NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "spot" DOUBLE PRECISION NOT NULL,
    "baseIv" DOUBLE PRECISION NOT NULL,
    "vix" DOUBLE PRECISION,
    "vixDate" DATE,
    "putSlopeAll" DOUBLE PRECISION,
    "putSlopeBand" DOUBLE PRECISION,
    "putCountAll" INTEGER NOT NULL,
    "putCountBand" INTEGER NOT NULL,
    "callSlopeAll" DOUBLE PRECISION,
    "callSlopeBand" DOUBLE PRECISION,
    "callCountAll" INTEGER NOT NULL,
    "callCountBand" INTEGER NOT NULL,
    "points" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IvSkewSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IvSkewSnapshot_date_idx" ON "auto_us_stock_trader"."IvSkewSnapshot"("date");

-- CreateIndex
CREATE INDEX "IvSkewSnapshot_baseIv_idx" ON "auto_us_stock_trader"."IvSkewSnapshot"("baseIv");

-- CreateIndex
CREATE UNIQUE INDEX "IvSkewSnapshot_date_dte_key" ON "auto_us_stock_trader"."IvSkewSnapshot"("date", "dte");
