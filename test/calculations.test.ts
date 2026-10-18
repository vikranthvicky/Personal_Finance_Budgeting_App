import assert from 'node:assert/strict'
import test from 'node:test'
import {
  availableFor,
  cashFlowTimeline,
  categorySpend,
  draftPlan,
  matchingCategorizationRule,
  netSpent,
  nextOccurrence,
  nthWeekdayInMonth,
  plannedAmount,
  reimbursementOutstanding,
  reimbursementReceived,
  rolloverAmount,
  scheduledTransactionFor,
  scheduledOccurrenceId,
  sinkingFundSummary,
  splitSuggestionFor,
  reimbursableSuggestionFor,
  spendingAnomalies,
  suggestionFor,
  totalSpent,
} from '../src/calculations.ts'
import type { AppState, Category, Transaction } from '../src/types.ts'

const category = (overrides: Partial<Category> = {}): Category => ({
  id: 'food', name: 'Food', color: '#123456', icon: 'food', planned: 500, rollover: 'carry', ...overrides,
})

test('uses month-specific plans and computes available funds from rollover and spending', () => {
  const groceries = category({
    planned: 900,
    periods: {
      '2026-09': { planned: 500, rollover: 'carry' },
      '2026-10': { planned: 1200, rollover: 'carry' },
    },
  })
  const expenses: Transaction[] = [
    { id: 'sep', date: '2026-09-10', merchant: 'Shop', description: '', amount: 100, categoryId: 'food' },
    { id: 'oct', date: '2026-10-10', merchant: 'Shop', description: '', amount: 200, categoryId: 'food' },
  ]
  assert.equal(plannedAmount(groceries, '2026-09'), 500)
  assert.equal(rolloverAmount(groceries, expenses, '2026-10'), 400)
  assert.equal(availableFor(groceries, expenses, '2026-10'), 1400)
  assert.equal(availableFor(groceries, expenses, '2026-09'), 400)
})

test('rollover supports reset and capped policies', () => {
  const expenses: Transaction[] = [{ id: 'tx', date: '2026-09-10', merchant: 'Shop', description: '', amount: 100, categoryId: 'food' }]
  const reset = category({ periods: { '2026-09': { planned: 500, rollover: 'reset' } } })
  const capped = category({ periods: { '2026-09': { planned: 500, rollover: 'cap', cap: 250 } } })
  assert.equal(rolloverAmount(reset, expenses, '2026-10'), 0)
  assert.equal(rolloverAmount(capped, expenses, '2026-10'), 250)
})

test('rollover is cent-exact and independent of transaction array order', () => {
  const groceries = category({ planned: 1 })
  const expenses: Transaction[] = [0.1, 0.2, 0.3].map((amount, index) => ({ id: `c${index}`, date: '2026-09-10', merchant: 'Shop', description: '', amount, categoryId: 'food' }))
  assert.equal(categorySpend('food', expenses), 0.6)
  assert.equal(rolloverAmount(groceries, expenses, '2026-10'), 0.4)
  assert.equal(rolloverAmount(groceries, [...expenses].reverse(), '2026-10'), 0.4)
})

test('split transactions count parent spending once and allocate category totals to split lines', () => {
  const transaction: Transaction = {
    id: 'split', date: '2026-10-10', merchant: 'Store', description: '', amount: 1000, categoryId: 'food',
    splits: [
      { id: 's1', categoryId: 'food', amount: 600 },
      { id: 's2', categoryId: 'transport', amount: 400 },
    ],
  }
  assert.equal(totalSpent([transaction]), 1000)
  assert.equal(categorySpend('food', [transaction]), 600)
  assert.equal(categorySpend('transport', [transaction]), 400)
})

test('reimbursements distinguish pending, partially received, and net spending', () => {
  const expense: Transaction = { id: 'work', date: '2026-10-10', merchant: 'Work', description: '', amount: 1000, categoryId: 'food', reimbursable: true, reimbursementAmount: 1000 }
  assert.equal(reimbursementReceived(expense), 0)
  assert.equal(reimbursementOutstanding(expense), 1000)
  assert.equal(netSpent([expense]), 1000)
  const partial = { ...expense, reimbursements: [{ id: 'r1', date: '2026-10-12', amount: 400 }] }
  assert.equal(reimbursementReceived(partial), 400)
  assert.equal(reimbursementOutstanding(partial), 600)
  assert.equal(netSpent([partial]), 600)
  const centsExact: Transaction = { ...expense, amount: 0.5, reimbursementAmount: 0.3, reimbursements: [{ id: 'r2', date: '2026-10-12', amount: 0.1 }, { id: 'r3', date: '2026-10-13', amount: 0.2 }] }
  assert.equal(reimbursementReceived(centsExact), 0.3)
  assert.equal(reimbursementOutstanding(centsExact), 0)
  assert.equal(netSpent([centsExact]), 0.2)
})

