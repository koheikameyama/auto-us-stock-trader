-- CreateTable
CREATE TABLE "MacroEvent" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "eventType" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MacroEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MacroEvent_date_idx" ON "MacroEvent"("date");

-- CreateIndex
CREATE INDEX "MacroEvent_eventType_idx" ON "MacroEvent"("eventType");

-- CreateIndex
CREATE UNIQUE INDEX "MacroEvent_date_eventType_key" ON "MacroEvent"("date", "eventType");
