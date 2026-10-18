# Pocketplan

Pocketplan is an envelope budgeting app built with React, TypeScript, Redux Toolkit, Express, and MySQL. It supports monthly plans, transactions and splits, reimbursements, recurring income and bills, cash flow forecasts, audit history, and explainable local suggestions.


## Requirements

- Node.js 22.13 or newer
- npm
- MySQL 8 or a compatible MySQL server

## Run Pocketplan

### 1. Prepare MySQL

Create the database first:

```sql
CREATE DATABASE pocketplan CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Create a MySQL user with permission to create tables and read/write data in that database. Copy `.env.example` to `.env` and set `MYSQL_URL`:

```dotenv
MYSQL_URL=mysql://pocketplan_app:your-password@localhost:3306/pocketplan
DATABASE_PATH=./data/pocketplan.sqlite
```

Create your local environment file from the example, then add your MySQL connection URL:

PowerShell:

```powershell
Copy-Item .env.example .env
```

macOS/Linux:

```bash
cp .env.example .env
```

`MYSQL_URL` is required. URL-encode special characters in the username or password. `DATABASE_PATH` is optional and is only used to import existing SQLite data when MySQL has no budgets; Pocketplan does not fall back to SQLite if MySQL is unavailable. `PORT` is optional and defaults to `4000`. Vite defaults to `5173` and proxies `/api` to the API server.

### 2. Install dependencies

From the project directory, install the Node.js packages:

```bash
npm install
```

### 3. Start the development app

Start both the Express API and Vite web app together:

```bash
npm run dev
```

Open `http://localhost:5173` in your browser. The API runs at `http://localhost:4000`; its health check is `http://localhost:4000/api/health`. Vite forwards `/api` requests to the API.

To run only one service, use separate terminals from the project directory:

```bash
npm run dev:api
npm run dev:web
```

The API needs `.env` and a reachable MySQL database. The web command serves the frontend only; API requests need the API service running as well.

### Production build

Build the frontend and server, then start the server that serves both the API and built frontend:

```bash
npm run build
npm start
```

The build type-checks the frontend and server and writes static assets to `dist`. Open `http://localhost:4000` after starting the server. Keep `.env` configured and MySQL running. The production health endpoint is `http://localhost:4000/api/health`.

## Database schema

The API creates the relational schema at startup (`server/schema.ts`). Records are scoped by `budget_id`; composite keys and foreign keys keep a budget's related records together.

| Table(s) | Purpose |
| --- | --- |
| `budgets` | Budget name, selected month, current balance, revision, and compatibility/recovery JSON snapshot. |
| `categories`, `budget_envelopes` | Envelope metadata and month-specific planned amounts and rollover policies. |
| `income_sources` | Income amount and optional recurrence schedule. |
| `transactions`, `transaction_splits` | Posted expenses and their optional category allocations. A transaction has one parent row; split lines reference it. |
| `recurring_rules`, `scheduled_occurrences` | Bill/subscription/sinking-fund schedules and stable per-date occurrence state. |
| `reimbursements`, `reimbursement_receipts` | Expected reimbursement and dated amounts actually received. |
| `fund_transfers`, `category_adjustments` | Dated envelope moves and manual balance adjustments, including notes. |
| `category_rules` | User-defined text match and destination envelope for categorization suggestions. |
| `audit_logs` | Human-readable record of user and scheduled-post changes. |
| `relational_migrations` | Tracks which snapshot revision has been copied into relational tables. |

Amounts use MySQL `DECIMAL(14,2)`. Splits, reimbursement receipts, transfers, and adjustments are stored as related rows, while the budget snapshot is also updated atomically for compatibility and recovery. After migration, normal API reads and writes use the relational records.

### Initialization and migration

On startup the API creates missing tables and compatibility columns. If MySQL contains no budgets and `DATABASE_PATH` points to existing Pocketplan SQLite data, that data is imported. If no budget exists after import, a demo budget is created. Each budget without a `relational_migrations` row is copied from `budgets.state_json` into relational tables in a transaction, then marked migrated.