test('recurrence handles month ends, leap years, nth weekdays, and stable occurrence IDs', () => {
  assert.equal(nextOccurrence({ cadence: 'monthly', nextDate: '2026-01-31', day: 31 }), '2026-02-28')
  assert.equal(nextOccurrence({ cadence: 'yearly', nextDate: '2024-02-29', day: 29 }), '2025-02-28')
  assert.equal(nthWeekdayInMonth('2026-10', 5, 2), '2026-10-09')
  assert.equal(scheduledOccurrenceId('rent', '2026-10-01'), 'rent:2026-10-01')
})

test('a scheduled posting is constructed with the same stable transaction and occurrence ID every time', () => {
  const item = { id: 'rent', name: 'Rent', amount: 1234.5, categoryId: 'home', kind: 'bill' as const }
  const first = scheduledTransactionFor(item, '2026-10-01')
  const second = scheduledTransactionFor(item, '2026-10-01')
  assert.deepEqual(first, second)
  assert.equal(first.id, 'scheduled:rent:2026-10-01')
  assert.throws(() => scheduledTransactionFor(item, '2026-02-30'), /valid scheduled item/)
})

test('recurring cadence advances weekly, quarterly, and by nth weekday', () => {
  assert.equal(nextOccurrence({ cadence: 'weekly', nextDate: '2026-10-02', day: 2 }), '2026-10-09')
  assert.equal(nextOccurrence({ cadence: 'quarterly', nextDate: '2026-10-31', day: 31 }), '2027-01-31')
  assert.equal(nextOccurrence({ cadence: 'monthly-weekday', nextDate: '2026-10-09', day: 9, weekday: 5, weekOrdinal: 2 }), '2026-11-13')
})

test('sinking fund compares the envelope contribution with the upcoming target date', () => {
  const state: AppState = {
    month: '2026-10', income: [], categories: [category({ planned: 100 })], transactions: [],
    recurring: [], moves: [], audit: [], rules: [],
  }
  const sinking = { id: 'insurance', name: 'Insurance', amount: 600, categoryId: 'food', cadence: 'quarterly' as const, day: 15, nextDate: '2027-01-15', kind: 'sinking' as const, active: true }
  const summary = sinkingFundSummary(sinking, state)
  assert.equal(summary?.funded, 100)
  assert.equal(summary?.contribution, 100)
  assert.equal(summary?.monthsUntilDue, 3)
  assert.equal(summary?.monthlyNeeded, 500 / 3)
  assert.equal(summary?.onTrack, false)
})

test('categorization rules prefer the most specific match independent of rule order', () => {
  const tx = { merchant: 'Uber Eats', description: 'Monthly pass', amount: 25 }
  const broad = { id: 'broad', contains: 'uber', categoryId: 'transport' }
  const specific = { id: 'specific', contains: 'uber eats', categoryId: 'food' }
  const rules = [broad, specific]
  assert.equal(matchingCategorizationRule(tx, rules)?.id, 'specific')
  assert.equal(matchingCategorizationRule(tx, [...rules].reverse())?.id, 'specific')
  const state: AppState = { month: '2026-10', income: [], categories: [category(), category({ id: 'transport', name: 'Transport' })], transactions: [], recurring: [], moves: [], audit: [], rules }
  assert.equal(suggestionFor(tx, state).categoryId, 'food')
})

test('equal length rule matches use a stable lexical tie break', () => {
  const tx = { merchant: 'Cafe and Taxi', description: '', amount: 20 }
  const rules = [{ id: 'z', contains: 'taxi', categoryId: 'transport' }, { id: 'a', contains: 'cafe', categoryId: 'food' }]
  assert.equal(matchingCategorizationRule(tx, rules)?.id, 'a')
  assert.equal(matchingCategorizationRule(tx, [...rules].reverse())?.id, 'a')
})

test('categorization suggestions use notes and include amount-based fallback', () => {
  const state: AppState = {
    month: '2026-10', income: [], categories: [category(), category({ id: 'personal', name: 'Personal' })],
    transactions: [], recurring: [], moves: [], audit: [], rules: [{ id: 'note-rule', contains: 'client lunch', categoryId: 'food' }],
  }
  assert.equal(suggestionFor({ merchant: '', description: '', notes: 'Client lunch with team', amount: 40 }, state).categoryId, 'food')
  assert.equal(suggestionFor({ merchant: '', description: '', notes: '', amount: 150 }, { ...state, rules: [] }).categoryId, 'personal')
})

