# payroll-api — Project Overview

This document explains what the project does and how it is put together, before going into the findings in [review.md](review.md).

## What the service does

`payroll-api` is a small backend service for running payroll in several countries. It exposes an HTTP API to manage countries, pay groups, payroll cycles, and pay items, plus one report endpoint that returns company-wide totals.

## Stack

- **Hono** — the web framework. It defines the HTTP routes.
- **Drizzle ORM** — translates between TypeScript and SQL (write a query in TypeScript, Drizzle turns it into SQL).
- **better-sqlite3** — the actual database engine, but running **in memory**. Nothing is saved to disk: every time the process starts, the database is created empty and filled again with sample data.
- **Vitest** — the test framework.

## How the service starts

Starting the app triggers a fixed sequence of steps:

1. [src/main.ts](../src/main.ts) is the entry point. It starts the HTTP server on a port.
2. It imports `app` from [src/server.ts](../src/server.ts), which defines all the routes.
3. `server.ts` imports `db` from [src/db/index.ts](../src/db/index.ts). Just importing this file does all of the setup:
   - Creates an in-memory SQLite database.
   - Turns on foreign key checks.
   - Runs [drizzle/0000_init.sql](../drizzle/0000_init.sql), the SQL file that creates the 5 tables.
   - Runs [src/db/seed.ts](../src/db/seed.ts), which inserts sample data (countries, employees, pay groups, cycles, pay items).
   - Wraps the database with Drizzle and exports it as `db`.

So the database is ready and full of data as soon as the module is loaded — no manual setup step is needed.

## Data model

```
countries        (code, name, currency)
  └── employees     (each employee belongs to one country)
  └── pay_groups    (a group of employees paid together; has its own frequency and currency)
        └── payroll_cycles   (one pay period, e.g. "May 2026"; has a status: draft / approved)
              └── pay_items  (one line of pay: earning / deduction / employer_cost, with an amount and a currency)
```

A payroll cycle belongs to one pay group. A pay item belongs to one payroll cycle and also points to one employee (`employee_id`), but that link is not enforced by a foreign key — see finding H1 in [review.md](review.md).

## API endpoints (in [src/server.ts](../src/server.ts))

| Method & Path | What it does |
|---|---|
| `GET /countries` | Lists all countries, each with its pay groups. |
| `GET /countries/:code/pay-groups` | Lists the pay groups for one country. |
| `POST /payroll-cycles` | Creates a new payroll cycle (status starts as `draft`), optionally with an initial list of pay items. |
| `GET /payroll-cycles/:id` | Fetches one payroll cycle. |
| `POST /payroll-cycles/:id/approve` | Sets a cycle's status to `approved`. |
| `GET /getPayItemsByCycle?cycleId=` | Lists the pay items of one cycle, with the employee's name attached. |
| `POST /pay-items` | Adds one pay item to a cycle. |
| `GET /pay-items?minAmount=&sort=` | Lists pay items, optionally filtered by minimum amount and sorted. |
| `GET /reports/global-summary` | Returns company-wide totals (earnings, deductions, employer cost), built by [src/report.ts](../src/report.ts). |

## Tests

[src/server.test.ts](../src/server.test.ts) calls the Hono app directly in-process (`app.request(...)`), with one test per endpoint. It runs against the same in-memory, seeded database described above.
