import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { db, schema } from './db/index.js';
import { buildGlobalSummary } from './report.js';

const { payGroups, payrollCycles, payItems } = schema;
const app = new Hono();

// List countries with their pay groups.
app.get('/countries', async (c) => {
  const rows = await db.query.countries.findMany({
    with: { payGroups: true },
  });
  return c.json(rows);
});

// List pay groups for a country.
app.get('/countries/:code/pay-groups', (c) => {
  const code = c.req.param('code');
  const rows = db.select().from(payGroups).where(eq(payGroups.countryCode, code)).all();
  return c.json(rows);
});

// Create a payroll cycle (optionally with initial pay items).
app.post('/payroll-cycles', (c) => {
  return (async () => {
    const body = await c.req.json();
    const result = db.transaction((tx) => {
      const inserted = tx
        .insert(payrollCycles)
        .values({
          payGroupId: body.payGroupId,
          periodStart: body.periodStart,
          periodEnd: body.periodEnd,
          cutoffDate: body.cutoffDate ?? null,
          payDate: body.payDate ?? null,
          status: 'draft',
        })
        .returning()
        .get();
      if (Array.isArray(body.items)) {
        for (const item of body.items) {
          tx.insert(payItems).values({
            payrollCycleId: inserted.id,
            employeeId: item.employeeId,
            type: item.type,
            amount: item.amount,
            currency: item.currency,
          }).run();
        }
      }
      return inserted;
    });
    return c.json({ id: result.id, status: result.status });
  })();
});

// Fetch a single payroll cycle.
app.get('/payroll-cycles/:id', (c) => {
  const id = c.req.param('id');
  const row = db.select().from(payrollCycles).where(eq(payrollCycles.id, Number(id))).get();
  return c.json(row ?? null);
});

// Approve a payroll cycle.
app.post('/payroll-cycles/:id/approve', (c) => {
  const id = Number(c.req.param('id'));
  db.update(payrollCycles).set({ status: 'approved' }).where(eq(payrollCycles.id, id)).run();
  const row = db.select().from(payrollCycles).where(eq(payrollCycles.id, id)).get();
  return c.json({ id: row!.id, status: row!.status });
});

const { employees } = schema;

// List pay items for a cycle, with employee names.
app.get('/getPayItemsByCycle', (c) => {
  const cycleId = Number(c.req.query('cycleId'));
  const items = db.select().from(payItems).where(eq(payItems.payrollCycleId, cycleId)).all();
  const out = items.map((item) => {
    const emp = db.select().from(employees).where(eq(employees.id, item.employeeId)).get();
    return {
      pay_item_id: item.id,
      employee_name: emp?.name ?? null,
      item_type: item.type,
      amount: item.amount,
      currency: item.currency,
    };
  });
  return c.json(out);
});

// Add a pay item to a cycle.
app.post('/pay-items', (c) => {
  return (async () => {
    const body = await c.req.json();
    const inserted = db
      .insert(payItems)
      .values({
        payrollCycleId: body.payrollCycleId,
        employeeId: body.employeeId,
        type: body.type,
        amount: body.amount,
        currency: body.currency,
      })
      .returning()
      .get();
    return c.json({ id: inserted.id });
  })();
});

// List pay items, optionally filtered by minimum amount and sorted.
app.get('/pay-items', (c) => {
  const sort = c.req.query('sort') ?? 'id';
  const minAmount = c.req.query('minAmount');

  const conditions =
    minAmount !== undefined
      ? sql`WHERE ${payItems.amount} >= ${Number(minAmount)}`
      : sql``;

  const rows = db.all(
    sql`SELECT * FROM ${payItems} ${conditions} ORDER BY ${sql.raw(sort)}`
  );
  return c.json(rows);
});

// Company-wide payroll summary.
app.get('/reports/global-summary', (c) => {
  return c.json(buildGlobalSummary());
});

export default app;