test('split assistant proposes editable category lines for bulk-store purchases and scales known splits', () => {
  const household = category({ id: 'household', name: 'Household goods' })
  const state: AppState = { month: '2026-10', income: [], categories: [category(), household], transactions: [], recurring: [], moves: [], audit: [], rules: [] }
  const likely = splitSuggestionFor({ merchant: 'Costco', description: 'Weekly run', amount: 120 }, state)
  assert.equal(likely?.confidence, 'Low')
  assert.deepEqual(likely?.rows.map(row => row.categoryId), ['food', 'household'])
  assert.equal(likely?.rows.reduce((sum, row) => sum + row.amount, 0), 120)
  const history = { id: 'old', date: '2026-10-01', merchant: 'Warehouse Club', description: '', amount: 100, categoryId: 'food', splits: [{ id: 'a', categoryId: 'food', amount: 60 }, { id: 'b', categoryId: 'household', amount: 40 }] }
  const learned = splitSuggestionFor({ merchant: 'Warehouse Club', description: '', amount: 50 }, { ...state, transactions: [history] })
  assert.equal(learned?.confidence, 'High')
  assert.deepEqual(learned?.rows.map(row => row.amount), [30, 20])
})

test('reimbursable assistant recognizes client and team meals from transaction text', () => {
  assert.match(reimbursableSuggestionFor({ merchant: 'Cafe', description: 'Team lunch' })?.reason ?? '', /team/i)
  assert.match(reimbursableSuggestionFor({ merchant: 'Restaurant', description: 'Dinner with client' })?.reason ?? '', /client/i)
  assert.equal(reimbursableSuggestionFor({ merchant: 'Grocery store', description: 'Weekly groceries' }), null)
})

test('spending anomalies compare month-to-date category spend with the same period in the prior three months', () => {
  const state: AppState = {
    month: '2026-10', income: [], categories: [category({ name: 'Dining' })], recurring: [], moves: [], audit: [], rules: [],
    transactions: [
      { id: 'jul', date: '2026-07-15', merchant: 'Cafe', description: '', amount: 100, categoryId: 'food' },
      { id: 'aug', date: '2026-08-15', merchant: 'Cafe', description: '', amount: 100, categoryId: 'food' },
      { id: 'sep', date: '2026-09-15', merchant: 'Cafe', description: '', amount: 100, categoryId: 'food' },
      { id: 'oct', date: '2026-10-10', merchant: 'Cafe', description: '', amount: 230, categoryId: 'food' },
    ],
  }
  const anomalies = spendingAnomalies(state, '2026-10-15')
  assert.equal(anomalies.length, 1)
  assert.equal(anomalies[0].ratio, 2.3)
  assert.equal(anomalies[0].baseline, 100)
  assert.equal(spendingAnomalies({ ...state, transactions: state.transactions.slice(0, 3) }, '2026-10-15').length, 0)
})

test('plan drafts average three prior months of actual category spending, including split lines and empty months', () => {
  const state: AppState = {
    month: '2026-10', income: [], categories: [category({ planned: 250 })], recurring: [], moves: [], audit: [], rules: [],
    transactions: [
      { id: 'jul', date: '2026-07-10', merchant: 'Store', description: '', amount: 100, categoryId: 'food' },
      { id: 'sep', date: '2026-09-10', merchant: 'Store', description: '', amount: 80, categoryId: 'food', splits: [{ id: 'food-line', categoryId: 'food', amount: 50 }, { id: 'other-line', categoryId: 'transport', amount: 30 }] },
    ],
  }
  const foodDraft = draftPlan(state).find(row => row.categoryId === 'food')!
  assert.equal(foodDraft.spend, 150)
  assert.equal(foodDraft.months, 3)
  assert.equal(foodDraft.average, 50)
  assert.equal(foodDraft.current, 250)
  assert.equal(foodDraft.suggested, 50)
  assert.match(foodDraft.reason, /three completed months/)
})

