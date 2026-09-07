# payroll-api — Code Review (Part 1)

Reviewed as the incoming owner, ahead of the next payroll run. Findings are triaged by severity — what actually breaks, for whom, and what to do about it.

---

## Critical

### C1 — SQL injection via the `sort` query parameter
**Where:** [src/server.ts:112-125](../src/server.ts#L112-L125)

```ts
const rows = db.all(
  sql`SELECT * FROM ${payItems} ${conditions} ORDER BY ${sql.raw(sort)}`
);
```

`sort` comes straight from `c.req.query('sort')` and is passed to `sql.raw()`, which inserts it into the query **unescaped**. Everything else in this query (the table reference, the `minAmount` value) is safely parameterized by Drizzle's `sql` tag — only `sort` bypasses that.

**Why it matters:** Any caller can inject arbitrary SQL through `?sort=`. In this in-memory SQLite instance that means reading or corrupting payroll and employee data (e.g. `?sort=(SELECT 1 FROM pay_items WHERE 1=1); DROP TABLE pay_items;--`). Against a real database this is a full data-exfiltration / data-destruction vector on data that represents real pay.

**Fix:** Validate `sort` against an allow-list of real column names (`id`, `amount`, `type`, `currency`, …) before use, and reject/ignore anything else. Never pass user input into `sql.raw`.

---

### C2 — Company-wide totals sum different currencies together
**Where:** [src/report.ts:7-26](../src/report.ts#L7-L26), exposed via [src/server.ts:128-130](../src/server.ts#L128-L130)

`buildGlobalSummary` adds up `item.amount` for every pay item across every cycle, regardless of `item.currency`. The seed data alone mixes EUR, GBP and USD. The result (`totalEarnings`, `totalDeductions`, `totalEmployerCost`) is a single number that silently combines three currencies as if they were interchangeable.

**Why it matters:** This is the number Finance will read as "the total cost of running payroll." As written it's not wrong in an obvious, crashing way — it's wrong in the worse way: it *looks* like a real total. Whoever consumes it will make decisions on a meaningless figure. This is the single highest-impact issue in the codebase given what this service is for.

**Fix:** Either (a) break totals down per currency (`{ EUR: {...}, GBP: {...}, USD: {...} }`), or (b) convert to a reporting currency using explicit, dated FX rates before summing — and never silently combine currencies. Part 2 / Option A asks for exactly this decision, so I've flagged it here rather than fixing it in Part 1.

---

### C3 — Money is modeled as floating point
**Where:** [src/db/schema.ts:39](../src/db/schema.ts#L39) (`amount: real('amount')`), summed with plain JS numbers in [src/report.ts](../src/report.ts)

Pay item amounts are stored as SQLite `REAL` and accumulated with `+=` on JS `number`. Both are binary floating point, which cannot represent most decimal fractions exactly.

**Why it matters:** For a handful of seed rows the visible error is negligible, but summation error compounds with volume — thousands of pay items across many cycles will produce totals that are off by cents (or more), silently. In a payroll system that's the difference between "trustworthy" and "we can't reconcile this against the bank statement."

**Fix:** Store money as integer minor units (cents) or use a fixed-point/decimal type end-to-end, and only format to decimal for display.

---

## High

### H1 — `pay_items.employee_id` has no foreign key
**Where:** [src/db/schema.ts:37](../src/db/schema.ts#L37), [drizzle/0000_init.sql:34](../drizzle/0000_init.sql#L34)

Every other relationship in the schema declares a `references()` (employees→countries, pay_groups→countries, payroll_cycles→pay_groups). `pay_items.employee_id` is the one exception — it's a bare `INTEGER NOT NULL` with no `REFERENCES employees(id)`, in both the Drizzle schema and the raw migration SQL.

**Why it matters:** `sqlite.pragma('foreign_keys = ON')` is set, so the intent was clearly referential integrity — this looks like an oversight rather than a choice. Because of it, a pay item can point at an employee id that doesn't exist, and nothing rejects the insert. Downstream, [src/server.ts:76-90](../src/server.ts#L76-L90) and [src/report.ts:18](../src/report.ts#L18) both handle a missing employee by silently returning `null`/skipping — so a bad `employee_id` doesn't error, it just quietly produces a payroll line with no name attached to it.

**Fix:** Add the missing `references(() => employees.id)` in the schema and the matching `REFERENCES employees(id)` in the migration.

---

### H2 — Approved cycles aren't actually protected, and approving a missing cycle crashes
**Where:** [src/server.ts:66-71](../src/server.ts#L66-L71) and [src/server.ts:93-109](../src/server.ts#L93-L109)

Two separate gaps:
1. `POST /payroll-cycles/:id/approve` unconditionally sets `status = 'approved'` with no check on the current status, and no check that the cycle exists. If it doesn't exist, `db.select()...get()` returns `undefined`, and `row!.id` (a non-null assertion on a value that *is* null) throws at runtime — the client gets an unhandled 500 instead of a 404.
2. `POST /pay-items` has no awareness of the target cycle's status at all — a pay item can be added to a cycle that's already `approved`, silently changing totals for a payroll that's supposedly locked.

**Why it matters:** Once a cycle is approved, the numbers it was approved on should be immutable — that's the whole point of an approval step. Right now approval is just a label; nothing enforces it. This is exactly the gap Part 2 / Option B addresses, but it's worth flagging here because it's a real, exploitable gap in the current code, not just a missing future feature.

**Fix:** Covered by implementing the lifecycle in Part 2. At minimum, `approve` should 404 on a missing cycle instead of throwing.

---

## Medium

### M1 — No input validation on write endpoints
**Where:** [src/server.ts:25-56](../src/server.ts#L25-L56) (`POST /payroll-cycles`), [src/server.ts:93-109](../src/server.ts#L93-L109) (`POST /pay-items`)

Request bodies are used directly (`body.payGroupId`, `body.amount`, etc.) with no shape/type checking. A malformed request (missing field, wrong type) will fail at the SQL layer (`NOT NULL` constraint or FK violation) and bubble up as an unhandled exception → generic 500, instead of a clean 400 with a useful message.

**Why it matters:** Not a data-correctness risk (the DB constraints still hold the line), but a poor API contract — callers get opaque failures, and any exception thrown inside `db.transaction` in the `/payroll-cycles` handler has no try/catch around it.

**Fix:** Validate request bodies (e.g. with `zod`) before hitting the DB, and return 400 with a clear message on failure.

---

### M2 — N+1 query patterns
**Where:** [src/server.ts:76-90](../src/server.ts#L76-L90) (`getPayItemsByCycle`), [src/report.ts:14-23](../src/report.ts#L14-L23) (`buildGlobalSummary`)

Both loop over rows and issue one additional query per row (per pay item, per cycle) instead of a single join or `IN (...)` query.

**Why it matters:** Harmless at seed-data scale (a handful of rows), but this is the kind of thing that quietly turns into a real latency problem once cycles and pay items grow to production volume — and `buildGlobalSummary` in particular will be called by Finance repeatedly.

**Fix:** Replace with a join (Drizzle's relational query API, already used in `GET /countries`) or a batched `IN` query.

---

### M3 — Dead lookup in `buildGlobalSummary`
**Where:** [src/report.ts:18](../src/report.ts#L18)

```ts
// Look up the employee to attribute this line item.
db.select().from(employees).where(eq(employees.id, item.employeeId)).get();
```

The query result is never assigned or used. The comment ("attribute this line item") suggests a per-employee or per-country breakdown was intended but never finished, and this line is what's left of it.

**Why it matters:** No functional impact — it's a wasted query, not a bug — but it's worth flagging: it's a concrete, ready-made explanation for the currency-mixing issue in C2 (attribution by country/currency was clearly on someone's mind, it just never got wired up).

**Fix:** Remove it if unused, or finish the attribution it was clearly meant to support (relevant to whichever Part 2 option is chosen).

---

## Low / nits

- **L1 — Inconsistent route naming:** `/getPayItemsByCycle` ([src/server.ts:76](../src/server.ts#L76)) is a verb-style RPC path; every other route is REST-style (`/countries/:code/pay-groups`, `/payroll-cycles/:id`). Cosmetic, but worth aligning for consistency (e.g. `/payroll-cycles/:id/pay-items`).
- **L2 — Mixed handler styles:** some handlers are `async` directly, others are synchronous functions wrapping an async IIFE (`return (async () => {...})()`) purely to use `await c.req.json()`. Both work correctly in Hono; it's just inconsistent style, likely from being written quickly.

---

## Flagged and dismissed (correct-but-unusual, not bugs)

- **`payroll_cycles.pay_date` is an integer (Unix epoch) while `period_start`/`period_end`/`cutoff_date` are text (ISO date strings)** ([src/db/schema.ts:24-32](../src/db/schema.ts#L24-L32)). Looks inconsistent at a glance, but it's plausible this is intentional: `pay_date` may need to represent an exact timestamp (e.g. for a payment processor cutoff) while the others are calendar-only boundaries. I'd confirm intent with the team rather than "fix" it — no `mode` is set on the integer column either way, so it round-trips as a plain number today, no bug.
- **The database is in-memory and reseeded on every process start** ([src/db/index.ts](../src/db/index.ts)). Alarming-sounding for "payroll," but this is explicitly a take-home simplification documented in the README, not a production design decision under review here.
- **`const { employees } = schema;` is destructured mid-file** ([src/server.ts:73](../src/server.ts#L73)) instead of alongside the other destructured tables at the top. Harmless — just suggests the route below it was bolted on later.

---

## Summary — what I'd fix first

If I owned this starting Monday: **C1 (SQL injection)** first, it's a live security hole with no upside to leaving it. Then **C2 and C3 together** (currency mixing + float arithmetic) before the next payroll run touches Finance's summary — both corrupt the one number this service exists to produce, silently. **H1** and **H2** next, since they're data-integrity and approval-immutability gaps that get worse the longer they're left. The rest (M1-M3, L1-L2) are real but not urgent.
