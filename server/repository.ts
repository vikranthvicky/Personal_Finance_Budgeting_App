import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { AppState, Category, Recurring, Transaction } from '../src/types'
import { scheduledOccurrenceId } from '../src/calculations'

type SqlRow = RowDataPacket & Record<string, any>
const run = (connection: PoolConnection, sql: string, values: unknown[] = []) => connection.execute(sql, values as any[])
async function rows<T extends SqlRow = SqlRow>(connection: PoolConnection, sql: string, values: unknown[] = []) {
  const [result] = await connection.execute<T[]>(sql, values as any[])
  return result
}
async function bulk(connection: PoolConnection, sql: string, values: unknown[][]) {
  if (values.length) await connection.query(sql, [values] as any[])
}
const dateValue = (date?: string) => date || null
const numberValue = (value: unknown) => value === null || value === undefined ? undefined : Number(value)

export async function replaceRelationalState(connection: PoolConnection, budgetId: string, state: AppState) {
  // Child rows are removed first so every replacement remains valid under FKs.
  for (const table of ['reimbursement_receipts', 'reimbursements', 'transaction_splits', 'scheduled_occurrences', 'transactions', 'fund_transfers', 'category_adjustments', 'income_sources', 'recurring_rules', 'budget_envelopes', 'category_rules', 'categories']) {
    await run(connection, `DELETE FROM ${table} WHERE budget_id = ?`, [budgetId])
  }

  await bulk(connection, 'INSERT INTO categories (id,budget_id,name,color,icon,planned,rollover,rollover_cap) VALUES ?', state.categories.map(category => [category.id,budgetId,category.name,category.color,category.icon,category.planned,category.rollover,category.cap ?? null]))
  const envelopes: unknown[][] = []
  for (const category of state.categories) {
    const months = new Set([...Object.keys(category.plannedByMonth ?? {}), ...Object.keys(category.periods ?? {})])
    for (const month of months) {
      const period = category.periods?.[month] ?? { planned: category.plannedByMonth?.[month] ?? category.planned, rollover: category.rollover, cap: category.cap }
      envelopes.push([budgetId,category.id,month,period.planned,period.rollover,period.cap ?? null])
    }
  }
  await bulk(connection, 'INSERT INTO budget_envelopes (budget_id,category_id,budget_month,planned,rollover,rollover_cap) VALUES ?', envelopes)

  await bulk(connection, 'INSERT INTO income_sources (id,budget_id,name,amount,cadence,frequency,start_date,day,second_day,interval_days,weekday,week_ordinal) VALUES ?', state.income.map(item => [item.id,budgetId,item.name,item.amount,item.cadence,item.frequency ?? null,dateValue(item.startDate),item.day ?? null,item.secondDay ?? null,item.intervalDays ?? null,item.weekday ?? null,item.weekOrdinal ?? null]))
  await bulk(connection, 'INSERT INTO transactions (id,budget_id,transaction_date,merchant,description,amount,category_id,account,notes,scheduled_occurrence_id,reimbursable) VALUES ?', state.transactions.map(item => [item.id,budgetId,item.date,item.merchant,item.description,item.amount,item.categoryId || null,item.account ?? null,item.notes ?? null,item.scheduledOccurrenceId ?? null,item.reimbursable ?? false]))
  await bulk(connection, 'INSERT INTO transaction_splits (id,budget_id,transaction_id,category_id,amount) VALUES ?', state.transactions.flatMap(item => (item.splits ?? []).map(split => [split.id,budgetId,item.id,split.categoryId,split.amount])))

  const reimbursementRows: unknown[][] = []
  const receiptRows: unknown[][] = []
  for (const item of state.transactions) {
    if (!item.reimbursable) continue
    const expected = item.reimbursementAmount ?? item.amount
    const received = item.reimbursements?.reduce((sum, receipt) => sum + receipt.amount, 0) ?? item.reimbursementReceivedAmount ?? (item.reimbursementStatus === 'received' ? expected : 0)
    const status = item.reimbursementStatus ?? (Math.round(received * 100) >= Math.round(expected * 100) ? 'received' : 'pending')
    reimbursementRows.push([budgetId,item.id,expected,item.reimbursementReceivedAmount ?? null,status,item.reimbursements !== undefined])
    for (const receipt of item.reimbursements ?? []) receiptRows.push([receipt.id,budgetId,item.id,receipt.date,receipt.amount,receipt.note ?? null])
  }
  await bulk(connection, 'INSERT INTO reimbursements (budget_id,transaction_id,expected_amount,received_legacy_amount,status,has_receipt_list) VALUES ?', reimbursementRows)
  await bulk(connection, 'INSERT INTO reimbursement_receipts (id,budget_id,transaction_id,received_date,amount,note) VALUES ?', receiptRows)

  await bulk(connection, 'INSERT INTO recurring_rules (id,budget_id,name,amount,category_id,cadence,day,second_day,interval_days,weekday,week_ordinal,next_date,kind,active) VALUES ?', state.recurring.map(item => [item.id,budgetId,item.name,item.amount,item.categoryId,item.cadence,item.day,item.secondDay ?? null,item.intervalDays ?? null,item.weekday ?? null,item.weekOrdinal ?? null,item.nextDate,item.kind,item.active]))
  const occurrenceRows = new Map<string, unknown[]>()
  for (const item of state.transactions) if (item.scheduledOccurrenceId) {
    const separator = item.scheduledOccurrenceId.lastIndexOf(':')
    const recurringId = separator > 0 ? item.scheduledOccurrenceId.slice(0, separator) : null
    occurrenceRows.set(item.scheduledOccurrenceId, [budgetId,item.scheduledOccurrenceId,recurringId,item.date,'posted',item.id])
  }
  for (const item of state.recurring) {
    const occurrenceId = scheduledOccurrenceId(item.id, item.nextDate)
    if (!occurrenceRows.has(occurrenceId)) occurrenceRows.set(occurrenceId, [budgetId,occurrenceId,item.id,item.nextDate,'scheduled',null])
  }
  await bulk(connection, 'INSERT INTO scheduled_occurrences (budget_id,occurrence_id,recurring_id,scheduled_date,status,transaction_id) VALUES ?', [...occurrenceRows.values()])

  await bulk(connection, 'INSERT INTO fund_transfers (id,budget_id,transfer_date,from_category_id,to_category_id,amount,note) VALUES ?', state.moves.map(item => [item.id,budgetId,item.date,item.fromCategoryId,item.toCategoryId,item.amount,item.note]))
  await bulk(connection, 'INSERT INTO category_adjustments (id,budget_id,adjustment_date,category_id,amount,note) VALUES ?', (state.adjustments ?? []).map(item => [item.id,budgetId,item.date,item.categoryId,item.amount,item.note]))
  await bulk(connection, 'INSERT INTO category_rules (id,budget_id,contains_phrase,category_id) VALUES ?', state.rules.map(item => [item.id,budgetId,item.contains,item.categoryId]))
  await bulk(connection, 'INSERT IGNORE INTO audit_logs (budget_id,id,at,message) VALUES ?', state.audit.map(item => [budgetId,item.id,item.at,item.message]))
}

