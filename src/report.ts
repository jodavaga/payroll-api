import { eq } from 'drizzle-orm';
import { db, schema } from './db/index.js';

const { payrollCycles, payItems } = schema;

export interface CurrencyTotals {
  totalEarnings: number;
  totalDeductions: number;
  totalEmployerCost: number;
}

export interface PayItemForSummary {
  type: string;
  amount: number;
  currency: string;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// Pure aggregation: no DB access, so it's easy to test with fixed inputs.
export function summarizeByCurrency(items: PayItemForSummary[]): Record<string, CurrencyTotals> {
  const byCurrency: Record<string, CurrencyTotals> = {};

  for (const item of items) {
    if (!byCurrency[item.currency]) {
      byCurrency[item.currency] = { totalEarnings: 0, totalDeductions: 0, totalEmployerCost: 0 };
    }
    const totals = byCurrency[item.currency];

    if (item.type === 'earning') totals.totalEarnings += item.amount;
    else if (item.type === 'deduction') totals.totalDeductions += item.amount;
    else if (item.type === 'employer_cost') totals.totalEmployerCost += item.amount;
  }

  for (const totals of Object.values(byCurrency)) {
    totals.totalEarnings = round2(totals.totalEarnings);
    totals.totalDeductions = round2(totals.totalDeductions);
    totals.totalEmployerCost = round2(totals.totalEmployerCost);
  }

  return byCurrency;
}

// Company-wide payroll totals, broken down by currency, for approved cycles only.
// Draft cycles are excluded: their numbers aren't final and shouldn't be reported as committed cost
// (agreed with Finance team).
export function buildGlobalSummary(): { byCurrency: Record<string, CurrencyTotals> } {
  const items = db
    .select({ type: payItems.type, amount: payItems.amount, currency: payItems.currency })
    .from(payItems)
    .innerJoin(payrollCycles, eq(payItems.payrollCycleId, payrollCycles.id))
    .where(eq(payrollCycles.status, 'approved'))
    .all();

  return { byCurrency: summarizeByCurrency(items) };
}
