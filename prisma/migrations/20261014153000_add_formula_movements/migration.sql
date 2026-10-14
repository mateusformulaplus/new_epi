CREATE TABLE "FormulaMovement" (
    "id" TEXT NOT NULL,
    "formulaId" TEXT NOT NULL,
    "formulaName" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "responsibleId" TEXT,
    "responsibleName" TEXT NOT NULL,
    "recipient" TEXT,
    "reason" TEXT,
    "notes" TEXT,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FormulaMovement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FormulaMovement_formulaId_date_idx" ON "FormulaMovement"("formulaId", "date");

ALTER TABLE "FormulaMovement" ADD CONSTRAINT "FormulaMovement_formulaId_fkey"
    FOREIGN KEY ("formulaId") REFERENCES "FormulaRetirada"("id") ON DELETE RESTRICT ON UPDATE CASCADE;