test('cash-flow forecast includes intermediate month income and posts overdue bills once', () => {
  const state: AppState = {
    month: '2026-10', currentBalance: 200,
    income: [{ id: 'pay', name: 'Payday', amount: 1000, cadence: 'monthly', frequency: 'monthly', startDate: '2026-10-20', day: 20 }],
    categories: [], transactions: [], recurring: [{ id: 'rent', name: 'Rent', amount: 800, categoryId: 'food', cadence: 'monthly', day: 10, nextDate: '2026-10-10', kind: 'bill', active: true }],
    moves: [], audit: [], rules: [],
  }
  const timeline = cashFlowTimeline(state, 200, '2026-10-16', 40)
  const rentEvents = timeline.filter(event => event.occurrenceId === 'rent:2026-10-10')
  assert.equal(rentEvents.length, 1)
  assert.equal(rentEvents[0].date, '2026-10-16')
  assert.match(rentEvents[0].warning ?? '', /Risk window/)
  assert.ok(timeline.some(event => event.kind === 'income' && event.date === '2026-10-20'))
  assert.ok(timeline.some(event => event.kind === 'income' && event.date === '2026-11-20'))
})

test('cash-flow events and balances are stable when source arrays are reordered', () => {
  const state: AppState = {
    month: '2026-10', income: [
      { id: 'pay-b', name: 'Second pay', amount: 100, cadence: 'monthly', frequency: 'monthly', startDate: '2026-10-20', day: 20 },
      { id: 'pay-a', name: 'First pay', amount: 125, cadence: 'monthly', frequency: 'monthly', startDate: '2026-10-20', day: 20 },
    ], categories: [category(), category({ id: 'transport', planned: 50 })],
    transactions: [
      { id: 'future-b', date: '2026-10-18', merchant: 'B shop', description: '', amount: 0.2, categoryId: 'food' },
      { id: 'future-a', date: '2026-10-18', merchant: 'A shop', description: '', amount: 0.1, categoryId: 'food' },
    ],
    recurring: [
      { id: 'bill-b', name: 'Water', amount: 30, categoryId: 'food', cadence: 'monthly', day: 18, nextDate: '2026-10-18', kind: 'bill', active: true },
      { id: 'bill-a', name: 'Electric', amount: 20, categoryId: 'food', cadence: 'monthly', day: 18, nextDate: '2026-10-18', kind: 'bill', active: true },
    ], moves: [], audit: [], rules: [],
  }
  const expected = cashFlowTimeline(state, 100, '2026-10-16', 10)
  const reordered = cashFlowTimeline({ ...state, income: [...state.income].reverse(), categories: [...state.categories].reverse(), transactions: [...state.transactions].reverse(), recurring: [...state.recurring].reverse() }, 100, '2026-10-16', 10)
  assert.deepEqual(reordered, expected)
})

test('cash-flow risk lasts until income actually restores a positive balance', () => {
  const state: AppState = {
    month: '2026-10', income: [{ id: 'pay', name: 'Small payday', amount: 50, cadence: '20th monthly' }], categories: [], transactions: [],
    recurring: [{ id: 'rent', name: 'Rent', amount: 200, categoryId: 'food', cadence: 'monthly', day: 17, nextDate: '2026-10-17', kind: 'bill', active: true }],
    moves: [], audit: [], rules: [],
  }
  const timeline = cashFlowTimeline(state, 100, '2026-10-16', 10)
  assert.match(timeline.find(event => event.kind === 'bill')?.warning ?? '', /below zero through the forecast horizon/)
})

test('a posted recurring occurrence is not projected again as an unpaid bill', () => {
  const state: AppState = {
    month: '2026-10', income: [], categories: [],
    transactions: [{ id: 'posted-rent', scheduledOccurrenceId: 'rent:2026-10-20', date: '2026-10-20', merchant: 'Rent', description: 'Paid scheduled bill', amount: 200, categoryId: 'food' }],
    recurring: [{ id: 'rent', name: 'Rent', amount: 200, categoryId: 'food', cadence: 'monthly', day: 20, nextDate: '2026-10-20', kind: 'bill', active: true }],
    moves: [], audit: [], rules: [],
  }
  const timeline = cashFlowTimeline(state, 500, '2026-10-16', 10)
  assert.equal(timeline.filter(event => event.occurrenceId === 'rent:2026-10-20').length, 0)
  assert.equal(timeline.filter(event => event.kind === 'transaction').length, 1)
})

test('partial-month envelope estimates exclude adjustments after the forecast cutoff', () => {
  const state: AppState = {
    month: '2026-10', income: [], categories: [category({ planned: 100 })], transactions: [], recurring: [], moves: [],
    adjustments: [{ id: 'later', date: '2026-10-20', categoryId: 'food', amount: 50, note: '' }], audit: [], rules: [],
  }
  const estimate = cashFlowTimeline(state, 1000, '2026-10-01', 9).find(event => event.kind === 'estimate')
  assert.equal(estimate?.amount, -100)
})