Back up any SQLite database before its first import. For the MySQL integration test, use a separate disposable database; the test creates and updates records. Never point it at development or production data.

## Calculation notes

### Plans and rollovers

- A month-specific plan resolves in this order: `periods[month]`, `plannedByMonth[month]`, then the category's default `planned` amount. Rollover policy is likewise month-specific when a period is saved.
- To find an opening rollover, Pocketplan computes prior months in calendar order. Each closing balance is that month's plan plus opening rollover, net transfers, and adjustments, less spending assigned to the category.
- `carry` carries the full closing amount, including a negative balance. `reset` starts the following month at zero. `cap` applies an upper limit to the closing balance; overspending can still carry as a negative amount.
- Available balance for a month is its plan plus opening rollover, transfers, and adjustments, less that month's category spending. Split transactions count by their split lines for category balances; unsplit transactions count against their parent category.
- Monetary aggregation uses integer cents. Date-only schedule calculations use UTC calendar dates so results do not depend on the machine's timezone.

### Recurring schedules and postings

- Supported cadences are weekly, biweekly, twice monthly, monthly, nth weekday of a month, quarterly, yearly, and custom-day interval. Monthly, quarterly, and yearly dates clamp to the last valid day (for example, a 31st becomes the last day of a shorter month).
- Income schedules contribute on their generated dates. Legacy income sources without a full schedule use their cadence text to estimate a date for forecasting; the forecast labels estimated dates.
- Recurring bills are forecast as unpaid until a user chooses **Mark paid & post**. Posting takes an explicit scheduled date, checks that it is still the active rule's next date and that the budget revision is current, then writes a stable occurrence ID and transaction while advancing the schedule. Repeating a post for the same occurrence is idempotent and does not add another transaction.
- A posted occurrence is excluded from the unpaid-bill forecast. The forecast assumes the supplied current balance already includes activity through its start date, and it shows later recorded transactions, scheduled items, reimbursement receipts, and modeled remaining envelope spending as dated events. Modeled envelope spending is labeled as an estimate.
- A risk window is shown when a projected event takes the balance below zero. If an expected inflow restores a nonnegative balance within the horizon, the alert identifies that inflow and date. Expected income is not a confirmed deposit.

### Splits and reimbursements

- Split lines must total the parent transaction amount. Category reports allocate the split amounts; overall spending counts the parent once.
- Reimbursements reduce net spending only when receipt amounts are recorded. Pending expected reimbursement does not reduce spending. Receipts cannot exceed the expected amount.

## AI usage and external services

Pocketplan does not call a generative AI model or third-party AI, analytics, or categorization service. There is no AI provider key or external AI endpoint configured. “Smart” and “AI” labels in the interface refer to local, explainable suggestions implemented in `src/calculations.ts` and `src/App.tsx`:

- Category suggestions apply user rules first, then use prior transaction history, text cues, and an amount-based fallback. A confidence level and reason are shown.
- Split suggestions reuse a prior split from the same merchant or offer a low-confidence 70/30 groceries/household estimate for supported bulk-store merchants. Suggested lines can be edited before saving.
- Reimbursement suggestions use work, client, and team-meal wording. They only enable the flag after the user accepts; the expected amount remains editable.
- Plan drafts average a category's actual spending over the three completed months before the selected budget month, including months with no transactions, then round to the nearest $10. Drafts stay separate from actual transactions until applied.
- Spending alerts compare month-to-date category spending with the same elapsed dates in the prior three months. Forecast alerts use saved schedules, transactions, and envelope plans.

These features do not send transaction or budget data to an AI provider or other third party. The browser calls Pocketplan's own same-origin Express `/api` routes. Suggestions and alerts never move funds, change plans, categorize or split a saved transaction, or post a bill without an explicit user action.

## Tradeoffs and limits