export async function loadRelationalState(connection: PoolConnection, budgetId: string): Promise<(AppState & { revision: number }) | null> {
  const budget = (await rows(connection, 'SELECT budget_month,current_balance,revision FROM budgets WHERE id = ?', [budgetId]))[0]
  if (!budget) return null
  const categoryRows = await rows(connection, 'SELECT id,name,color,icon,planned,rollover,rollover_cap FROM categories WHERE budget_id = ? ORDER BY name', [budgetId])
  const envelopeRows = await rows(connection, "SELECT category_id,budget_month,planned,rollover,rollover_cap FROM budget_envelopes WHERE budget_id = ? ORDER BY budget_month", [budgetId])
  const categories = categoryRows.map(row => {
    const periods: Category['periods'] = {}
    for (const period of envelopeRows.filter(item => item.category_id === row.id)) periods![period.budget_month] = { planned: Number(period.planned), rollover: period.rollover, cap: numberValue(period.rollover_cap) }
    return { id: row.id, name: row.name, color: row.color, icon: row.icon, planned: Number(row.planned), rollover: row.rollover, cap: numberValue(row.rollover_cap), ...(Object.keys(periods!).length ? { periods } : {}) }
  }) as Category[]
  const incomeRows = await rows(connection, "SELECT id,name,amount,cadence,frequency,DATE_FORMAT(start_date,'%Y-%m-%d') AS start_date,day,second_day,interval_days,weekday,week_ordinal FROM income_sources WHERE budget_id = ? ORDER BY id", [budgetId])
  const transactions = await rows(connection, "SELECT id,DATE_FORMAT(transaction_date,'%Y-%m-%d') AS date,merchant,description,amount,category_id,account,notes,scheduled_occurrence_id,reimbursable FROM transactions WHERE budget_id = ? ORDER BY transaction_date DESC,id", [budgetId])
  const splitRows = await rows(connection, 'SELECT id,transaction_id,category_id,amount FROM transaction_splits WHERE budget_id = ?', [budgetId])
  const reimbursementRows = await rows(connection, 'SELECT transaction_id,expected_amount,received_legacy_amount,status,has_receipt_list FROM reimbursements WHERE budget_id = ?', [budgetId])
  const receiptRows = await rows(connection, "SELECT id,transaction_id,DATE_FORMAT(received_date,'%Y-%m-%d') AS date,amount,note FROM reimbursement_receipts WHERE budget_id = ? ORDER BY received_date,id", [budgetId])
  const income = incomeRows.map(row => ({ id: row.id, name: row.name, amount: Number(row.amount), cadence: row.cadence, frequency: row.frequency ?? undefined, startDate: row.start_date ?? undefined, day: numberValue(row.day), secondDay: numberValue(row.second_day), intervalDays: numberValue(row.interval_days), weekday: numberValue(row.weekday), weekOrdinal: numberValue(row.week_ordinal) as 1 | 2 | 3 | 4 | -1 | undefined }))
  const txns = transactions.map(row => {
    const reimbursement = reimbursementRows.find(item => item.transaction_id === row.id)
    const receipts = receiptRows.filter(item => item.transaction_id === row.id)
    return {
      id: row.id, date: row.date, merchant: row.merchant, description: row.description, amount: Number(row.amount), categoryId: row.category_id ?? '',
      account: row.account ?? undefined, notes: row.notes ?? undefined, scheduledOccurrenceId: row.scheduled_occurrence_id ?? undefined, reimbursable: Boolean(row.reimbursable),
      ...(reimbursement ? { reimbursementAmount: Number(reimbursement.expected_amount), reimbursementReceivedAmount: numberValue(reimbursement.received_legacy_amount), reimbursementStatus: reimbursement.status, ...(reimbursement.has_receipt_list ? { reimbursements: receipts.map(receipt => ({ id: receipt.id, date: receipt.date, amount: Number(receipt.amount), note: receipt.note ?? undefined })) } : {}) } : {}),
      ...(splitRows.some(split => split.transaction_id === row.id) ? { splits: splitRows.filter(split => split.transaction_id === row.id).map(split => ({ id: split.id, categoryId: split.category_id, amount: Number(split.amount) })) } : {}),
    }
  }) as Transaction[]
  const recurringRows = await rows(connection, "SELECT id,name,amount,category_id,cadence,day,second_day,interval_days,weekday,week_ordinal,DATE_FORMAT(next_date,'%Y-%m-%d') AS next_date,kind,active FROM recurring_rules WHERE budget_id = ? ORDER BY next_date,id", [budgetId])
  const moveRows = await rows(connection, "SELECT id,DATE_FORMAT(transfer_date,'%Y-%m-%d') AS date,from_category_id,to_category_id,amount,note FROM fund_transfers WHERE budget_id = ? ORDER BY transfer_date,id", [budgetId])
  const adjustmentRows = await rows(connection, "SELECT id,DATE_FORMAT(adjustment_date,'%Y-%m-%d') AS date,category_id,amount,note FROM category_adjustments WHERE budget_id = ? ORDER BY adjustment_date,id", [budgetId])
  const auditRows = await rows(connection, 'SELECT id,at,message FROM audit_logs WHERE budget_id = ? ORDER BY at DESC,id', [budgetId])
  const ruleRows = await rows(connection, 'SELECT id,contains_phrase,category_id FROM category_rules WHERE budget_id = ? ORDER BY id', [budgetId])
  return {
    month: budget.budget_month, currentBalance: numberValue(budget.current_balance), revision: Number(budget.revision), income,
    categories, transactions: txns,
    recurring: recurringRows.map(row => ({ id: row.id, name: row.name, amount: Number(row.amount), categoryId: row.category_id ?? '', cadence: row.cadence, day: Number(row.day), secondDay: numberValue(row.second_day), intervalDays: numberValue(row.interval_days), weekday: numberValue(row.weekday), weekOrdinal: numberValue(row.week_ordinal), nextDate: row.next_date, kind: row.kind, active: Boolean(row.active) })) as Recurring[],
    moves: moveRows.map(row => ({ id: row.id, date: row.date, fromCategoryId: row.from_category_id, toCategoryId: row.to_category_id, amount: Number(row.amount), note: row.note ?? undefined })),
    adjustments: adjustmentRows.map(row => ({ id: row.id, date: row.date, categoryId: row.category_id, amount: Number(row.amount), note: row.note ?? undefined })),
    audit: auditRows.map(row => ({ id: row.id, at: row.at, message: row.message })),
    rules: ruleRows.map(row => ({ id: row.id, contains: row.contains_phrase, categoryId: row.category_id })),
  }
}
