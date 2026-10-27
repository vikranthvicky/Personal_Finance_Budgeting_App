import { isValidScheduleDate, nextOccurrence, scheduledOccurrenceId, scheduledTransactionFor } from '../../src/calculations'
import type { AppState } from '../../src/types'

type VersionedState = AppState & { revision: number }

type RecurringPostOutcome =
  | { kind: 'not-found' }
  | { kind: 'invalid-date' }
  | { kind: 'duplicate' }
  | { kind: 'revision-conflict' }
  | { kind: 'schedule-conflict' }
  | { kind: 'invalid-item' }
  | { kind: 'ready'; state: AppState; occurrenceId: string }

/** Build the next state for a scheduled post without performing HTTP or database work. */
export function prepareRecurringPost(state: VersionedState, itemId: string, occurrenceDate: string, expectedRevision: number): RecurringPostOutcome {
  const item = state.recurring.find(row => row.id === itemId)
  if (!item) return { kind: 'not-found' }
  if (!isValidScheduleDate(occurrenceDate)) return { kind: 'invalid-date' }

  const occurrenceId = scheduledOccurrenceId(item.id, occurrenceDate)
  const alreadyPosted = state.transactions.some(tx => tx.scheduledOccurrenceId === occurrenceId || tx.id === `scheduled:${occurrenceId}`)
  if (alreadyPosted) return { kind: 'duplicate' }
  if (expectedRevision !== state.revision) return { kind: 'revision-conflict' }
  if (!item.active || item.nextDate !== occurrenceDate) return { kind: 'schedule-conflict' }
  if (!state.categories.some(category => category.id === item.categoryId) || !Number.isFinite(item.amount) || item.amount <= 0) return { kind: 'invalid-item' }

  const transaction = scheduledTransactionFor(item, occurrenceDate)
  const nextState: AppState = {
    ...state,
    transactions: [transaction, ...state.transactions],
    recurring: state.recurring.map(row => row.id === item.id ? { ...row, nextDate: nextOccurrence(row) } : row),
    audit: [{ id: `scheduled-audit:${occurrenceId}`, at: new Date().toISOString(), message: `Posted scheduled ${item.kind}: ${item.name} · ${item.amount}` }, ...state.audit].slice(0, 250),
  }
  return { kind: 'ready', state: nextState, occurrenceId }
}
