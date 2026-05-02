-- CreateTable
CREATE TABLE "RegimeSignal" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "xlyXlpRatio" DOUBLE PRECISION NOT NULL,
    "xlyXlp50dma" DOUBLE PRECISION NOT NULL,
    "xlyXlpState" TEXT NOT NULL,
    "xlkXluRatio" DOUBLE PRECISION NOT NULL,
    "xlkXlu50dma" DOUBLE PRECISION NOT NULL,
    "xlkXluState" TEXT NOT NULL,
    "combinedState" TEXT NOT NULL,
    "sizeMultiplier" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegimeSignal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RegimeSignal_date_key" ON "RegimeSignal"("date");

-- CreateIndex
CREATE INDEX "RegimeSignal_date_idx" ON "RegimeSignal"("date");

-- CreateIndex
CREATE INDEX "RegimeSignal_combinedState_idx" ON "RegimeSignal"("combinedState");
