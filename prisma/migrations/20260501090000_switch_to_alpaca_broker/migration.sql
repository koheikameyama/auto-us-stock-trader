-- DropIndex
DROP INDEX "TradingOrder_ibkrOrderId_key";

-- AlterTable
ALTER TABLE "TradingOrder" DROP COLUMN "ibkrOrderId",
ADD COLUMN     "brokerOrderId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "TradingOrder_brokerOrderId_key" ON "TradingOrder"("brokerOrderId");
