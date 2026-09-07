import { describe, it, expect } from 'vitest';
import { summarizeByCurrency, buildGlobalSummary } from './report.js';
import { db, schema } from './db/index.js';

const { payItems } = schema;

describe('summarizeByCurrency (pure aggregation)', () => {
  it('keeps totals for different currencies separate', () => {
    const result = summarizeByCurrency([
      { type: 'earning', amount: 100, currency: 'EUR' },
      { type: 'earning', amount: 200, currency: 'USD' },
      { type: 'deduction', amount: 20, currency: 'EUR' },
    ]);

    expect(result.EUR).toEqual({ totalEarnings: 100, totalDeductions: 20, totalEmployerCost: 0 });
    expect(result.USD).toEqual({ totalEarnings: 200, totalDeductions: 0, totalEmployerCost: 0 });
  });

  it('returns an empty object when there are no items', () => {
    expect(summarizeByCurrency([])).toEqual({});
  });

  it('rounds totals to 2 decimal places to avoid floating point artifacts', () => {
    const result = summarizeByCurrency([
      { type: 'earning', amount: 0.1, currency: 'EUR' },
      { type: 'earning', amount: 0.2, currency: 'EUR' },
    ]);

    expect(result.EUR.totalEarnings).toBe(0.3);
  });

  it('ignores pay item types it does not recognize instead of throwing', () => {
    const result = summarizeByCurrency([{ type: 'bonus_adjustment', amount: 50, currency: 'EUR' }]);
    expect(result.EUR).toEqual({ totalEarnings: 0, totalDeductions: 0, totalEmployerCost: 0 });
  });
});

describe('buildGlobalSummary (DB integration)', () => {
  it('matches the expected totals from seed data, per currency', () => {
    const { byCurrency } = buildGlobalSummary();

    expect(byCurrency.EUR).toEqual({ totalEarnings: 8083.33, totalDeductions: 1579.17, totalEmployerCost: 650.12 });
    expect(byCurrency.GBP).toEqual({ totalEarnings: 7000.1, totalDeductions: 1400.02, totalEmployerCost: 585 });
    expect(byCurrency.USD).toEqual({ totalEarnings: 9758.89, totalDeductions: 1951.78, totalEmployerCost: 697.58 });
  });

  it('excludes pay items belonging to draft cycles', () => {
    // Cycle 2 is a draft cycle in the seed data (DE Monthly, June 2026).
    db.insert(payItems)
      .values({ payrollCycleId: 2, employeeId: 1, type: 'earning', amount: 999_999, currency: 'EUR' })
      .run();

    const { byCurrency } = buildGlobalSummary();

    // If the draft cycle's item leaked in, this would be ~1,008,082 instead of 8083.33.
    expect(byCurrency.EUR.totalEarnings).toBe(8083.33);
  });
});
