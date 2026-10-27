import { Router } from 'express'
import type { Pool } from 'mysql2/promise'
import { replaceRelationalState } from '../repository'
import { prepareRecurringPost } from '../services/recurringPost'
import { snapshot, type BudgetSnapshot } from '../validation/snapshot'
import { budgetPeriod } from '../../src/calculations'
import type { AppState } from '../../src/types'

type QueryAll = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>
type QueryOne = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | undefined>
type SaveResult = number | null | { duplicate: true; revision: number }

interface BudgetRoutesDependencies {
  pool: Pool
  queryAll: QueryAll
  queryOne: QueryOne
  loadBudgetState: (budgetId: string) => Promise<(AppState & { revision: number }) | null | undefined>
  save: (value: BudgetSnapshot, expectedRevision: number, budgetId?: string, uniqueOccurrenceId?: string) => Promise<SaveResult>
}

export function createBudgetRouter({ pool, queryAll, queryOne, loadBudgetState, save }: BudgetRoutesDependencies) {
  const router = Router()

  router.get('/budgets', async (_req, res) => {
    res.json(await queryAll('SELECT id, name, created_at AS createdAt, updated_at AS updatedAt FROM budgets ORDER BY created_at'))
  })

  router.post('/budgets', async (req, res) => {
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
      await connection.execute('INSERT INTO budgets (id,name,budget_month,current_balance,state_json,revision,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)', [id, name, source.month, source.currentBalance ?? null, JSON.stringify({ ...source, revision: 1 }), now, now])
      await replaceRelationalState(connection, id, source)
      await connection.execute('INSERT INTO relational_migrations (budget_id,migrated_at,source_revision) VALUES (?,?,1)', [id, now])
      await connection.commit()
    } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
    res.status(201).json({ id, name, createdAt: now, updatedAt: now })
  })

  router.post('/budgets/:id/duplicate-next-month', async (req, res) => {
    const source = await loadBudgetState(req.params.id)
    if (!source) return res.status(404).json({ error: 'Source budget not found.' })
    const [year, month] = source.month.split('-').map(Number)
    const nextMonthDate = new Date(Date.UTC(year, month, 1))
    const nextMonth = nextMonthDate.toISOString().slice(0, 7)
    const sourceName = await queryOne<{ name: string }>('SELECT name FROM budgets WHERE id = ?', [req.params.id])
    if (!sourceName) return res.status(404).json({ error: 'Source budget not found.' })
    const name = `${sourceName.name} (${nextMonth})`.slice(0, 60)
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    const nextState: AppState = {
      ...source,
      month: nextMonth,
      categories: source.categories.map(category => ({
        ...category,
        periods: { ...category.periods, [nextMonth]: { ...budgetPeriod(category, source.month) } },
      })),
      audit: [{ id: crypto.randomUUID(), at: now, message: `Duplicated ${source.month} budget into ${nextMonth}` }, ...source.audit].slice(0, 250),
    }
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.execute('INSERT INTO budgets (id,name,budget_month,current_balance,state_json,revision,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)', [id, name, nextMonth, source.currentBalance ?? null, JSON.stringify({ ...nextState, revision: 1 }), now, now])
      await replaceRelationalState(connection, id, nextState)
      await connection.execute('INSERT INTO relational_migrations (budget_id,migrated_at,source_revision) VALUES (?,?,1)', [id, now])
      await connection.commit()
    } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
    res.status(201).json({ id, name, month: nextMonth })
  })

  router.patch('/budgets/:id', async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    if (!name || name.length > 60) return res.status(400).json({ error: 'Budget name must be between 1 and 60 characters.' })
    const updatedAt = new Date().toISOString()
    const result = await pool.execute('UPDATE budgets SET name = ?, updated_at = ? WHERE id = ?', [name, updatedAt, req.params.id])
    if ((result[0] as { affectedRows: number }).affectedRows === 0) {
      const existing = await queryOne<{ id: string }>('SELECT id FROM budgets WHERE id = ?', [req.params.id])
      if (!existing) return res.status(404).json({ error: 'Budget not found.' })
    }
    res.json({ id: req.params.id, name, updatedAt })
  })

  router.delete('/budgets/:id', async (req, res) => {
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const [rows] = await connection.query('SELECT id FROM budgets FOR UPDATE')
      const budgets = rows as { id: string }[]
      if (!budgets.some(budget => budget.id === req.params.id)) {
        await connection.rollback()
        return res.status(404).json({ error: 'Budget not found.' })
      }
      if (budgets.length <= 1) {
        await connection.rollback()
        return res.status(409).json({ error: 'Keep at least one budget. Create another budget before deleting this one.' })
      }
      await connection.execute('DELETE FROM budgets WHERE id = ?', [req.params.id])
      await connection.commit()
      res.json({ ok: true, id: req.params.id })
    } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
  })

  router.get('/state', async (req, res) => {
    const budgetId = String(req.query.budgetId ?? 'default')
    const current = await loadBudgetState(budgetId)
    if (!current) return res.status(404).json({ error: 'Budget not found.' })
    res.setHeader('ETag', `"${current.revision}"`)
    res.json(current)
  })

  router.put('/state', async (req, res) => {
    const budgetId = String(req.query.budgetId ?? 'default')
    const parsed = snapshot.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: 'The budget snapshot contains invalid transactions or missing required fields.', details: parsed.error.issues })
    const revision = await save(parsed.data, parsed.data.revision, budgetId)
    if (revision === null) {
      const latest = await queryOne<{ revision: number }>('SELECT revision FROM budgets WHERE id = ?', [budgetId])
      if (!latest) return res.status(404).json({ error: 'Budget not found.' })
      return res.status(409).json({ error: 'This budget was updated elsewhere. Reload the latest version before saving.', revision: latest.revision })
    }
    res.json({ ok: true, revision, audit: parsed.data.audit })
  })

  router.post('/recurring/:id/post', async (req, res) => {
    const budgetId = String(req.query.budgetId ?? 'default')
    const stored = await loadBudgetState(budgetId)
    if (!stored) return res.status(404).json({ error: 'Budget not found.' })
    const outcome = prepareRecurringPost(stored, String(req.params.id), String(req.body?.occurrenceDate ?? ''), Number(req.body?.revision))
    if (outcome.kind === 'not-found') return res.status(404).json({ error: 'Recurring item not found.' })
    if (outcome.kind === 'invalid-date') return res.status(400).json({ error: 'Invalid occurrence date.' })
    if (outcome.kind === 'duplicate') return res.json({ ok: true, duplicate: true, state: stored })
    if (outcome.kind === 'revision-conflict') return res.status(409).json({ error: 'This budget was updated elsewhere.', revision: stored.revision })
    if (outcome.kind === 'schedule-conflict') return res.status(409).json({ error: 'This occurrence is no longer scheduled.' })
    if (outcome.kind === 'invalid-item') return res.status(400).json({ error: 'The recurring item has invalid amount or category data.' })
    const parsed = snapshot.safeParse(outcome.state)
    if (!parsed.success) return res.status(400).json({ error: 'Recurring post produced an invalid state snapshot.', details: parsed.error.issues })
    const revision = await save(parsed.data, stored.revision, budgetId, outcome.occurrenceId)
    if (revision && typeof revision === 'object') {
      const latest = await loadBudgetState(budgetId)
      return res.json({ ok: true, duplicate: true, state: latest })
    }
    if (revision === null) return res.status(409).json({ error: 'This budget was updated elsewhere.' })
    res.json({ ok: true, duplicate: false, revision, state: { ...parsed.data, revision } })
  })

  return router
}
