import express from 'express'
import { aiRouter } from './routes/ai'
import { createBudgetRouter } from './routes/budgets'
import { DatabaseSync } from 'node:sqlite'
import mysql from 'mysql2/promise'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDemoState } from '../src/demo'
import type { AppState } from '../src/types'
import { relationalSchema } from './schema'
import { loadRelationalState, replaceRelationalState } from './repository'
import { createBudgetSaver } from './services/budgetPersistence'

const app = express()
const port = Number(process.env.PORT ?? 4000)
const dbPath = resolve(process.env.DATABASE_PATH ?? './data/pocketplan.sqlite')
if (!process.env.MYSQL_URL) throw new Error('MYSQL_URL is required. Configure a MySQL connection before starting Pocketplan.')
const pool = mysql.createPool(process.env.MYSQL_URL)
app.use(express.json({ limit: '2mb' }))

async function queryAll<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await pool.query(sql, params as any[]); return rows as T[]
}
async function queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const [rows] = await pool.query(sql, params as any[]); return (rows as T[])[0]
}
async function loadBudgetState(budgetId: string) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const state = await loadRelationalState(connection, budgetId)
    await connection.commit()
    return state
  } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
}
async function execute(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
  const [result] = await pool.execute(sql, params as any[]); return { changes: (result as { affectedRows: number }).affectedRows }
}
async function initializeStorage() {
    for (const statement of relationalSchema) await pool.query(statement)
    const [budgetColumns] = await pool.query('SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'budgets\'')
    const columnNames = new Set((budgetColumns as { COLUMN_NAME: string }[]).map(column => column.COLUMN_NAME))
    if (!columnNames.has('budget_month')) await pool.query("ALTER TABLE budgets ADD COLUMN budget_month CHAR(7) NOT NULL DEFAULT '1970-01'")
    if (!columnNames.has('current_balance')) await pool.query('ALTER TABLE budgets ADD COLUMN current_balance DECIMAL(14,2) NULL')
    const [transactionCategoryColumns] = await pool.query("SELECT IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND COLUMN_NAME = 'category_id'")
    if ((transactionCategoryColumns as { IS_NULLABLE: string }[])[0]?.IS_NULLABLE === 'NO') await pool.query('ALTER TABLE transactions MODIFY category_id VARCHAR(64) NULL')
    const existing = await queryOne<{ id: string }>('SELECT id FROM budgets LIMIT 1')
    if (!existing && existsSync(dbPath)) {
      let legacyDb: DatabaseSync | undefined
      try {
        legacyDb = new DatabaseSync(dbPath)
        const tables = legacyDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
        if (tables.some(table => table.name === 'budgets')) {
          const legacyBudgets = legacyDb.prepare('SELECT id, name, state_json, revision, created_at, updated_at FROM budgets').all() as { id: string; name: string; state_json: string; revision: number; created_at: string; updated_at: string }[]
          for (const budget of legacyBudgets) await execute('INSERT IGNORE INTO budgets (id, name, state_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [budget.id, budget.name, budget.state_json, budget.revision, budget.created_at, budget.updated_at])
        } else if (tables.some(table => table.name === 'app_state')) {
          const cols = legacyDb.prepare('PRAGMA table_info(app_state)').all() as { name: string }[]
          const revisionCol = cols.some(col => col.name === 'revision') ? 'revision' : '1 AS revision'
          const legacy = legacyDb.prepare(`SELECT state_json, ${revisionCol}, updated_at FROM app_state WHERE id = 1`).get() as { state_json: string; revision: number; updated_at: string } | undefined
          if (legacy) await execute('INSERT IGNORE INTO budgets (id, name, state_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', ['default', 'Personal budget', legacy.state_json, legacy.revision, legacy.updated_at, legacy.updated_at])
        }
      } catch (error) { console.warn('Could not import the existing SQLite budget; starting MySQL with a fresh budget.', error) } finally { legacyDb?.close() }
    }
    const afterMigration = await queryOne<{ id: string }>('SELECT id FROM budgets LIMIT 1')
    if (!afterMigration) { const initial = createDemoState(); const now = new Date().toISOString(); await execute('INSERT INTO budgets (id, name, budget_month, current_balance, state_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)', ['default', 'Personal budget', initial.month, initial.currentBalance ?? null, JSON.stringify(initial), now, now]) }

    const storedBudgets = await queryAll<{ id: string; state_json: string; revision: number }>('SELECT id, state_json, revision FROM budgets')
    for (const stored of storedBudgets) {
      const migrated = await queryOne<{ budget_id: string }>('SELECT budget_id FROM relational_migrations WHERE budget_id = ?', [stored.id])
      if (migrated) continue
      const raw = JSON.parse(stored.state_json) as AppState
      const state: AppState = { ...raw, income: raw.income ?? [], categories: raw.categories ?? [], transactions: raw.transactions ?? [], recurring: raw.recurring ?? [], moves: raw.moves ?? [], adjustments: raw.adjustments ?? [], audit: raw.audit ?? [], rules: raw.rules ?? [] }
      const connection = await pool.getConnection()
      try {
        await connection.beginTransaction()
        await connection.execute('UPDATE budgets SET budget_month = ?, current_balance = ? WHERE id = ?', [state.month, state.currentBalance ?? null, stored.id])
        await replaceRelationalState(connection, stored.id, state)
        await connection.execute('INSERT INTO relational_migrations (budget_id,migrated_at,source_revision) VALUES (?,?,?)', [stored.id, new Date().toISOString(), stored.revision])
        await connection.commit()
      } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
    }
}

app.get('/api/health', (_req, res) => res.json({ ok: true, storage: 'mysql' }))
// AI requests are proxied server-side so the OpenRouter key never reaches the browser.
app.use('/api', aiRouter)
const save = createBudgetSaver(pool)

app.use('/api', createBudgetRouter({ pool, queryAll, queryOne, loadBudgetState, save }))

const here = dirname(fileURLToPath(import.meta.url))
app.use(express.static(resolve(here, '../dist')))
app.get('*path', (_req, res) => res.sendFile(resolve(here, '../dist/index.html')))
initializeStorage().then(() => app.listen(port, () => console.log(`Pocketplan API listening at http://localhost:${port} (mysql)`))).catch(error => {
  console.error('Could not initialize the budget database.', error)
  process.exitCode = 1
})