- Suggestions are deterministic heuristics, not machine learning. They are easy to inspect and reproduce, but a phrase or merchant cue can be wrong. Review categories, splits, and reimbursement expectations before saving.
- The 70/30 bulk-store split is a generic starting estimate, not a receipt-based prediction. It is only offered when matching grocery/food and household/home envelopes exist.
- Plan drafts use a simple three-month average and nearest-$10 rounding. They do not forecast seasonality, income constraints, upcoming one-off events, or individual preferences; zero-spend months count as zero.
- Anomaly thresholds are intentionally simple: current month-to-date spend must be at least 1.5 times its same-period historical average and at least $20 higher. Sparse history may produce no alert or a misleading baseline.
- Forecasts depend on the current balance and saved schedules being accurate. Legacy payday dates can be estimates, and planned envelope spending is modeled rather than a prediction of actual purchases.
- The app presents amounts in USD. Schedule dates use explicit calendar-date rules; audit timestamps are event timestamps and therefore vary between runs.
- The relational database and `state_json` snapshot are both maintained during writes for compatibility and recovery. This eases migration but duplicates representations that must be kept in sync transactionally.

## External libraries

Direct dependencies are declared in `package.json`; exact resolved versions are in `package-lock.json`. Direct runtime dependencies:

| Library | Version range | Use |
| --- | --- | --- |
| React / React DOM | `^19.0.0` | User interface and rendering. |
| Redux Toolkit / React Redux | `^2.5.0` / `^9.2.0` | Client budget state and React bindings. |
| Express | `^5.1.0` | JSON API and static production server. |
| mysql2 | `^3.24.6` | MySQL connections and queries. |
| Zod | `^3.24.2` | API request and snapshot validation. |
| lucide-react | `^0.468.0` | Interface icons. |

Development and build dependencies include TypeScript (`~5.7.2`), Vite (`^6.1.0`) and `@vitejs/plugin-react` (`^4.3.4`), tsx (`^4.19.3`), concurrently (`^9.1.2`), PostCSS (`^8.5.3`), Autoprefixer (`^10.4.20`), Tailwind CSS (`^3.4.17`), and the `@types/*` declarations listed in `package.json`. They provide type checking, frontend build/dev serving, TypeScript API development, parallel development scripts, and CSS processing. The app uses the browser's built-in `fetch` for its own API and has no separate HTTP client dependency.

## Tests

Run the automated suite:

```bash
npm test
```

Calculation and schedule tests run without a database. The MySQL integration test is skipped unless `MYSQL_TEST_URL` is set. Configure it to a dedicated disposable test database; the test starts an API process, inserts a legacy JSON budget to exercise migration, and creates and updates test records.

PowerShell:

```powershell
$env:MYSQL_TEST_URL = 'mysql://test_user:password@localhost:3306/pocketplan_test'
npm test
```

The integration test covers relational migration and persistence, invalid API data, duplicate recurring occurrence posts, and concurrent revision conflicts.

## Conflict handling and audit history

- **Two edits to one transaction in this tab:** each edit is applied to the latest in-memory state. Saving a transaction, including split lines, replaces the full transaction as one validated unit; the last submitted edit wins. Split lines are never merged independently, and the parent total must still match their sum.
- **Edits from another tab or session:** saves use a revision check. A stale write is rejected, the app loads the saved version, and the user is asked to reapply their change. The app does not silently overwrite the newer saved transaction.
- **Category deletion:** when records reference an envelope, deletion requires confirmation and reassignment to another existing envelope. Transactions, split lines, recurring rules, transfers, adjustments, categorization rules, and saved plans are reassigned together.
- **Manual edits and automation:** rollover is derived from saved plans and history; it does not rewrite manual plan values. A recurring post is atomic with its next due date and audit record. If a manual edit reaches the server first, a stale post is rejected and must be retried from the refreshed state. If a post succeeds while a local edit is in flight, the posted occurrence is merged into the current local state; manual changes to the recurring rule are retained. A manual next-date edit takes precedence.
- **Audit history:** envelope moves record amount, source, destination, and note. Plan edits record changed amounts and rollover settings. Recurring posts record the occurrence and amount. Reimbursement receipts record the amount and any pending/received status transition. Audit entries are saved with the budget revision.
