import type { AppState, Category, EnvelopeMove, Recurring, ScheduleCadence, Transaction } from './types'

export const money = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value)
const cents = (value: number) => Math.round(value * 100)
const dollars = (value: number) => value / 100
const sumMoney = (values: number[]) => dollars(values.reduce((sum, value) => sum + cents(value), 0))
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0
export const budgetPeriod = (category: Category, month: string) => category.periods?.[month] ?? { planned: category.plannedByMonth?.[month] ?? category.planned, rollover: category.rollover, cap: category.cap }
export const plannedAmount = (category: Category, month: string) => budgetPeriod(category, month).planned
export const categorySpend = (categoryId: string, transactions: Transaction[]) => sumMoney(transactions.flatMap(tx => tx.splits?.length ? tx.splits.filter(s => s.categoryId === categoryId).map(split => split.amount) : tx.categoryId === categoryId ? [tx.amount] : []))
export const totalSpent = (transactions: Transaction[]) => sumMoney(transactions.map(tx => tx.amount))
export const reimbursementExpected = (transaction: Transaction) => transaction.reimbursementAmount ?? (transaction.reimbursable ? transaction.amount : 0)
export const reimbursementReceived = (transaction: Transaction) => transaction.reimbursements ? sumMoney(transaction.reimbursements.map(receipt => receipt.amount)) : transaction.reimbursementReceivedAmount !== undefined ? dollars(cents(transaction.reimbursementReceivedAmount)) : transaction.reimbursementStatus === 'received' ? reimbursementExpected(transaction) : 0
export const reimbursementOutstanding = (transaction: Transaction) => dollars(Math.max(0, cents(reimbursementExpected(transaction)) - cents(reimbursementReceived(transaction))))
export const reimbursementState = (transaction: Transaction) => reimbursementOutstanding(transaction) === 0 && reimbursementExpected(transaction) > 0 ? 'received' as const : 'pending' as const
export const totalReimbursementsReceived = (transactions: Transaction[]) => sumMoney(transactions.map(reimbursementReceived))
export const netSpent = (transactions: Transaction[]) => dollars(cents(totalSpent(transactions)) - cents(totalReimbursementsReceived(transactions)))
type RecurrenceRule = { cadence: ScheduleCadence; nextDate: string; day: number; secondDay?: number; intervalDays?: number; weekday?: number; weekOrdinal?: 1 | 2 | 3 | 4 | -1 }
const dateString = (date: Date) => {
  const year = date.getUTCFullYear()
  if (year < 1 || year > 9999) throw new RangeError('Scheduled occurrence falls outside supported date range.')
  return `${String(year).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}
const calendarDate = (year: number, month: number, day: number) => {
  const date = new Date(0)
  date.setUTCFullYear(year, month, day)
  date.setUTCHours(12, 0, 0, 0)
  return date
}
const dateParts = (date: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RangeError('Invalid schedule date.')
  const result = new Date(`${date}T12:00:00Z`)
  if (Number.isNaN(result.getTime()) || dateString(result) !== date) throw new RangeError('Invalid schedule date.')
  return result
}
export const isValidScheduleDate = (date: string) => { try { dateParts(date); return true } catch { return false } }
export const scheduledOccurrenceId = (scheduleId: string, date: string) => `${scheduleId}:${date}`
function nthWeekdayDate(year: number, month: number, weekday: number, ordinal: 1 | 2 | 3 | 4 | -1) {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new RangeError('Weekday must be between 0 and 6.')
  const lastDay = calendarDate(year, month + 1, 0).getUTCDate()
  if (ordinal === -1) {
    const last = calendarDate(year, month, lastDay)
    last.setUTCDate(lastDay - ((last.getUTCDay() - weekday + 7) % 7))
    return last
  }
  const firstWeekday = calendarDate(year, month, 1).getUTCDay()
  const day = 1 + ((weekday - firstWeekday + 7) % 7) + 7 * (ordinal - 1)
  if (day > lastDay) throw new RangeError('That nth weekday does not occur in the selected month.')
  return calendarDate(year, month, day)
}
export function nthWeekdayInMonth(month: string, weekday: number, ordinal: 1 | 2 | 3 | 4 | -1) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new RangeError('Invalid target month.')
  const [year, monthNumber] = month.split('-').map(Number)
  return dateString(nthWeekdayDate(year, monthNumber - 1, weekday, ordinal))
}
export function nextOccurrence(item: RecurrenceRule | (Pick<Recurring, 'cadence' | 'nextDate' | 'day' | 'secondDay' | 'intervalDays' | 'weekday' | 'weekOrdinal'>)) {
  const current = dateParts(item.nextDate)
  if (item.cadence === 'weekly' || item.cadence === 'biweekly' || item.cadence === 'custom') {
    const days = item.cadence === 'weekly' ? 7 : item.cadence === 'biweekly' ? 14 : Math.max(1, item.intervalDays ?? 1)
    current.setUTCDate(current.getUTCDate() + days)
    return dateString(current)
  }
  if (item.cadence === 'semimonthly') {
    const firstDay = Math.min(item.day, item.secondDay ?? 15); const secondDay = Math.max(item.day, item.secondDay ?? 15)
    const monthEnd = calendarDate(current.getUTCFullYear(), current.getUTCMonth() + 1, 0).getUTCDate(); const secondDate = Math.min(secondDay, monthEnd)
    if (current.getUTCDate() < secondDate) return dateString(calendarDate(current.getUTCFullYear(), current.getUTCMonth(), secondDate))
    const nextMonth = calendarDate(current.getUTCFullYear(), current.getUTCMonth() + 1, 1); const last = calendarDate(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth() + 1, 0).getUTCDate()
    return dateString(calendarDate(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth(), Math.min(firstDay, last)))
  }
  if (item.cadence === 'monthly-weekday') {
    if (item.weekday === undefined || item.weekOrdinal === undefined) throw new RangeError('Nth-weekday schedules need a weekday and ordinal.')
    const nextMonth = calendarDate(current.getUTCFullYear(), current.getUTCMonth() + 1, 1)
    return dateString(nthWeekdayDate(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth(), item.weekday, item.weekOrdinal))
  }
  const months = item.cadence === 'quarterly' ? 3 : item.cadence === 'yearly' ? 12 : 1
  const target = calendarDate(current.getUTCFullYear(), current.getUTCMonth() + months, 1)
  const day = Math.min(item.day, calendarDate(target.getUTCFullYear(), target.getUTCMonth() + 1, 0).getUTCDate())
  return dateString(calendarDate(target.getUTCFullYear(), target.getUTCMonth(), day))
}
export function scheduledTransactionFor(item: Pick<Recurring, 'id' | 'name' | 'kind' | 'amount' | 'categoryId'>, occurrenceDate: string): Transaction {
  if (!isValidScheduleDate(occurrenceDate) || !Number.isFinite(item.amount) || item.amount <= 0 || !item.id || !item.categoryId) throw new RangeError('A valid scheduled item and occurrence date are required.')
  const occurrenceId = scheduledOccurrenceId(item.id, occurrenceDate)
  return { id: `scheduled:${occurrenceId}`, scheduledOccurrenceId: occurrenceId, date: occurrenceDate, merchant: item.name, description: `Paid scheduled ${item.kind}`, amount: dollars(cents(item.amount)), categoryId: item.categoryId }
}
export function incomeDatesForMonth(item: { id?: string; frequency?: ScheduleCadence; startDate?: string; day?: number; secondDay?: number; intervalDays?: number; weekday?: number; weekOrdinal?: 1 | 2 | 3 | 4 | -1 }, month: string) {
  if (!item.frequency || !item.startDate) return [] // Legacy sources are monthly amounts without dated schedules.
  const start = dateParts(item.startDate)
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new RangeError('Invalid target month.')
  const monthStart = dateParts(`${month}-01`)
  const monthEnd = calendarDate(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0)
  if (start > monthEnd) return []
  let occurrence = item.startDate
  const rule: RecurrenceRule = { cadence: item.frequency, nextDate: occurrence, day: item.day ?? start.getUTCDate(), secondDay: item.secondDay, intervalDays: item.intervalDays, weekday: item.weekday, weekOrdinal: item.weekOrdinal }
  let guard = 0
  while (dateParts(occurrence) < monthStart && guard++ < 10000) {
    try { occurrence = nextOccurrence({ ...rule, nextDate: occurrence }) } catch { return [] }
  }
  const dates: string[] = []
  while (dateParts(occurrence) <= monthEnd && guard++ < 10000) {
    dates.push(occurrence)
    try { const next = nextOccurrence({ ...rule, nextDate: occurrence }); if (dateParts(next) > monthEnd) break; occurrence = next } catch { break }
  }
  return dates
}
export function scheduledAmountForMonth(item: { amount: number; frequency?: ScheduleCadence; startDate?: string; day?: number; secondDay?: number; intervalDays?: number; weekday?: number; weekOrdinal?: 1 | 2 | 3 | 4 | -1 }, month: string) {
  if (!item.frequency || !item.startDate) return item.amount // Legacy sources are monthly amounts.
  return incomeDatesForMonth(item, month).length * item.amount
}
export const totalIncome = (state: AppState, month = state.month) => sumMoney(state.income.map(item => scheduledAmountForMonth(item, month)))
export type CashFlowEvent = { date: string; scheduledDate?: string; label: string; kind: 'income' | 'bill' | 'transaction' | 'reimbursement' | 'estimate'; amount: number; occurrenceId?: string; balanceAfter: number; warning?: string }
export function cashFlowTimeline(state: AppState, currentBalance: number, startDate: string, horizonDays = 30, includePlanEstimates = true): CashFlowEvent[] {
  if (!isValidScheduleDate(startDate) || !Number.isFinite(currentBalance) || !Number.isInteger(horizonDays) || horizonDays < 0) throw new RangeError('A valid opening balance, date, and forecast horizon are required.')
  const end = dateParts(startDate); end.setUTCDate(end.getUTCDate() + horizonDays)
  const endDate = dateString(end)
  const events: Omit<CashFlowEvent, 'balanceAfter'>[] = []
  const targetMonths = new Set<string>()
  for (let month = dateParts(`${startDate.slice(0, 7)}-01`); dateString(month).slice(0, 7) <= endDate.slice(0, 7); month.setUTCMonth(month.getUTCMonth() + 1)) targetMonths.add(dateString(month).slice(0, 7))
  for (const source of state.income) {
    if (source.frequency && source.startDate) {
      for (const month of targetMonths) for (const date of incomeDatesForMonth(source, month)) {
        if (date > startDate && date <= endDate) events.push({ date, label: source.name, kind: 'income', amount: source.amount, occurrenceId: scheduledOccurrenceId(source.id, date) })
      }
    } else {
      const parsedDay = /(?:^|\D)(\d{1,2})(?:st|nd|rd|th)?(?:\D|$)/i.exec(source.cadence)?.[1]
      for (const month of targetMonths) {
      const first = dateParts(`${month}-01`); const lastDay = calendarDate(first.getUTCFullYear(), first.getUTCMonth() + 1, 0).getUTCDate()
        let dueDay = parsedDay ? Math.min(Number(parsedDay), lastDay) : 1
        if (/last weekday/i.test(source.cadence)) { dueDay = lastDay; const weekday = calendarDate(first.getUTCFullYear(), first.getUTCMonth(), dueDay).getUTCDay(); if (weekday === 0) dueDay -= 2; else if (weekday === 6) dueDay-- }
        const date = `${month}-${String(dueDay).padStart(2, '0')}`
        if (date > startDate && date <= endDate) events.push({ date, label: `${source.name}${parsedDay || /last weekday/i.test(source.cadence) ? '' : ' (estimated date)'}`, kind: 'income', amount: source.amount, occurrenceId: scheduledOccurrenceId(source.id, date) })
      }
    }
  }
  // The opening balance is assumed to already include activity through startDate.
  // Only later dated transactions and reimbursement receipts are applied again.
  const futureTransactions = state.transactions.filter(transaction => transaction.date > startDate && transaction.date <= endDate)
  const postedOccurrences = new Set(state.transactions.map(transaction => transaction.scheduledOccurrenceId).filter((id): id is string => Boolean(id)))
  for (const transaction of futureTransactions) events.push({ date: transaction.date, label: transaction.merchant || transaction.description || 'Recorded transaction', kind: 'transaction', amount: -transaction.amount, occurrenceId: transaction.id })
  for (const transaction of state.transactions) for (const receipt of transaction.reimbursements ?? []) {
    if (receipt.date > startDate && receipt.date <= endDate) events.push({ date: receipt.date, label: `${transaction.merchant || 'Expense'} reimbursement`, kind: 'reimbursement', amount: receipt.amount, occurrenceId: `${transaction.id}:reimbursement:${receipt.id}` })
  }
  const includedBillOccurrences = new Set<string>()
  for (const item of state.recurring.filter(row => row.active)) {
    let scheduledDate = item.nextDate; let guard = 0
    while (scheduledDate <= endDate && guard++ < 10000) {
      const occurrenceId = scheduledOccurrenceId(item.id, scheduledDate)
      if (!postedOccurrences.has(occurrenceId) && !includedBillOccurrences.has(occurrenceId)) {
        includedBillOccurrences.add(occurrenceId)
        const overdue = scheduledDate < startDate
        events.push({ date: overdue ? startDate : scheduledDate, scheduledDate, label: overdue ? `${item.name} (overdue, due ${scheduledDate})` : item.name, kind: 'bill', amount: -item.amount, occurrenceId })
      }
      try { scheduledDate = nextOccurrence({ ...item, nextDate: scheduledDate }) } catch { break }
    }
  }
  // Model remaining envelope allowances once per month. Known future transactions
  // are already included in categorySpend, while unpaid scheduled bills are removed
  // separately because their postings do not exist yet.
  const openingByCategory = new Map(state.categories.map(category => [category.id, rolloverAmount(category, state.transactions, startDate.slice(0, 7), state.moves, state.adjustments ?? [])]))
  if (includePlanEstimates) for (const month of targetMonths) {
    const first = dateParts(`${month}-01`); const monthEnd = calendarDate(first.getUTCFullYear(), first.getUTCMonth() + 1, 0); const calendarMonthEnd = dateString(monthEnd); const estimateDate = calendarMonthEnd > endDate ? endDate : calendarMonthEnd
    if (estimateDate < startDate) continue
    for (const category of state.categories) {
      const opening = openingByCategory.get(category.id) ?? 0
      // Only spending through this month's forecast cutoff belongs in the estimate.
      // Transactions later in a partial forecast month must remain in the future.
      const knownSpending = categorySpend(category.id, state.transactions.filter(transaction => transaction.date.startsWith(month) && transaction.date <= estimateDate))
      const movesThroughCutoffCents = cents(sumMoney(state.moves.filter(move => move.date.startsWith(month) && move.date <= estimateDate).map(move => move.toCategoryId === category.id ? move.amount : move.fromCategoryId === category.id ? -move.amount : 0)))
      const adjustmentsThroughCutoffCents = cents(sumMoney((state.adjustments ?? []).filter(item => item.categoryId === category.id && item.date.startsWith(month) && item.date <= estimateDate).map(item => item.amount)))
      const plannedAndAdjustedCents = cents(plannedAmount(category, month)) + cents(opening) + movesThroughCutoffCents + adjustmentsThroughCutoffCents
      const unpaidBillsCents = cents(sumMoney(events.filter(event => event.kind === 'bill' && event.date.startsWith(month) && event.date <= estimateDate && state.recurring.some(item => event.occurrenceId?.startsWith(`${item.id}:`) && item.categoryId === category.id)).map(event => -event.amount)))
      const remainingCents = plannedAndAdjustedCents - cents(knownSpending) - unpaidBillsCents
      if (remainingCents > 0) events.push({ date: estimateDate, label: `${category.name} remaining planned spending (estimate)`, kind: 'estimate', amount: -dollars(remainingCents), occurrenceId: `estimate:${month}:${category.id}` })
      const policy = budgetPeriod(category, month)
      // The estimate event spends any positive remainder through the cutoff, so
      // projected envelope rollover must include that modeled spending too.
      const closingCents = Math.min(0, remainingCents)
      const openingCents = policy.rollover === 'reset' ? 0 : policy.rollover === 'cap' ? Math.min(closingCents, cents(policy.cap ?? policy.planned)) : closingCents
      openingByCategory.set(category.id, dollars(openingCents))
    }
  }
  const eventOrder = { income: 0, reimbursement: 0, transaction: 1, bill: 1, estimate: 2 } as const
  events.sort((a, b) => compareText(a.date, b.date) || eventOrder[a.kind] - eventOrder[b.kind] || compareText(a.scheduledDate ?? a.date, b.scheduledDate ?? b.date) || compareText(a.occurrenceId ?? '', b.occurrenceId ?? '') || compareText(a.label, b.label) || cents(a.amount) - cents(b.amount))
  const openingBalance = dollars(cents(currentBalance))
  let projectedBalanceCents = cents(openingBalance)
  const balancesAfter = events.map(event => { projectedBalanceCents += cents(event.amount); return dollars(projectedBalanceCents) })
  const timeline: CashFlowEvent[] = []
  for (let index = 0; index < events.length; index++) {
    const event = events[index]; const before = index === 0 ? openingBalance : balancesAfter[index - 1]; const balance = balancesAfter[index]
    let warning: string | undefined
    if (before >= 0 && balance < 0) {
      const recoveryIndex = events.findIndex((row, candidate) => candidate > index && (row.kind === 'income' || row.kind === 'reimbursement') && row.amount > 0 && balancesAfter[candidate] >= 0)
      const recovery = recoveryIndex >= 0 ? events[recoveryIndex] : undefined
      warning = recovery ? `Risk window: ${event.label} leaves ${money(Math.abs(balance))} short until ${recovery.label} on ${recovery.date}.` : `Risk: ${event.label} leaves the projected balance below zero through the forecast horizon.`
    } else if (index === 0 && openingBalance < 0) {
      const recoveryIndex = events.findIndex((row, candidate) => candidate > index && (row.kind === 'income' || row.kind === 'reimbursement') && row.amount > 0 && balancesAfter[candidate] >= 0)
      const recovery = recoveryIndex >= 0 ? events[recoveryIndex] : undefined
      warning = recovery ? `Risk window: the opening balance is below zero until ${recovery.label} on ${recovery.date}.` : `Risk: the opening balance remains below zero through the forecast horizon.`
    }
    timeline.push({ ...event, balanceAfter: balance, warning })
  }
  return timeline
}
export function rolloverAmount(category: Category, transactions: Transaction[], month: string, moves: EnvelopeMove[] = [], adjustments: import('./types').CategoryAdjustment[] = []) {
  const relevantMonths = [...transactions.map(tx => tx.date.slice(0, 7)), ...moves.map(move => move.date.slice(0, 7)), ...adjustments.map(item => item.date.slice(0, 7)), ...Object.keys(category.plannedByMonth ?? {}), ...Object.keys(category.periods ?? {})].filter(value => value < month).sort()
  if (relevantMonths.length === 0) return 0
  let cursor = monthNumber(relevantMonths[0]); const finalPeriod = monthNumber(month) - 1
  let openingCents = 0
  while (cursor <= finalPeriod) {
    const period = monthString(cursor)
    const closingCents = cents(plannedAmount(category, period)) + openingCents + cents(movedAmount(category.id, moves, period)) + cents(adjustmentAmount(category.id, adjustments, period)) - cents(categorySpend(category.id, transactions.filter(tx => tx.date.startsWith(period))))
    const policy = budgetPeriod(category, period)
    openingCents = policy.rollover === 'reset' ? 0 : policy.rollover === 'cap' ? Math.min(closingCents, cents(policy.cap ?? policy.planned)) : closingCents
    cursor++
  }
  return dollars(openingCents)
}
function monthNumber(month: string) { const [year, value] = month.split('-').map(Number); return year * 12 + value - 1 }
function monthString(value: number) { const year = Math.floor(value / 12); const month = value % 12 + 1; return `${year}-${String(month).padStart(2, '0')}` }
export function adjustmentAmount(categoryId: string, adjustments: import('./types').CategoryAdjustment[], month: string) {
  return sumMoney(adjustments.filter(item => item.categoryId === categoryId && item.date.startsWith(month)).map(item => item.amount))
}
export function movedAmount(categoryId: string, moves: EnvelopeMove[], month: string) {
  return sumMoney(moves.filter(move => move.date.startsWith(month)).map(move => move.toCategoryId === categoryId ? move.amount : move.fromCategoryId === categoryId ? -move.amount : 0))
}
export function budgetRangeSummary(state: AppState, from: string, to: string) {
  if (!isValidScheduleDate(from) || !isValidScheduleDate(to) || from > to) throw new RangeError('Choose a valid date range.')
  const rows = state.categories.map(category => {
    const startMonth = from.slice(0, 7)
    const startDay = Number(from.slice(8, 10))
    const startMonthDate = dateParts(`${startMonth}-01`)
    const daysInStartMonth = calendarDate(startMonthDate.getUTCFullYear(), startMonthDate.getUTCMonth() + 1, 0).getUTCDate()
    let balance = dollars(cents(rolloverAmount(category, state.transactions, startMonth, state.moves, state.adjustments ?? [])) + cents(plannedAmount(category, startMonth) * (startDay - 1) / daysInStartMonth))
    const priorMoves = sumMoney(state.moves.filter(move => move.date >= `${startMonth}-01` && move.date < from).map(move => move.toCategoryId === category.id ? move.amount : move.fromCategoryId === category.id ? -move.amount : 0))
    const priorAdjustments = sumMoney((state.adjustments ?? []).filter(item => item.categoryId === category.id && item.date >= `${startMonth}-01` && item.date < from).map(item => item.amount))
    balance = dollars(cents(balance) + cents(priorMoves) + cents(priorAdjustments) - cents(categorySpend(category.id, state.transactions.filter(tx => tx.date.startsWith(startMonth) && tx.date < from))))
    let planned = 0
    let actual = 0
    let cursorMonth = monthNumber(startMonth)
    const finalMonth = to.slice(0, 7)
    while (monthString(cursorMonth) <= finalMonth) {
      const month = monthString(cursorMonth)
      const monthStart = `${month}-01`
      const monthEndDay = calendarDate(Math.floor(cursorMonth / 12), cursorMonth % 12 + 1, 0).getUTCDate()
      const monthEnd = `${month}-${String(monthEndDay).padStart(2, '0')}`
      const segmentStart = from > monthStart ? from : monthStart
      const segmentEnd = to < monthEnd ? to : monthEnd
      const days = Number(segmentEnd.slice(8, 10)) - Number(segmentStart.slice(8, 10)) + 1
      const allocated = dollars(cents(plannedAmount(category, month) * days / monthEndDay))
      const spent = categorySpend(category.id, state.transactions.filter(tx => tx.date >= segmentStart && tx.date <= segmentEnd))
      const transfers = sumMoney(state.moves.filter(move => move.date >= segmentStart && move.date <= segmentEnd && (move.fromCategoryId === category.id || move.toCategoryId === category.id)).map(move => move.toCategoryId === category.id ? move.amount : -move.amount))
      const adjustments = sumMoney((state.adjustments ?? []).filter(item => item.categoryId === category.id && item.date >= segmentStart && item.date <= segmentEnd).map(item => item.amount))
      planned = dollars(cents(planned) + cents(allocated))
      actual = dollars(cents(actual) + cents(spent))
      balance = dollars(cents(balance) + cents(allocated) + cents(transfers) + cents(adjustments) - cents(spent))
      if (segmentEnd === monthEnd && month < finalMonth) {
        const policy = budgetPeriod(category, month)
        balance = policy.rollover === 'reset' ? 0 : policy.rollover === 'cap' ? Math.min(balance, policy.cap ?? policy.planned) : balance
      }
      cursorMonth++
    }
    return { categoryId: category.id, planned, actual, available: balance }
  })
  return { categories: rows, planned: sumMoney(rows.map(row => row.planned)), actual: sumMoney(rows.map(row => row.actual)), available: sumMoney(rows.map(row => row.available)) }
}
export const availableFor = (category: Category, transactions: Transaction[], month: string, moves: EnvelopeMove[] = [], adjustments: import('./types').CategoryAdjustment[] = []) => dollars(cents(plannedAmount(category, month)) + cents(rolloverAmount(category, transactions, month, moves, adjustments)) + cents(movedAmount(category.id, moves, month)) + cents(adjustmentAmount(category.id, adjustments, month)) - cents(categorySpend(category.id, transactions.filter(tx => tx.date.startsWith(month)))))
export const progressFor = (category: Category, transactions: Transaction[], month: string, moves: EnvelopeMove[] = [], adjustments: import('./types').CategoryAdjustment[] = []) => {
  const allocatedCents = cents(plannedAmount(category, month)) + cents(rolloverAmount(category, transactions, month, moves, adjustments)) + cents(movedAmount(category.id, moves, month)) + cents(adjustmentAmount(category.id, adjustments, month))
  return allocatedCents > 0 ? Math.min(100, Math.round(cents(categorySpend(category.id, transactions.filter(tx => tx.date.startsWith(month)))) / allocatedCents * 10000) / 100) : 0
}
export const currentTransactions = (state: AppState) => state.transactions.filter(tx => tx.date.startsWith(state.month))
export function spendingAnomalies(state: AppState, asOfDate: string) {
  const selectedStart = dateParts(`${state.month}-01`)
  const asOf = dateParts(asOfDate)
  const elapsedDays = asOfDate.startsWith(state.month) ? asOf.getUTCDate() : calendarDate(selectedStart.getUTCFullYear(), selectedStart.getUTCMonth() + 1, 0).getUTCDate()
  const current = state.transactions.filter(tx => tx.date.startsWith(state.month) && tx.date.slice(8, 10) <= String(elapsedDays).padStart(2, '0'))
  const historicalMonths = Array.from({ length: 3 }, (_, index) => {
    const month = calendarDate(selectedStart.getUTCFullYear(), selectedStart.getUTCMonth() - index - 1, 1)
    return dateString(month).slice(0, 7)
  })
  return state.categories.flatMap(category => {
    const actual = categorySpend(category.id, current)
    const baseline = historicalMonths.reduce((sum, month) => {
      const rows = state.transactions.filter(tx => tx.date.startsWith(month) && tx.date.slice(8, 10) <= String(elapsedDays).padStart(2, '0'))
      return sum + categorySpend(category.id, rows)
    }, 0) / historicalMonths.length
    const ratio = baseline > 0 ? actual / baseline : 0
    return baseline > 0 && actual - baseline >= 20 && ratio >= 1.5 ? [{ categoryId: category.id, actual, baseline, ratio }] : []
  }).sort((a, b) => b.ratio - a.ratio || compareText(a.categoryId, b.categoryId))
}
export function sinkingFundSummary(item: Recurring, state: AppState) {
  const category = state.categories.find(row => row.id === item.categoryId)
  if (item.kind !== 'sinking' || !category) return null
  const funded = Math.max(0, availableFor(category, state.transactions, state.month, state.moves, state.adjustments ?? []))
  const contribution = plannedAmount(category, state.month)
  const monthsUntilDue = Math.max(0, monthNumber(item.nextDate.slice(0, 7)) - monthNumber(state.month))
  const remaining = Math.max(0, item.amount - funded)
  const monthlyNeeded = remaining / Math.max(1, monthsUntilDue)
  return { goal: item.amount, funded, contribution, progress: item.amount > 0 ? Math.min(100, funded / item.amount * 100) : 0, monthsRemaining: contribution > 0 ? Math.ceil(remaining / contribution) : null, monthsUntilDue, monthlyNeeded, onTrack: contribution >= monthlyNeeded }
}
export function matchingCategorizationRule(tx: Pick<Transaction, 'merchant' | 'description'> & Partial<Pick<Transaction, 'notes'>>, rules: AppState['rules']) {
  const words = `${tx.merchant} ${tx.description} ${tx.notes ?? ''}`.toLowerCase()
  return rules
    .filter(rule => rule.contains.trim() && words.includes(rule.contains.trim().toLowerCase()))
    .sort((a, b) => {
      const aPhrase = a.contains.trim().toLowerCase(), bPhrase = b.contains.trim().toLowerCase()
      return bPhrase.length - aPhrase.length || (aPhrase < bPhrase ? -1 : aPhrase > bPhrase ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    })[0]
}
export function suggestionFor(tx: Pick<Transaction, 'merchant' | 'description' | 'amount'> & Partial<Pick<Transaction, 'notes'>>, state: AppState) {
  const words = `${tx.merchant} ${tx.description} ${tx.notes ?? ''}`.toLowerCase()
  const rule = matchingCategorizationRule(tx, state.rules)
  if (rule) return { categoryId: rule.categoryId, confidence: 'High', reason: `Matches your saved “${rule.contains}” rule.` }
  const merchant = tx.merchant.trim().toLowerCase()
  const prior = merchant ? state.transactions.filter(item => item.merchant.trim().toLowerCase() === merchant && state.categories.some(c => c.id === item.categoryId)).sort((a, b) => b.date.localeCompare(a.date))[0] : undefined
  if (prior) return { categoryId: prior.categoryId, confidence: 'High', reason: `Similar to prior “${prior.merchant}” transactions you categorized this way.` }
  const priorText = state.transactions.filter(item => state.categories.some(c => c.id === item.categoryId) && `${item.description} ${item.notes ?? ''}`.trim().length > 0 && words.split(/\s+/).some(word => word.length >= 4 && `${item.description} ${item.notes ?? ''}`.toLowerCase().includes(word))).sort((a, b) => b.date.localeCompare(a.date))[0]
  if (priorText) return { categoryId: priorText.categoryId, confidence: 'Medium', reason: `Similar description or note appeared in “${priorText.merchant}”.` }
  const patterns: [RegExp, string, string][] = [[/grocery|market|produce|whole foods/i, 'food', 'The merchant or description looks like a grocery purchase.'], [/uber|lyft|transit|metro|fuel|gas station/i, 'transport', 'The merchant or description looks like transportation.'], [/pharmacy|doctor|clinic|dental|health/i, 'health', 'The merchant or description looks like health care.'], [/rent|electric|water|internet|utility/i, 'home', 'The merchant or description looks like a household bill.'], [/cafe|coffee|restaurant|cinema|movie|concert/i, 'fun', 'The merchant or description looks like dining or entertainment.']]
  const match = patterns.find(([pattern]) => pattern.test(words))
  const categoryId = match?.[1] ?? (tx.amount > 100 ? 'personal' : 'fun')
  return { categoryId, confidence: match ? 'Medium' : 'Low', reason: match?.[2] ?? 'There is no close match in your history; this is a low-confidence starting point.' }
}
function categoryByCue(state: AppState, cues: string[]) {
  return state.categories.find(category => cues.some(cue => `${category.id} ${category.name}`.toLowerCase().includes(cue)))
}
export function splitSuggestionFor(tx: Pick<Transaction, 'merchant' | 'description' | 'amount'>, state: AppState) {
  const cents = Math.round(tx.amount * 100)
  if (!Number.isFinite(cents) || cents <= 0) return null
  const merchant = tx.merchant.trim().toLowerCase()
  const prior = merchant ? state.transactions.filter(item => item.splits && item.splits.length > 1 && item.merchant.trim().toLowerCase() === merchant && item.amount > 0 && item.splits.every(line => state.categories.some(category => category.id === line.categoryId))).sort((a, b) => b.date.localeCompare(a.date))[0] : undefined
  if (prior) {
    const rows = prior.splits!.map((line, index, lines) => ({ categoryId: line.categoryId, amount: index === lines.length - 1 ? 0 : Math.round(cents * line.amount / prior.amount) / 100 })).map((line, index, lines) => index === lines.length - 1 ? { ...line, amount: Math.round((cents - lines.slice(0, -1).reduce((sum, row) => sum + row.amount * 100, 0))) / 100 } : line)
    return { rows, confidence: 'High', reason: `Based on your previous split at ${prior.merchant}.` }
  }
  const text = `${tx.merchant} ${tx.description}`.toLowerCase()
  const bulkStore = /\b(costco|sam'?s club|bj'?s wholesale|walmart|target)\b/.test(text)
  const food = categoryByCue(state, ['grocer', 'food'])
  const household = categoryByCue(state, ['household', 'home'])
  if (bulkStore && food && household && food.id !== household.id && cents >= 5000) {
    const groceries = Math.round(cents * 0.7)
    return { rows: [{ categoryId: food.id, amount: groceries / 100 }, { categoryId: household.id, amount: (cents - groceries) / 100 }], confidence: 'Low', reason: `A ${tx.merchant || 'bulk store'} purchase can include groceries and household items; this is a 70/30 starting estimate.` }
  }
  return null
}
export function reimbursableSuggestionFor(tx: Pick<Transaction, 'merchant' | 'description'> & Partial<Pick<Transaction, 'notes'>>) {
  const text = `${tx.merchant} ${tx.description} ${tx.notes ?? ''}`.toLowerCase()
  const cues: [RegExp, string][] = [
    [/\b(client|customer|prospect)\b.*\b(dinner|lunch|meal|coffee|meeting)\b|\b(dinner|lunch|meal|coffee|meeting)\b.*\b(client|customer|prospect)\b/i, 'Mentions a client or customer meal/meeting.'],
    [/\b(team|work|office)\b.*\b(lunch|dinner|meal|event)\b|\b(lunch|dinner|meal|event)\b.*\b(team|work|office)\b/i, 'Mentions a team or workplace meal/event.'],
    [/\b(work|business|employer|conference|mileage|business trip|work trip|project expense)\b/i, 'Mentions a work-related expense.'],
  ]
  const match = cues.find(([pattern]) => pattern.test(text))
  return match ? { confidence: 'Medium', reason: match[1] } : null
}
export function draftPlan(state: AppState) {
  const startMonth = monthString(monthNumber(state.month) - 3)
  const observations = 3 // Three completed calendar months, including months with no transactions.
  return state.categories.map(category => {
    const spend = state.transactions.filter(tx => tx.date.slice(0, 7) >= startMonth && tx.date.slice(0, 7) < state.month).reduce((sum, tx) => sum + (tx.splits?.length ? tx.splits.filter(s => s.categoryId === category.id).reduce((n, s) => n + s.amount, 0) : tx.categoryId === category.id ? tx.amount : 0), 0)
    const average = spend / observations
    const suggested = Math.max(0, Math.round(average / 10) * 10)
    const reason = spend === 0 ? `No recorded spending in the three completed months before ${state.month}; the suggestion is $0.` : `$${spend.toFixed(2)} spent across the three completed months before ${state.month} ($${average.toFixed(2)} per month, rounded to the nearest $10).`
    return { categoryId: category.id, current: plannedAmount(category, state.month), suggested, average, months: observations, spend, reason }
  })
}
export function upcomingBills(state: AppState) { return state.recurring.filter(item => item.active).slice().sort((a, b) => compareText(a.nextDate, b.nextDate) || compareText(a.id, b.id)) }
