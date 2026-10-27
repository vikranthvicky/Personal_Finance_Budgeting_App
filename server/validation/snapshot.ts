import { z } from 'zod'
import { isValidScheduleDate, nextOccurrence, nthWeekdayInMonth } from '../../src/calculations'

const splitSchema = z.object({ id: z.string().min(1), categoryId: z.string().min(1), amount: z.number().finite().positive() })
const reimbursementReceiptSchema = z.object({ id: z.string().trim().min(1).max(128), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), amount: z.number().finite().positive(), note: z.string().optional() })
const hasMoreThanTwoDecimals = (value: number) => Math.abs(value * 100 - Math.round(value * 100)) > 1e-8
const transactionSchema = z.object({
  id: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), merchant: z.string(), description: z.string(), amount: z.number().finite().positive(), categoryId: z.string(),
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
export const snapshot = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), revision: z.number().int().positive(), currentBalance: z.number().finite().optional(), income: z.array(incomeSchema), categories: z.array(categorySchema), transactions: z.array(transactionSchema), recurring: z.array(recurringSchema), moves: z.array(moveSchema).default([]), adjustments: z.array(adjustmentSchema).optional(), audit: z.array(z.object({ id: z.string(), at: z.string(), message: z.string() })), rules: z.array(ruleSchema) }).passthrough().superRefine((state, ctx) => {
  const categoryIds = new Set(state.categories.map(category => category.id))
  if (categoryIds.size !== state.categories.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Category IDs must be unique.', path: ['categories'] })
  for (const [label, rows] of [['income', state.income], ['transactions', state.transactions], ['recurring', state.recurring], ['moves', state.moves], ['audit', state.audit], ['rules', state.rules]] as const) {
    const ids = new Set<string>()
    rows.forEach((row, index) => { if (ids.has(row.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} IDs must be unique.`, path: [label, index, 'id'] }); ids.add(row.id) })
  }
  const occurrenceIds = new Set<string>()
  for (const [index, transaction] of state.transactions.entries()) {
    if (transaction.categoryId && !categoryIds.has(transaction.categoryId)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Transaction references an unknown category.', path: ['transactions', index, 'categoryId'] })
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

export type BudgetSnapshot = z.infer<typeof snapshot>
