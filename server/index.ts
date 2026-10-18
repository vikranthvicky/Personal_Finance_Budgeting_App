import express from 'express'
import { DatabaseSync } from 'node:sqlite'
import mysql from 'mysql2/promise'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { createDemoState } from '../src/demo'
import type { AppState } from '../src/types'
import { isValidScheduleDate, nextOccurrence, nthWeekdayInMonth, scheduledOccurrenceId, scheduledTransactionFor } from '../src/calculations'
import { relationalSchema } from './schema'
import { loadRelationalState, replaceRelationalState } from './repository'

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
app.get('/api/budgets', async (_req, res) => {
  res.json(await queryAll('SELECT id, name, created_at AS createdAt, updated_at AS updatedAt FROM budgets ORDER BY created_at'))
})
app.post('/api/budgets', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
  if (!name || name.length > 60) return res.status(400).json({ error: 'Budget name must be between 1 and 60 characters.' })
  const sourceId = typeof req.body?.sourceId === 'string' ? req.body.sourceId : 'default'
  const source = await loadBudgetState(sourceId)
  if (!source) return res.status(404).json({ error: 'Source budget not found.' })
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    await connection.execute('INSERT INTO budgets (id,name,budget_month,current_balance,state_json,revision,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)', [id,name,source.month,source.currentBalance ?? null,JSON.stringify({ ...source, revision: 1 }),now,now])
    await replaceRelationalState(connection, id, source)
    await connection.execute('INSERT INTO relational_migrations (budget_id,migrated_at,source_revision) VALUES (?,?,1)', [id, now])
    await connection.commit()
  } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
  res.status(201).json({ id, name, createdAt: now, updatedAt: now })
})
app.get('/api/state', async (req, res) => {
  const budgetId = String(req.query.budgetId ?? 'default')
  const current = await loadBudgetState(budgetId)
  if (!current) return res.status(404).json({ error: 'Budget not found.' })
  res.setHeader('ETag', `"${current.revision}"`)
  res.json(current)
})

