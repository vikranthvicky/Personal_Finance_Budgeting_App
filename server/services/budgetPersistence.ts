import type { Pool } from 'mysql2/promise'
import { isDeepStrictEqual } from 'node:util'
import { loadRelationalState, replaceRelationalState } from '../repository'
import type { AppState, Transaction } from '../../src/types'
import type { BudgetSnapshot } from '../validation/snapshot'

export function auditChanges(previous: AppState, next: AppState, at: string) {
  const events: AppState['audit'] = []
  const add = (message: string) => events.push({ id: `server:${crypto.randomUUID()}`, at, message })
  const categories = new Map(next.categories.map(category => [category.id, category.name]))
  const oldCategories = new Map(previous.categories.map(category => [category.id, category.name]))
  const oldMoves = new Map(previous.moves.map(move => [move.id, move]))
  const newMoves = new Map(next.moves.map(move => [move.id, move]))
  for (const move of next.moves) {
    const old = oldMoves.get(move.id)
    if (isDeepStrictEqual(old, move)) continue
    add(`${old ? 'Updated' : 'Moved'} ${move.amount.toFixed(2)} from ${oldCategories.get(move.fromCategoryId) ?? move.fromCategoryId} to ${categories.get(move.toCategoryId) ?? move.toCategoryId}${move.note ? ` · ${move.note}` : ''}`)
  }
  for (const move of previous.moves) if (!newMoves.has(move.id)) add(`Removed envelope move of ${move.amount.toFixed(2)} from ${oldCategories.get(move.fromCategoryId) ?? move.fromCategoryId} to ${oldCategories.get(move.toCategoryId) ?? move.toCategoryId}`)

  const oldPlans = new Map(previous.categories.map(category => [category.id, JSON.stringify({ planned: category.planned, rollover: category.rollover, cap: category.cap, periods: category.periods, plannedByMonth: category.plannedByMonth })]))
  for (const category of next.categories) {
    const oldCategory = previous.categories.find(item => item.id === category.id)
    if (oldCategory && oldCategory.name !== category.name) add(`Renamed envelope ${oldCategory.name} to ${category.name}`)
    const plan = JSON.stringify({ planned: category.planned, rollover: category.rollover, cap: category.cap, periods: category.periods, plannedByMonth: category.plannedByMonth })
    if (oldPlans.get(category.id) !== plan) add(`Updated plan for ${category.name}`)
  }
  for (const category of previous.categories) if (!next.categories.some(item => item.id === category.id)) add(`Removed ${category.name} from the plan`)

  const oldIncome = new Map(previous.income.map(item => [item.id, item]))
  const newIncome = new Map(next.income.map(item => [item.id, item]))
  for (const item of next.income) {
    const old = oldIncome.get(item.id)
    if (old && isDeepStrictEqual(old, item)) continue
    add(`${old ? 'Updated' : 'Added'} income source ${item.name} · ${item.amount.toFixed(2)}`)
  }
  for (const item of previous.income) if (!newIncome.has(item.id)) add(`Removed income source ${item.name} · ${item.amount.toFixed(2)}`)

  if (previous.currentBalance !== next.currentBalance) {
    add(`Updated current balance · ${(previous.currentBalance ?? 0).toFixed(2)} → ${(next.currentBalance ?? 0).toFixed(2)}`)
  }

  const oldTransactions = new Map(previous.transactions.map(transaction => [transaction.id, transaction]))
  const expenseFields = (item: Transaction) => {
    const { reimbursementAmount: _amount, reimbursementReceivedAmount: _received, reimbursementStatus: _status, reimbursements: _receipts, reimbursable: _reimbursable, ...fields } = item
    return fields
  }
  const recurringById = new Map([...previous.recurring, ...next.recurring].map(item => [item.id, item]))
  for (const transaction of next.transactions) {
    const old = oldTransactions.get(transaction.id)
    if (!old) {
      if (!transaction.scheduledOccurrenceId) add(`Added expense ${transaction.merchant} · ${transaction.amount.toFixed(2)} on ${transaction.date}`)
    } else if (!isDeepStrictEqual(old, transaction)) {
      const reimbursementOnly = isDeepStrictEqual(expenseFields(old), expenseFields(transaction))
      if (!reimbursementOnly && !transaction.scheduledOccurrenceId) add(`Updated expense ${transaction.merchant} · ${transaction.amount.toFixed(2)} on ${transaction.date}`)
    }
    if (!transaction.scheduledOccurrenceId || old) continue
    const recurringId = transaction.scheduledOccurrenceId.slice(0, transaction.scheduledOccurrenceId.lastIndexOf(':'))
    const item = recurringById.get(recurringId)
    add(`Posted recurring ${item?.kind ?? 'item'}: ${item?.name ?? transaction.merchant} · ${transaction.amount.toFixed(2)} on ${transaction.date}`)
  }
  for (const transaction of previous.transactions) if (!next.transactions.some(item => item.id === transaction.id) && !transaction.scheduledOccurrenceId) {
    add(`Removed expense ${transaction.merchant} · ${transaction.amount.toFixed(2)} on ${transaction.date}`)
  }

  const oldRecurring = new Map(previous.recurring.map(item => [item.id, item]))
  const newRecurring = new Map(next.recurring.map(item => [item.id, item]))
  for (const item of next.recurring) {
    const old = oldRecurring.get(item.id)
    if (old && isDeepStrictEqual(old, item)) continue
    add(`${old ? 'Updated' : 'Added'} recurring ${item.kind}: ${item.name} · ${item.amount.toFixed(2)}`)
  }
  for (const item of previous.recurring) if (!newRecurring.has(item.id)) add(`Removed recurring ${item.kind}: ${item.name} · ${item.amount.toFixed(2)}`)

  const oldAdjustments = new Map((previous.adjustments ?? []).map(item => [item.id, item]))
  const newAdjustments = new Map((next.adjustments ?? []).map(item => [item.id, item]))
  for (const item of next.adjustments ?? []) {
    const old = oldAdjustments.get(item.id)
    if (old && isDeepStrictEqual(old, item)) continue
    add(`${old ? 'Updated' : 'Added'} category adjustment · ${categories.get(item.categoryId) ?? item.categoryId} · ${item.amount.toFixed(2)}`)
  }
  for (const item of previous.adjustments ?? []) if (!newAdjustments.has(item.id)) add(`Removed category adjustment · ${oldCategories.get(item.categoryId) ?? item.categoryId} · ${item.amount.toFixed(2)}`)
  for (const transaction of next.transactions) {
    const old = oldTransactions.get(transaction.id)
    const received = (item: Transaction | undefined) => item?.reimbursements?.reduce((sum, receipt) => sum + receipt.amount, 0) ?? item?.reimbursementReceivedAmount ?? (item?.reimbursementStatus === 'received' ? item.reimbursementAmount ?? item.amount : 0)
    const increase = received(transaction) - received(old)
    if (increase > 0.000001) add(`Recorded reimbursement · ${transaction.merchant} · ${increase.toFixed(2)}`)
  }
  const received = (item: Transaction | undefined) => item?.reimbursements?.reduce((sum, receipt) => sum + receipt.amount, 0) ?? item?.reimbursementReceivedAmount ?? (item?.reimbursementStatus === 'received' ? item.reimbursementAmount ?? item.amount : 0)
  const expected = (item: Transaction | undefined) => item?.reimbursementAmount ?? (item?.reimbursable ? item.amount : 0)
  const nextTransactionIds = new Set(next.transactions.map(item => item.id))
  for (const transaction of previous.transactions) {
    if (nextTransactionIds.has(transaction.id)) continue
    const amount = received(transaction)
    if (amount > 0.000001) add(`Reversed reimbursement for removed expense ${transaction.merchant}: ${amount.toFixed(2)}`)
    const expectedAmount = expected(transaction)
    if (expectedAmount > 0.000001) add(`Removed reimbursement expectation for ${transaction.merchant}: ${expectedAmount.toFixed(2)}`)
  }
  for (const transaction of next.transactions) {
    const old = oldTransactions.get(transaction.id)
    const delta = received(transaction) - received(old)
    if (delta < -0.000001) add(`Reversed reimbursement Â· ${transaction.merchant} Â· ${Math.abs(delta).toFixed(2)} (received ${received(old).toFixed(2)} → ${received(transaction).toFixed(2)})`)
    const expectedBefore = expected(old)
    const expectedAfter = expected(transaction)
    if (Math.abs(expectedAfter - expectedBefore) > 0.000001) add(`Changed reimbursement expectation for ${transaction.merchant} Â· ${expectedBefore.toFixed(2)} → ${expectedAfter.toFixed(2)}`)
  }
  // Compare unordered relational collections by ID. Database reads use their own
  // stable ordering, which can differ from the order submitted by the browser.
  const oldRules = new Map(previous.rules.map(item => [item.id, item]))
  const nextRules = new Map(next.rules.map(item => [item.id, item]))
  for (const item of next.rules) {
    const old = oldRules.get(item.id)
    if (!old || !isDeepStrictEqual(old, item)) add(`${old ? 'Updated' : 'Added'} categorization rule: ${item.contains}`)
  }
  for (const item of previous.rules) if (!nextRules.has(item.id)) add(`Removed categorization rule: ${item.contains}`)
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
