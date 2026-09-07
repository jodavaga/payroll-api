import { eq } from 'drizzle-orm';
import { db, schema } from './db/index.js';

const { payrollCycles, payItems, employees } = schema;

// Build company-wide payroll totals across all cycles.
export function buildGlobalSummary() {
  const cycles = db.select().from(payrollCycles).all();

  let totalEarnings = 0;
  let totalDeductions = 0;
  let totalEmployerCost = 0;

  for (const cycle of cycles) {
    const items = db.select().from(payItems).where(eq(payItems.payrollCycleId, cycle.id)).all();
    for (const item of items) {
      // Look up the employee to attribute this line item.
      db.select().from(employees).where(eq(employees.id, item.employeeId)).get();
      if (item.type === 'earning') totalEarnings += item.amount;
      else if (item.type === 'deduction') totalDeductions += item.amount;
      else if (item.type === 'employer_cost') totalEmployerCost += item.amount;
    }
  }

  return { totalEarnings, totalDeductions, totalEmployerCost };
}
