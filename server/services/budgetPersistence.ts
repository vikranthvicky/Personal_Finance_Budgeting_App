import type { Pool } from 'mysql2/promise'
import { loadRelationalState, replaceRelationalState } from '../repository'
import type { AppState, Transaction } from '../../src/types'
import type { BudgetSnapshot } from '../validation/snapshot'

function auditChanges(previous: AppState, next: AppState, at: string) {
  const events: AppState['audit'] = []
  const add = (message: string) => events.push({ id: `server:${crypto.randomUUID()}`, at, message })
  const categories = new Map(next.categories.map(category => [category.id, category.name]))
  const oldCategories = new Map(previous.categories.map(category => [category.id, category.name]))
  const oldMoves = new Map(previous.moves.map(move => [move.id, move]))
  const newMoves = new Map(next.moves.map(move => [move.id, move]))
  for (const move of next.moves) {
    const old = oldMoves.get(move.id)
    if (JSON.stringify(old) === JSON.stringify(move)) continue
    add(`${old ? 'Updated' : 'Moved'} ${move.amount.toFixed(2)} from ${oldCategories.get(move.fromCategoryId) ?? move.fromCategoryId} to ${categories.get(move.toCategoryId) ?? move.toCategoryId}${move.note ? ` · ${move.note}` : ''}`)
  }
  for (const move of previous.moves) if (!newMoves.has(move.id)) add(`Removed envelope move of ${move.amount.toFixed(2)} from ${oldCategories.get(move.fromCategoryId) ?? move.fromCategoryId} to ${oldCategories.get(move.toCategoryId) ?? move.toCategoryId}`)

  const oldPlans = new Map(previous.categories.map(category => [category.id, JSON.stringify({ planned: category.planned, rollover: category.rollover, cap: category.cap, periods: category.periods, plannedByMonth: category.plannedByMonth })]))
  for (const category of next.categories) {
    const plan = JSON.stringify({ planned: category.planned, rollover: category.rollover, cap: category.cap, periods: category.periods, plannedByMonth: category.plannedByMonth })
    if (oldPlans.get(category.id) !== plan) add(`Updated plan for ${category.name}`)
  }
  for (const category of previous.categories) if (!next.categories.some(item => item.id === category.id)) add(`Removed ${category.name} from the plan`)

  const oldTransactions = new Map(previous.transactions.map(transaction => [transaction.id, transaction]))
  const recurringById = new Map([...previous.recurring, ...next.recurring].map(item => [item.id, item]))
  for (const transaction of next.transactions) {
    const old = oldTransactions.get(transaction.id)
    if (!transaction.scheduledOccurrenceId || old) continue
    const recurringId = transaction.scheduledOccurrenceId.slice(0, transaction.scheduledOccurrenceId.lastIndexOf(':'))
    const item = recurringById.get(recurringId)
    add(`Posted recurring ${item?.kind ?? 'item'}: ${item?.name ?? transaction.merchant} · ${transaction.amount.toFixed(2)} on ${transaction.date}`)
  }
  for (const transaction of next.transactions) {
    const old = oldTransactions.get(transaction.id)
    const received = (item: Transaction | undefined) => item?.reimbursements?.reduce((sum, receipt) => sum + receipt.amount, 0) ?? item?.reimbursementReceivedAmount ?? (item?.reimbursementStatus === 'received' ? item.reimbursementAmount ?? item.amount : 0)
    const increase = received(transaction) - received(old)
    if (increase > 0.000001) add(`Recorded reimbursement · ${transaction.merchant} · ${increase.toFixed(2)}`)
  }
  const financialFields = (state: AppState) => ({ currentBalance: state.currentBalance, income: state.income, categories: state.categories, transactions: state.transactions, recurring: state.recurring, moves: state.moves, adjustments: state.adjustments ?? [] })
  const financialChange = JSON.stringify(financialFields(previous)) !== JSON.stringify(financialFields(next))
  if (financialChange && events.length === 0) add('Financial records updated.')
  return events
}

export function createBudgetSaver(pool: Pool) {
  return async function saveBudget(value: BudgetSnapshot, expectedRevision: number, budgetId = 'default', uniqueOccurrenceId?: string): Promise<number | null | { duplicate: true; revision: number }> {
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

    // Audit from the locked database state. Never accept client-provided history.
    const previous = await loadRelationalState(connection, budgetId)
    if (previous) {
      value.audit = [...auditChanges(previous, value as AppState, now), ...previous.audit]
    }
    const serialized = JSON.stringify({ ...value, revision: nextRevision })
    const [result] = await connection.execute('UPDATE budgets SET state_json = ?, budget_month = ?, current_balance = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?', [serialized, value.month, value.currentBalance ?? null, now, budgetId, expectedRevision])
    if ((result as { affectedRows: number }).affectedRows === 0) { await connection.rollback(); return null }
    await replaceRelationalState(connection, budgetId, value as AppState)
    await connection.commit()
    return nextRevision
  } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
}
}