const splitSchema = z.object({ id: z.string().min(1), categoryId: z.string().min(1), amount: z.number().finite().positive() })
const reimbursementReceiptSchema = z.object({ id: z.string().trim().min(1).max(128), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), amount: z.number().finite().positive(), note: z.string().optional() })
const hasMoreThanTwoDecimals = (value: number) => Math.abs(value * 100 - Math.round(value * 100)) > 1e-8
const transactionSchema = z.object({
  id: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), merchant: z.string(), description: z.string(), amount: z.number().finite().positive(), categoryId: z.string().min(1),
  account: z.string().optional(), notes: z.string().optional(), scheduledOccurrenceId: z.string().min(1).optional(), reimbursable: z.boolean().optional(), reimbursementAmount: z.number().finite().nonnegative().optional(), reimbursementReceivedAmount: z.number().finite().nonnegative().optional(), reimbursementStatus: z.enum(['pending', 'received']).optional(), reimbursements: z.array(reimbursementReceiptSchema).optional(),
  // One-line splits can exist in legacy/imported snapshots; treat them exactly
  // like a regular single-category transaction while preserving their metadata.
  splits: z.array(splitSchema).min(1).optional(),
}).passthrough().superRefine((transaction, ctx) => {
  if (hasMoreThanTwoDecimals(transaction.amount)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Transaction amount can have at most two decimal places.', path: ['amount'] })
  const date = new Date(`${transaction.date}T12:00:00`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== transaction.date) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid transaction date.', path: ['date'] })
  if (transaction.splits) {
    transaction.splits.forEach((split, index) => { if (hasMoreThanTwoDecimals(split.amount)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Split amounts can have at most two decimal places.', path: ['splits', index, 'amount'] }) })
    const splitCents = transaction.splits.reduce((sum, split) => sum + Math.round(split.amount * 100), 0)
    if (splitCents !== Math.round(transaction.amount * 100)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Split amounts must equal the transaction total.', path: ['splits'] })
    if (transaction.splits[0]?.categoryId !== transaction.categoryId) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'The primary category must match the first split.', path: ['categoryId'] })
    const splitIds = new Set<string>()
    transaction.splits.forEach((split, index) => { if (splitIds.has(split.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Split IDs must be unique within a transaction.', path: ['splits', index, 'id'] }); splitIds.add(split.id) })
  }
  if ((transaction.reimbursementAmount ?? 0) > transaction.amount) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Reimbursement cannot exceed the original expense.', path: ['reimbursementAmount'] })
  const expected = transaction.reimbursementAmount ?? (transaction.reimbursable ? transaction.amount : 0)
  const receiptTotal = transaction.reimbursements?.reduce((sum, receipt) => sum + receipt.amount, 0)
  const received = receiptTotal ?? transaction.reimbursementReceivedAmount ?? (transaction.reimbursementStatus === 'received' ? expected : 0)
  if (transaction.reimbursable && expected <= 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Reimbursable expenses need a positive expected amount.', path: ['reimbursementAmount'] })
  if (transaction.reimbursementAmount !== undefined && hasMoreThanTwoDecimals(transaction.reimbursementAmount)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected reimbursement can have at most two decimal places.', path: ['reimbursementAmount'] })
  if (transaction.reimbursementReceivedAmount !== undefined && hasMoreThanTwoDecimals(transaction.reimbursementReceivedAmount)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Received reimbursement can have at most two decimal places.', path: ['reimbursementReceivedAmount'] })
  if (Math.round(received * 100) > Math.round(expected * 100)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Received reimbursements cannot exceed the expected amount.', path: ['reimbursements'] })
  if (received > 0 && !transaction.reimbursable) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Transactions with reimbursements must be marked reimbursable.', path: ['reimbursable'] })
  if (!transaction.reimbursable && (transaction.reimbursementStatus !== undefined || transaction.reimbursements !== undefined || (transaction.reimbursementAmount ?? 0) > 0 || (transaction.reimbursementReceivedAmount ?? 0) > 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Reimbursement details require the reimbursable flag.', path: ['reimbursable'] })
  if (receiptTotal !== undefined && transaction.reimbursementReceivedAmount !== undefined && Math.round(receiptTotal * 100) !== Math.round(transaction.reimbursementReceivedAmount * 100)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Recorded receipts must match the received reimbursement total.', path: ['reimbursementReceivedAmount'] })
  const expectedStatus = expected > 0 && Math.round(received * 100) === Math.round(expected * 100) ? 'received' : 'pending'
  if (transaction.reimbursable && transaction.reimbursementStatus !== undefined && transaction.reimbursementStatus !== expectedStatus) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Reimbursement status must be ${expectedStatus} for the recorded amount.`, path: ['reimbursementStatus'] })
  const receiptIds = new Set<string>()
  transaction.reimbursements?.forEach((receipt, index) => {
    if (!isValidScheduleDate(receipt.date) || receipt.date < transaction.date) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Reimbursement receipt date must be valid and on or after the original expense date.', path: ['reimbursements', index, 'date'] })
    if (hasMoreThanTwoDecimals(receipt.amount)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Receipt amounts can have at most two decimal places.', path: ['reimbursements', index, 'amount'] })
    const normalizedId = receipt.id.trim()
    if (!normalizedId) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Receipt IDs cannot be empty.', path: ['reimbursements', index, 'id'] })
    if (receiptIds.has(normalizedId)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Reimbursement receipt IDs must be unique.', path: ['reimbursements', index, 'id'] })
    receiptIds.add(normalizedId)
  })
})
const cadenceSchema = z.enum(['weekly', 'biweekly', 'semimonthly', 'monthly', 'monthly-weekday', 'quarterly', 'yearly', 'custom'])
const categorySchema = z.object({ id: z.string().min(1), name: z.string().trim().min(1, 'Category name cannot be empty.'), color: z.string().min(1), icon: z.string().min(1), planned: z.number().finite().nonnegative(), plannedByMonth: z.record(z.number().finite().nonnegative()).optional(), periods: z.record(z.object({ planned: z.number().finite().nonnegative(), rollover: z.enum(['carry', 'reset', 'cap']), cap: z.number().finite().nonnegative().optional() })).optional(), rollover: z.enum(['carry', 'reset', 'cap']), cap: z.number().finite().nonnegative().optional() }).passthrough().superRefine((category, ctx) => {
  for (const month of Object.keys(category.periods ?? {})) if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Budget periods must use YYYY-MM keys.', path: ['periods', month] })
})
const moveSchema = z.object({ id: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), fromCategoryId: z.string().min(1), toCategoryId: z.string().min(1), amount: z.number().finite().positive(), note: z.string() }).passthrough()
const adjustmentSchema = z.object({ id: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), categoryId: z.string().min(1), amount: z.number().finite(), note: z.string() }).passthrough()
const ruleSchema = z.object({ id: z.string().min(1), contains: z.string().min(1), categoryId: z.string().min(1) }).passthrough()
const ordinalSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(-1)])
const incomeSchema = z.object({ id: z.string().min(1), name: z.string().trim().min(1, 'Income name cannot be empty.'), amount: z.number().finite().positive(), cadence: z.string(), frequency: cadenceSchema.optional(), startDate: z.string().optional(), day: z.number().int().min(1).max(31).optional(), secondDay: z.number().int().min(1).max(31).optional(), intervalDays: z.number().int().positive().optional(), weekday: z.number().int().min(0).max(6).optional(), weekOrdinal: ordinalSchema.optional() }).passthrough().superRefine((income, ctx) => {
  if (income.frequency && !income.startDate) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Scheduled income needs a first pay date.', path: ['startDate'] })
  if (income.startDate && !isValidScheduleDate(income.startDate)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Scheduled income has an invalid first pay date.', path: ['startDate'] })
  if (income.frequency === 'custom' && !income.intervalDays) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Custom income needs an interval.', path: ['intervalDays'] })
  if (income.frequency === 'semimonthly' && !income.secondDay) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Twice-monthly income needs a second day.', path: ['secondDay'] })
  if (income.frequency === 'semimonthly' && income.secondDay === income.day) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Twice-monthly income needs two different days.', path: ['secondDay'] })
  if (income.frequency === 'monthly-weekday' && (income.weekday === undefined || income.weekOrdinal === undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Monthly weekday income needs an ordinal and weekday.', path: ['weekOrdinal'] })
  if (income.frequency === 'monthly-weekday' && income.startDate && income.weekday !== undefined && income.weekOrdinal !== undefined) {
    try { if (nthWeekdayInMonth(income.startDate.slice(0, 7), income.weekday, income.weekOrdinal) !== income.startDate) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'First income date must match its nth-weekday rule.', path: ['startDate'] }) } catch { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid monthly weekday schedule.', path: ['startDate'] }) }
  }
  if (income.frequency && income.startDate) { try { nextOccurrence({ cadence: income.frequency, nextDate: income.startDate, day: income.day ?? Number(income.startDate.slice(8, 10)), secondDay: income.secondDay, intervalDays: income.intervalDays, weekday: income.weekday, weekOrdinal: income.weekOrdinal }) } catch { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Income schedule exceeds the supported date range or is invalid.', path: ['startDate'] }) } }
})
const recurringSchema = z.object({ id: z.string().min(1), name: z.string().trim().min(1, 'Recurring item name cannot be empty.'), amount: z.number().finite().positive(), categoryId: z.string().min(1), cadence: cadenceSchema, day: z.number().int().min(1).max(31), secondDay: z.number().int().min(1).max(31).optional(), intervalDays: z.number().int().positive().optional(), weekday: z.number().int().min(0).max(6).optional(), weekOrdinal: ordinalSchema.optional(), nextDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), kind: z.enum(['bill', 'subscription', 'sinking']), active: z.boolean() }).passthrough().superRefine((item, ctx) => {
  if (hasMoreThanTwoDecimals(item.amount)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Recurring amount can have at most two decimal places.', path: ['amount'] })
  if (!isValidScheduleDate(item.nextDate)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid next occurrence date.', path: ['nextDate'] })
  if (item.cadence === 'custom' && !item.intervalDays) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Custom schedules need an interval.', path: ['intervalDays'] })
  if (item.cadence === 'semimonthly' && !item.secondDay) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Twice monthly schedules need a second day.', path: ['secondDay'] })
  if (item.cadence === 'semimonthly' && item.secondDay === item.day) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Twice monthly schedules need two different days.', path: ['secondDay'] })
  if (item.cadence === 'monthly-weekday' && (item.weekday === undefined || item.weekOrdinal === undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Monthly weekday schedules need an ordinal and weekday.', path: ['weekOrdinal'] })
  if (item.cadence === 'monthly-weekday' && item.weekday !== undefined && item.weekOrdinal !== undefined) {
    try { if (nthWeekdayInMonth(item.nextDate.slice(0, 7), item.weekday, item.weekOrdinal) !== item.nextDate) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Next date must match the nth-weekday rule.', path: ['nextDate'] }) } catch { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid monthly weekday schedule.', path: ['nextDate'] }) }
  }
  try { nextOccurrence(item) } catch { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Schedule exceeds the supported date range or is invalid.', path: ['nextDate'] }) }
})
const snapshot = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), revision: z.number().int().positive(), currentBalance: z.number().finite().optional(), income: z.array(incomeSchema), categories: z.array(categorySchema), transactions: z.array(transactionSchema), recurring: z.array(recurringSchema), moves: z.array(moveSchema).default([]), adjustments: z.array(adjustmentSchema).optional(), audit: z.array(z.object({ id: z.string(), at: z.string(), message: z.string() })), rules: z.array(ruleSchema) }).passthrough().superRefine((state, ctx) => {
  const categoryIds = new Set(state.categories.map(category => category.id))
  if (categoryIds.size !== state.categories.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Category IDs must be unique.', path: ['categories'] })
  for (const [label, rows] of [['income', state.income], ['transactions', state.transactions], ['recurring', state.recurring], ['moves', state.moves], ['audit', state.audit], ['rules', state.rules]] as const) {
    const ids = new Set<string>()
    rows.forEach((row, index) => { if (ids.has(row.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} IDs must be unique.`, path: [label, index, 'id'] }); ids.add(row.id) })
  }
  const occurrenceIds = new Set<string>()
  for (const [index, transaction] of state.transactions.entries()) {
    if (!categoryIds.has(transaction.categoryId)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Transaction references an unknown category.', path: ['transactions', index, 'categoryId'] })
    for (const [splitIndex, split] of (transaction.splits ?? []).entries()) {
      if (!categoryIds.has(split.categoryId)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Split references an unknown category.', path: ['transactions', index, 'splits', splitIndex, 'categoryId'] })
    }
    if (transaction.scheduledOccurrenceId) {
      if (occurrenceIds.has(transaction.scheduledOccurrenceId)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Scheduled occurrence has already been posted.', path: ['transactions', index, 'scheduledOccurrenceId'] })
      occurrenceIds.add(transaction.scheduledOccurrenceId)
    }
  }
  for (const [index, item] of state.recurring.entries()) {
    if (!categoryIds.has(item.categoryId)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Recurring item references an unknown category.', path: ['recurring', index, 'categoryId'] })
    if (item.kind === 'sinking') {
      const category = state.categories.find(row => row.id === item.categoryId)
      if (category && (category.rollover !== 'carry' || category.periods?.[state.month]?.rollover === 'reset')) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Sinking funds need an envelope configured to carry forward.', path: ['recurring', index, 'categoryId'] })
    }
  }
  for (const [index, move] of state.moves.entries()) {
    if (move.fromCategoryId === move.toCategoryId) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Transfers need two different categories.', path: ['moves', index] })
    if (!categoryIds.has(move.fromCategoryId) || !categoryIds.has(move.toCategoryId)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Transfer references an unknown category.', path: ['moves', index] })
  }
  for (const [index, adjustment] of (state.adjustments ?? []).entries()) if (!categoryIds.has(adjustment.categoryId)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Adjustment references an unknown category.', path: ['adjustments', index, 'categoryId'] })
  for (const [index, rule] of state.rules.entries()) if (!categoryIds.has(rule.categoryId)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Rule references an unknown category.', path: ['rules', index, 'categoryId'] })
})
async function save(value: z.infer<typeof snapshot>, expectedRevision: number, budgetId = 'default', uniqueOccurrenceId?: string): Promise<number | null | { duplicate: true; revision: number }> {
  const nextRevision = expectedRevision + 1
  const now = new Date().toISOString()
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    // Serialize scheduled posts for this budget before checking the occurrence.
    // The occurrence primary key and transaction unique key remain the final DB guards.
    const [budgetRows] = await connection.execute('SELECT revision FROM budgets WHERE id = ? FOR UPDATE', [budgetId])
    const currentRevision = (budgetRows as { revision: number }[])[0]?.revision
    if (currentRevision === undefined) { await connection.rollback(); return null }
    if (uniqueOccurrenceId) {
      const [occurrenceRows] = await connection.execute('SELECT status FROM scheduled_occurrences WHERE budget_id = ? AND occurrence_id = ? FOR UPDATE', [budgetId, uniqueOccurrenceId])
      if ((occurrenceRows as { status: string }[])[0]?.status === 'posted') {
        await connection.rollback()
        return { duplicate: true, revision: currentRevision }
      }
    }
    if (currentRevision !== expectedRevision) { await connection.rollback(); return null }

    // Compare and audit against the locked revision. Both the new financial rows
    // and their audit rows are written by replaceRelationalState in this transaction.
    const previous = await loadRelationalState(connection, budgetId)
    if (previous) {
      const financialFields = (state: AppState) => ({
        currentBalance: state.currentBalance,
        income: state.income,
        categories: state.categories,
        transactions: state.transactions,
        recurring: state.recurring,
        moves: state.moves,
        adjustments: state.adjustments ?? [],
      })
      const financialChange = JSON.stringify(financialFields(previous)) !== JSON.stringify(financialFields(value as AppState))
      const previousAuditIds = new Set(previous.audit.map(entry => entry.id))
      const hasNewAudit = value.audit.some(entry => !previousAuditIds.has(entry.id))
      if (financialChange && !hasNewAudit) {
        value.audit = [{ id: `server:${crypto.randomUUID()}`, at: now, message: 'Financial records updated.' }, ...value.audit].slice(0, 250)
      }
    }
    const serialized = JSON.stringify({ ...value, revision: nextRevision })
    const [result] = await connection.execute('UPDATE budgets SET state_json = ?, budget_month = ?, current_balance = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?', [serialized, value.month, value.currentBalance ?? null, now, budgetId, expectedRevision])
    if ((result as { affectedRows: number }).affectedRows === 0) { await connection.rollback(); return null }
    await replaceRelationalState(connection, budgetId, value as AppState)
    await connection.commit()
    return nextRevision
  } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
}

app.post('/api/recurring/:id/post', async (req, res) => {
  const budgetId = String(req.query.budgetId ?? 'default')
  const stored = await loadBudgetState(budgetId)
  if (!stored) return res.status(404).json({ error: 'Budget not found.' })
  const state = stored as AppState & { revision: number }
  const item = (state.recurring ?? []).find((row: any) => row.id === req.params.id)
  if (!item) return res.status(404).json({ error: 'Recurring item not found.' })
  const occurrenceDate = String(req.body?.occurrenceDate ?? '')
  if (!isValidScheduleDate(occurrenceDate)) return res.status(400).json({ error: 'Invalid occurrence date.' })
  const occurrenceId = scheduledOccurrenceId(item.id, occurrenceDate)
  const existing = (state.transactions ?? []).find((tx: any) => tx.scheduledOccurrenceId === occurrenceId || tx.id === `scheduled:${occurrenceId}`)
  if (existing) return res.json({ ok: true, duplicate: true, state })
  if (Number(req.body?.revision) !== stored.revision) return res.status(409).json({ error: 'This budget was updated elsewhere.', revision: stored.revision })
  if (!item.active || item.nextDate !== occurrenceDate) return res.status(409).json({ error: 'This occurrence is no longer scheduled.' })
  const categoryExists = (state.categories ?? []).some((category: any) => category.id === item.categoryId)
  if (!categoryExists || !Number.isFinite(item.amount) || item.amount <= 0) return res.status(400).json({ error: 'The recurring item has invalid amount or category data.' })
  const transaction = scheduledTransactionFor(item, occurrenceDate)
  state.transactions = [transaction, ...(state.transactions ?? [])]
  state.recurring = state.recurring.map((row: any) => row.id === item.id ? { ...row, nextDate: nextOccurrence(row) } : row)
  state.audit = [{ id: `scheduled-audit:${occurrenceId}`, at: new Date().toISOString(), message: `Posted scheduled ${item.kind}: ${item.name} · ${item.amount}` }, ...(state.audit ?? [])].slice(0, 250)
  const parsed = snapshot.safeParse(state)
  if (!parsed.success) return res.status(400).json({ error: 'Recurring post produced an invalid state snapshot.', details: parsed.error.issues })
  const revision = await save(parsed.data, stored.revision, budgetId, occurrenceId)
  if (revision && typeof revision === 'object') {
    const latest = await loadBudgetState(budgetId)
    return res.json({ ok: true, duplicate: true, state: latest })
  }
  if (revision === null) return res.status(409).json({ error: 'This budget was updated elsewhere.' })
  res.json({ ok: true, duplicate: false, revision, state: { ...parsed.data, revision } })
})

app.put('/api/state', async (req, res) => {
  const budgetId = String(req.query.budgetId ?? 'default')
  const parsed = snapshot.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'The budget snapshot contains invalid transactions or missing required fields.', details: parsed.error.issues })
  const revision = await save(parsed.data, parsed.data.revision, budgetId)
  if (revision === null) {
    const latest = await queryOne<{ revision: number }>('SELECT revision FROM budgets WHERE id = ?', [budgetId])
    if (!latest) return res.status(404).json({ error: 'Budget not found.' })
    return res.status(409).json({ error: 'This budget was updated elsewhere. Reload the latest version before saving.', revision: latest.revision })
  }
  res.json({ ok: true, revision })
})

const here = dirname(fileURLToPath(import.meta.url))
app.use(express.static(resolve(here, '../dist')))
app.get('*path', (_req, res) => res.sendFile(resolve(here, '../dist/index.html')))
initializeStorage().then(() => app.listen(port, () => console.log(`Pocketplan API listening at http://localhost:${port} (mysql)`))).catch(error => {
  console.error('Could not initialize the budget database.', error)
  process.exitCode = 1
})
