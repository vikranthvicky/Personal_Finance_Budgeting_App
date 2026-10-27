import assert from 'node:assert/strict'
import test from 'node:test'
import { createDemoState } from '../src/demo'
import { auditChanges } from '../server/services/budgetPersistence'
import type { Transaction } from '../src/types'

function stateWith(transaction?: Transaction) {
  const state = createDemoState()
  state.transactions = transaction ? [transaction] : []
  return state
}

const expense = (overrides: Partial<Transaction> = {}): Transaction => ({
  id: 'expense-1', date: '2026-10-10', merchant: 'Market', description: 'Team supplies', amount: 100,
  categoryId: 'personal', reimbursable: true, reimbursementAmount: 100, reimbursementReceivedAmount: 80,
  reimbursementStatus: 'pending', ...overrides,
})

test('audit records reimbursement receipts that are reduced', () => {
  const events = auditChanges(stateWith(expense()), stateWith(expense({ reimbursementReceivedAmount: 50 })), '2026-10-27T00:00:00.000Z')
  assert.ok(events.some(event => event.message.includes('Reversed reimbursement') && event.message.includes('30.00') && event.message.includes('80.00 → 50.00')))
})

test('audit records expected reimbursement changes', () => {
  const events = auditChanges(stateWith(expense()), stateWith(expense({ reimbursementAmount: 90 })), '2026-10-27T00:00:00.000Z')
  assert.ok(events.some(event => event.message.includes('Changed reimbursement expectation') && event.message.includes('100.00 → 90.00')))
})

test('audit records reimbursements removed with an expense', () => {
  const events = auditChanges(stateWith(expense()), stateWith(), '2026-10-27T00:00:00.000Z')
  assert.ok(events.some(event => event.message.includes('Reversed reimbursement for removed expense Market') && event.message.includes('80.00')))
})
