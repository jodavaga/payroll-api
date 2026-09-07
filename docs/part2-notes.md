# Part 2 — Option A: Company-Wide Payroll Summary

Notes on the decisions and edge cases behind the change to [src/report.ts](../src/report.ts) and [src/server.ts](../src/server.ts) (`GET /reports/global-summary`).

## Decisions

**Totals are grouped by currency, not converted into one currency.**
The old code added EUR, GBP and USD amounts together into a single number. This project has no exchange rate data anywhere. Converting everything into one currency would mean making up a rate, and that would be worse than the bug it replaces. The response now returns separate totals for each currency: `{ byCurrency: { EUR: {...}, GBP: {...}, USD: {...} } }`.

**Only cycles with status `approved` are included.**
A `draft` cycle can still change, so its numbers are not final yet. We agreed this is the right default for a company-wide number that Finance will treat as real: `draft` cycles are removed at the database query level (`WHERE payroll_cycles.status = 'approved'`), not just in the application code.

**Totals are rounded to 2 decimal places.**
This stops the response from showing ugly numbers like `1234.5600000000002`. This only fixes how the number looks, not the real cause. The `amount` column is still a floating-point number, and adding many of them can still cause small errors. A real fix would mean storing money as whole cents instead of decimals, everywhere in the app. That is a bigger change, so it is only noted here and flagged as finding C3 in the Part 1 review.

## Edge cases considered

- **No approved cycles, or no pay items at all** → the response is `{ byCurrency: {} }`, not an error.
- **A pay item with an unknown `type`** (something other than `earning`, `deduction`, or `employer_cost`) is skipped, just like in the old code. It does not crash, and it is not added to the wrong total.
- **A currency with no approved pay items** does not appear in the response at all. The response only shows currencies that have real data, not every currency the system knows about.

## Testing approach

The math part (`summarizeByCurrency`) was pulled out into its own function with no database calls. This makes it easy to test with simple, fixed input data, instead of depending on the shared database used by the route tests. The database part (`buildGlobalSummary`) has its own test: it adds a pay item to a draft cycle on purpose, then checks that this item is not counted in the totals.
