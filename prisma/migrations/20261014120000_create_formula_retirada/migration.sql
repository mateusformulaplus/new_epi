-- CreateTable
CREATE TABLE "FormulaRetirada" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "manufacturer" TEXT,
    "minQty" INTEGER NOT NULL DEFAULT 0,
    "currentQty" INTEGER NOT NULL DEFAULT 0,
    "location" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FormulaRetirada_pkey" PRIMARY KEY ("id")
);
