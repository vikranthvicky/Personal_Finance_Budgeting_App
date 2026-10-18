import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { ArrowDownLeft, ArrowLeft, ArrowRight, ArrowUpRight, BadgeCheck, Bell, CalendarDays, Car, Check, ChevronDown, CircleHelp, Command, CreditCard, FileClock, HeartPulse, Home, Leaf, ListFilter, Menu, MoreHorizontal, Plus, Search, Settings, ShieldCheck, Sparkles, Tag, TrendingUp, Utensils, UserRound, Wallet, X } from 'lucide-react'
import { availableFor, budgetPeriod, budgetRangeSummary, cashFlowTimeline, categorySpend, currentTransactions, draftPlan, incomeDatesForMonth, isValidScheduleDate, matchingCategorizationRule, money, netSpent, nextOccurrence, nthWeekdayInMonth, plannedAmount, progressFor, reimbursableSuggestionFor, reimbursementExpected, reimbursementOutstanding, reimbursementReceived, reimbursementState, scheduledOccurrenceId, scheduledTransactionFor, sinkingFundSummary, spendingAnomalies, splitSuggestionFor, suggestionFor, totalIncome, totalReimbursementsReceived, totalSpent, upcomingBills } from './calculations'
import { replaceState, type RootState } from './store'
import type { AppState, Category, Recurring, Transaction } from './types'
import type { CashFlowEvent } from './calculations'

type Tab = 'Overview' | 'My plan' | 'Activity' | 'Upcoming'
const uid = () => crypto.randomUUID()
const today = () => new Date().toISOString().slice(0, 10)
function recurringTotalWithinDays(items: Recurring[], startDate: string, days: number) {
  const end = new Date(`${startDate}T12:00:00`)
  end.setDate(end.getDate() + days)
  const endDate = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`
  return items.filter(item => item.active).reduce((total, item) => {
    let date = item.nextDate
    let sum = 0
    let guard = 0
    // Surface a missed due amount once, then count future scheduled occurrences.
    if (date < startDate) {
      sum += item.amount
      while (date < startDate && guard++ < 10000) {
        try { date = nextOccurrence({ ...item, nextDate: date }) } catch { return total + sum }
      }
    }
    while (date <= endDate && guard++ < 1000) {
      sum += item.amount
      try { date = nextOccurrence({ ...item, nextDate: date }) } catch { break }
    }
    return total + sum
  }, 0)
}
function parseCsvRows(input: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let value = ''; let quoted = false
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (char === '"') {
      if (quoted && input[index + 1] === '"') { value += '"'; index++ } else quoted = !quoted
    } else if (char === ',' && !quoted) { row.push(value); value = '' }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && input[index + 1] === '\n') index++
      row.push(value); if (row.some(cell => cell.trim())) rows.push(row); row = []; value = ''
    } else value += char
  }
  if (quoted) throw new Error('Unclosed quoted value')
  row.push(value); if (row.some(cell => cell.trim())) rows.push(row)
  return rows
}
const iconFor = (key: string, size = 18) => {
  const props = { size, strokeWidth: 1.8 }
  if (key === 'home') return <Home {...props} />
  if (key === 'food') return <Utensils {...props} />
  if (key === 'transport') return <Car {...props} />
  if (key === 'health') return <HeartPulse {...props} />
  if (key === 'person') return <UserRound {...props} />
  if (key === 'spark') return <Sparkles {...props} />
  if (key === 'leaf') return <Leaf {...props} />
  if (key === 'tag') return <Tag {...props} />
  return <Tag {...props} />
}

export default function App() {
  const dispatch = useDispatch()
  const state = useSelector((root: RootState) => root.app)
  const txns = useMemo(() => currentTransactions(state), [state])
  const [tab, setTab] = useState<Tab>('Overview')
  const [query, setQuery] = useState('')
  const [catFilter, setCatFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [minAmount, setMinAmount] = useState('')
  const [maxAmount, setMaxAmount] = useState('')
  const [selectedTransactions, setSelectedTransactions] = useState<Set<string>>(new Set())
  const [bulkCategoryId, setBulkCategoryId] = useState('')
  const [status, setStatus] = useState<'connecting' | 'online' | 'offline'>('connecting')
  const [budgets, setBudgets] = useState<{ id: string; name: string }[]>([])
  const [budgetId, setBudgetId] = useState<string | null>(null)
  const [modal, setModal] = useState<'transaction' | 'bulk-transactions' | 'reimbursement' | 'bill' | 'category' | 'category-edit' | 'transfer' | 'income' | 'plan' | 'balance' | null>(null)
  const [editingTx, setEditingTx] = useState<Transaction | null>(null)
  const [suggestedSplits, setSuggestedSplits] = useState<{ categoryId: string; amount: number }[] | null>(null)
  const [splitSuggestionVersion, setSplitSuggestionVersion] = useState(0)
  const [reimbursementHint, setReimbursementHint] = useState<{ token: number; amount: number } | null>(null)
  const [editingRecurring, setEditingRecurring] = useState<Recurring | null>(null)
  const [reimbursementTx, setReimbursementTx] = useState<Transaction | null>(null)
  const [editingCategory, setEditingCategory] = useState<Category | null>(null)
  const [reassignmentTargetId, setReassignmentTargetId] = useState('')
  const [notice, setNotice] = useState('')
  const [planDraft, setPlanDraft] = useState<Record<string, number>>({})
  const [showMenu, setShowMenu] = useState(false)
  const [postingIds, setPostingIds] = useState<Set<string>>(new Set())
  const postedOccurrences = useRef(new Set<string>())
  const loaded = useRef(false)
  const stateRef = useRef(state)
  const revisionRef = useRef<number | null>(null)
  const activeBudgetRef = useRef<string | null>(null)
  const revisionsByBudgetRef = useRef(new Map<string, number>())
  const generationsByBudgetRef = useRef(new Map<string, number>())
  const blockedSaveBudgetsRef = useRef(new Set<string>())
  const persistQueue = useRef<Promise<unknown>>(Promise.resolve())
  stateRef.current = state

  useEffect(() => {
    let active = true
    fetch('/api/budgets').then(response => { if (!response.ok) throw new Error('API unavailable'); return response.json() as Promise<{ id: string; name: string }[]> }).then(items => {
      if (!active) return
      setBudgets(items)
      const remembered = localStorage.getItem('pocketplan.activeBudget')
      const selected = items.some(item => item.id === remembered) ? remembered! : items[0]?.id ?? 'default'
      activeBudgetRef.current = selected
      setBudgetId(selected)
    }).catch(() => { if (active) { setStatus('offline'); loaded.current = true } })
    return () => { active = false }
  }, [dispatch])
  useEffect(() => {
    if (!budgetId) return
    let active = true
    loaded.current = false
    setStatus('connecting')
    fetch(`/api/state?budgetId=${encodeURIComponent(budgetId)}`).then(response => { if (!response.ok) throw new Error('API unavailable'); return response.json() }).then((data: AppState & { revision?: number }) => { if (active && activeBudgetRef.current === budgetId) { if (data.revision !== undefined) revisionsByBudgetRef.current.set(budgetId, data.revision); generationsByBudgetRef.current.set(budgetId, (generationsByBudgetRef.current.get(budgetId) ?? 0) + 1); revisionRef.current = data.revision ?? null; stateRef.current = data; dispatch(replaceState(data)); localStorage.setItem('pocketplan.activeBudget', budgetId); setStatus('online'); loaded.current = true } }).catch(() => { if (active && activeBudgetRef.current === budgetId) { setStatus('offline'); loaded.current = true } })
    return () => { active = false }
  }, [budgetId, dispatch])
  useEffect(() => {
    if (!loaded.current || !budgetId) return
    const saveBudgetId = budgetId
    const snapshot = state
    const snapshotGeneration = generationsByBudgetRef.current.get(saveBudgetId) ?? 0
    const timer = window.setTimeout(() => {
      persistQueue.current = persistQueue.current.catch(() => undefined).then(async () => {
        if (blockedSaveBudgetsRef.current.has(saveBudgetId)) return
        if (snapshotGeneration < (generationsByBudgetRef.current.get(saveBudgetId) ?? 0)) return
        const revision = revisionsByBudgetRef.current.get(saveBudgetId) ?? (activeBudgetRef.current === saveBudgetId ? revisionRef.current : null)
        if (revision === null) { if (activeBudgetRef.current === saveBudgetId) setStatus('offline'); return }
        const endpoint = `/api/state?budgetId=${encodeURIComponent(saveBudgetId)}`
        const response = await fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...snapshot, revision }) })
        if (response.status === 409) {
          const latest = await fetch(endpoint).then(res => res.json() as Promise<AppState & { revision: number }>)
          revisionsByBudgetRef.current.set(saveBudgetId, latest.revision)
          blockedSaveBudgetsRef.current.add(saveBudgetId)
          if (activeBudgetRef.current === saveBudgetId) { generationsByBudgetRef.current.set(saveBudgetId, (generationsByBudgetRef.current.get(saveBudgetId) ?? 0) + 1); revisionRef.current = latest.revision; stateRef.current = latest; dispatch(replaceState(latest)); setNotice('A newer version was saved elsewhere. Loaded that version; please reapply your change.') }
          return
        }
        if (!response.ok) throw new Error('Save failed')
        const result = await response.json() as { revision: number }; revisionsByBudgetRef.current.set(saveBudgetId, result.revision)
        if (activeBudgetRef.current === saveBudgetId) { revisionRef.current = result.revision; setStatus('online') }
      }).catch(() => { if (activeBudgetRef.current === saveBudgetId) setStatus('offline') })
    }, 350)
    return () => window.clearTimeout(timer)
  }, [state, budgetId])
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 2900); return () => window.clearTimeout(timer) }, [notice])

  const shownDate = new Date(`${state.month}-01T12:00:00`)
  const shownMonth = shownDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  const spent = totalSpent(txns)
  const reimbursements = totalReimbursementsReceived(txns)
  const netExpense = netSpent(txns)
  const income = totalIncome(state, state.month)
  const budgeted = state.categories.reduce((sum, c) => sum + plannedAmount(c, state.month), 0)
  const totalAvailable = state.categories.reduce((sum, category) => sum + availableFor(category, state.transactions, state.month, state.moves, state.adjustments ?? []), 0)
  const unallocated = income - budgeted
  const editingCategoryHasLinkedRecords = editingCategory !== null && (state.transactions.some(tx => tx.categoryId === editingCategory.id || tx.splits?.some(split => split.categoryId === editingCategory.id)) || state.recurring.some(item => item.categoryId === editingCategory.id) || state.moves.some(move => move.fromCategoryId === editingCategory.id || move.toCategoryId === editingCategory.id) || (state.adjustments ?? []).some(item => item.categoryId === editingCategory.id) || state.rules.some(rule => rule.categoryId === editingCategory.id))
  const recent = [...txns].sort((a, b) => b.date.localeCompare(a.date))
  const filtered = (tab === 'Activity' ? [...state.transactions].sort((a, b) => b.date.localeCompare(a.date)) : recent).filter(tx => {
    const matchesSearch = `${tx.merchant} ${tx.description} ${tx.notes ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())
    const matchesCategory = catFilter === 'all' || tx.categoryId === catFilter || tx.splits?.some(s => s.categoryId === catFilter) || (catFilter === 'uncategorized' && (!state.categories.some(c => c.id === tx.categoryId) || tx.categoryId === 'uncategorized' || tx.splits?.some(split => split.categoryId === 'uncategorized' || !state.categories.some(c => c.id === split.categoryId))))
    const matchesStatus = statusFilter === 'all' || (statusFilter === 'regular' ? !tx.reimbursable : tx.reimbursable && reimbursementState(tx) === statusFilter)
    return matchesSearch && matchesCategory && matchesStatus && (!dateFrom || tx.date >= dateFrom) && (!dateTo || tx.date <= dateTo) && (minAmount === '' || tx.amount >= Number(minAmount)) && (maxAmount === '' || tx.amount <= Number(maxAmount)) && (tab === 'Activity' || tx.date.startsWith(state.month))
  })
  const invalidAmountBounds = (minAmount !== '' && (!Number.isFinite(Number(minAmount)) || Number(minAmount) < 0)) || (maxAmount !== '' && (!Number.isFinite(Number(maxAmount)) || Number(maxAmount) < 0)) || (minAmount !== '' && maxAmount !== '' && Number(minAmount) > Number(maxAmount))
  const rangeIsInvalid = Boolean(dateFrom && dateTo && dateFrom > dateTo) || invalidAmountBounds
  const reportTransactions = rangeIsInvalid ? [] : state.transactions.filter(tx => (!dateFrom || tx.date >= dateFrom) && (!dateTo || tx.date <= dateTo))
  const reportFrom = dateFrom || state.transactions.map(tx => tx.date).sort()[0] || `${state.month}-01`
  const reportTo = dateTo || [today(), ...state.transactions.map(tx => tx.date)].sort().at(-1)!
  const rangeBudget = rangeIsInvalid ? { categories: [], planned: 0, actual: 0, available: 0 } : budgetRangeSummary(state, reportFrom, reportTo)
  const reportCategories = rangeBudget.categories.map(row => ({ ...row, category: state.categories.find(category => category.id === row.categoryId)! }))
  const rangeReimbursements = state.transactions.reduce((sum, tx) => sum + (tx.reimbursements?.length ? tx.reimbursements.filter(receipt => (!dateFrom || receipt.date >= dateFrom) && (!dateTo || receipt.date <= dateTo)).reduce((total, receipt) => total + receipt.amount, 0) : (!dateFrom || tx.date >= dateFrom) && (!dateTo || tx.date <= dateTo) ? reimbursementReceived(tx) : 0), 0)
  const rangeNetSpending = totalSpent(reportTransactions) - rangeReimbursements
  const savingsRate = income ? Math.round(Math.max(0, income - netExpense) / income * 100) : 0
  const forecast = state.currentBalance === undefined ? [] : cashFlowTimeline(state, state.currentBalance, today(), 45)
  const forecastBalance = forecast.length ? forecast[forecast.length - 1].balanceAfter : state.currentBalance
  const anomalies = spendingAnomalies(state, today())

  function update(change: (current: AppState) => AppState, log?: string) {
    const current = stateRef.current
    const next = change(current)
    if (log) next.audit = [{ id: uid(), at: new Date().toISOString(), message: log }, ...current.audit].slice(0, 250)
    // Keep event handlers based on the latest state even when React has not
    // rendered the previous dispatch yet (for example, rapid consecutive edits).
    stateRef.current = next
    if (activeBudgetRef.current) {
      blockedSaveBudgetsRef.current.delete(activeBudgetRef.current)
      generationsByBudgetRef.current.set(activeBudgetRef.current, (generationsByBudgetRef.current.get(activeBudgetRef.current) ?? 0) + 1)
    }
    dispatch(replaceState(next))
  }
  function changeMonth(direction: number) {
    const date = new Date(`${state.month}-01T12:00:00`); date.setMonth(date.getMonth() + direction)
    update(s => ({ ...s, month: date.toISOString().slice(0, 7) }), `Opened ${date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} plan`)
  }
  function openTransaction(tx?: Transaction) { setEditingTx(tx ?? null); setModal('transaction') }
  function importTransactions(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const csv = String(new FormData(event.currentTarget).get('csv') ?? '')
    let rows: string[][]
    try { rows = parseCsvRows(csv) } catch { setNotice('Check the CSV quotes and try again.'); return }
    if (rows.length < 2) { setNotice('Add a header row and at least one transaction.'); return }
    const headers = rows[0].map(value => value.trim().toLowerCase())
    const required = ['date', 'merchant', 'amount', 'category']
    if (required.some(name => !headers.includes(name))) { setNotice('CSV needs date, merchant, amount, and category columns.'); return }
    if (rows.length - 1 > 500) { setNotice('Import up to 500 transactions at a time.'); return }
    const column = (row: string[], name: string) => row[headers.indexOf(name)]?.trim() ?? ''
    const imported: Transaction[] = []
    for (const [index, row] of rows.slice(1).entries()) {
      if (row.every(value => !value.trim())) continue
      const date = column(row, 'date')
      const merchant = column(row, 'merchant')
      const amount = Number(column(row, 'amount'))
      const categoryValue = column(row, 'category')
      const category = state.categories.find(item => item.id === categoryValue || item.name.toLowerCase() === categoryValue.toLowerCase())
      if (!isValidScheduleDate(date) || !merchant || !Number.isFinite(amount) || amount <= 0 || !category || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-8) { setNotice(`CSV row ${index + 2} has an invalid date, merchant, amount, or category.`); return }
      imported.push({ id: uid(), date, merchant, amount: Math.round(amount * 100) / 100, categoryId: category.id, description: column(row, 'description'), notes: column(row, 'notes') || undefined })
    }
    if (!imported.length) { setNotice('No transaction rows were found.'); return }
    update(current => ({ ...current, transactions: [...imported, ...current.transactions] }), `Imported ${imported.length} transactions from CSV`)
    setModal(null); setNotice(`Imported ${imported.length} transactions`)
  }
  function saveTransaction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const amount = Number(form.get('amount'))
    const splitCategoryIds = form.getAll('splitCategory').map(value => String(value))
    const date = String(form.get('date') ?? '')
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T12:00:00`)) && new Date(`${date}T12:00:00`).toISOString().slice(0, 10) === date
    if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-8) { setNotice('Enter a transaction amount greater than zero with no more than two decimal places.'); return }
    if (!validDate) { setNotice('Choose a valid transaction date.'); return }
    const categoryId = splitCategoryIds[0]
    if (!splitCategoryIds.length || splitCategoryIds.some(id => !state.categories.some(category => category.id === id))) { setNotice('Choose a valid envelope for every split line.'); return }
    const splitAmounts = form.getAll('splitAmount').map(value => String(value).trim())
    let splits: Transaction['splits']
    if (splitCategoryIds.length > 1) {
      const totalCents = Math.round(amount * 100)
      const secondaryCents = splitAmounts.map(value => Math.round(Number(value) * 100))
      const primaryCents = totalCents - secondaryCents.reduce((sum, value) => sum + value, 0)
      if (splitAmounts.length !== splitCategoryIds.length - 1 || secondaryCents.some((value, index) => !splitAmounts[index] || !Number.isFinite(value) || value <= 0 || Math.abs(Number(splitAmounts[index]) * 100 - value) > 1e-8) || primaryCents <= 0) { setNotice('Each split must use cents, be positive, and add up exactly to the transaction total.'); return }
      splits = [{ id: uid(), categoryId, amount: primaryCents / 100 }, ...splitCategoryIds.slice(1).map((id, index) => ({ id: uid(), categoryId: id, amount: secondaryCents[index] / 100 }))]
    }
    const reimbursable = form.get('reimbursable') === 'on'
    const reimbursementAmount = Number(form.get('reimbursementAmount') ?? 0)
    const previouslyReceived = editingTx ? reimbursementReceived(editingTx) : 0
    const previousReimbursementState = editingTx?.reimbursable ? reimbursementState(editingTx) : 'not reimbursable'
    if (reimbursable && (!Number.isFinite(reimbursementAmount) || reimbursementAmount <= 0 || Math.abs(reimbursementAmount * 100 - Math.round(reimbursementAmount * 100)) > 1e-8 || reimbursementAmount > amount || reimbursementAmount < previouslyReceived)) { setNotice('Expected reimbursement must use cents, cover receipts already received, and cannot exceed the expense.'); return }
    if (!reimbursable && previouslyReceived > 0) { setNotice('An expense with received reimbursements must remain marked as reimbursable.'); return }
    const reimbursementStatus = reimbursable && previouslyReceived >= reimbursementAmount ? 'received' : 'pending'
    const nextReimbursementState = reimbursable ? reimbursementStatus : 'not reimbursable'
    const tx: Transaction = { id: editingTx?.id ?? uid(), date, merchant: String(form.get('merchant')).trim(), description: String(form.get('description') ?? '').trim(), amount, categoryId, account: String(form.get('account') ?? '').trim() || undefined, notes: String(form.get('notes') ?? '').trim() || undefined, reimbursable, reimbursementAmount: reimbursable ? reimbursementAmount : undefined, reimbursementReceivedAmount: reimbursable && !editingTx?.reimbursements && editingTx ? previouslyReceived : undefined, reimbursements: reimbursable ? editingTx?.reimbursements : undefined, reimbursementStatus: reimbursable ? reimbursementStatus : undefined, splits }
    const before = editingTx ? 'Updated' : 'Added'
    const reimbursementAudit = editingTx && previousReimbursementState !== nextReimbursementState ? ` · reimbursement status ${previousReimbursementState} → ${nextReimbursementState}` : ''
    update(s => ({ ...s, transactions: editingTx ? s.transactions.map(item => item.id === tx.id ? tx : item) : [tx, ...s.transactions] }), `${before} ${tx.merchant} · ${money(tx.amount)}${reimbursementAudit}`)
    setModal(null); setEditingTx(null); setNotice(`${before} transaction · ${money(tx.amount)}`)
  }
  function deleteTransaction(tx: Transaction) {
    update(s => ({ ...s, transactions: s.transactions.filter(item => item.id !== tx.id) }), `Deleted ${tx.merchant} · ${money(tx.amount)}`)
    setModal(null); setEditingTx(null); setNotice('Transaction deleted')
  }
  function bulkRecategorize() {
    if (!selectedTransactions.size || !state.categories.some(category => category.id === bulkCategoryId)) { setNotice('Choose a valid envelope for the selected transactions.'); return }
    const count = selectedTransactions.size
    update(s => ({ ...s, transactions: s.transactions.map(tx => selectedTransactions.has(tx.id) ? { ...tx, categoryId: bulkCategoryId, splits: tx.splits?.map(split => ({ ...split, categoryId: bulkCategoryId })) } : tx) }), `Moved ${count} transactions to ${state.categories.find(category => category.id === bulkCategoryId)?.name}`)
    setSelectedTransactions(new Set()); setNotice(`${count} transactions recategorized`)
  }
  function applyRuleToHistory(rule: AppState['rules'][number]) {
    const matching = state.transactions.filter(tx => !tx.splits?.length && matchingCategorizationRule(tx, state.rules)?.id === rule.id && tx.categoryId !== rule.categoryId)
    if (!matching.length) { setNotice('No unsplit historical transactions need this rule.'); return }
    const category = state.categories.find(item => item.id === rule.categoryId)?.name ?? 'the selected envelope'
    if (!window.confirm(`Apply “${rule.contains}” to ${matching.length} matching historical transaction${matching.length === 1 ? '' : 's'} and move them to ${category}?`)) return
    const ids = new Set(matching.map(tx => tx.id))
    update(current => ({ ...current, transactions: current.transactions.map(tx => ids.has(tx.id) ? { ...tx, categoryId: rule.categoryId } : tx) }), `Applied “${rule.contains}” categorization rule to ${matching.length} historical transactions`)
    setNotice(`Updated ${matching.length} matching transactions`)
  }
  function saveEditedRule(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const contains = String(form.get('contains') ?? '').trim()
    const categoryId = String(form.get('categoryId') ?? '')
    if (!contains || !state.categories.some(category => category.id === categoryId)) { setNotice('Enter a rule phrase and choose a valid envelope.'); return }
    if (state.rules.some(rule => rule.id !== id && rule.contains.trim().toLowerCase() === contains.toLowerCase())) { setNotice('A rule with that phrase already exists.'); return }
    update(current => ({ ...current, rules: current.rules.map(rule => rule.id === id ? { ...rule, contains, categoryId } : rule) }), `Edited categorization rule: ${contains}`)
    setNotice('Categorization rule saved')
  }
  function toggleTransactionSelection(id: string) {
    setSelectedTransactions(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }
  function toggleVisibleSelection() {
    setSelectedTransactions(current => {
      const next = new Set(current); const allVisibleSelected = filtered.length > 0 && filtered.every(tx => next.has(tx.id))
      filtered.forEach(tx => allVisibleSelected ? next.delete(tx.id) : next.add(tx.id)); return next
    })
  }
  function openReimbursement(tx: Transaction) { setReimbursementTx(tx); setModal('reimbursement') }
  function recordReimbursement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!reimbursementTx) return
    const form = new FormData(event.currentTarget); const amount = Number(form.get('amount')); const date = String(form.get('date') ?? '')
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T12:00:00`)) && new Date(`${date}T12:00:00`).toISOString().slice(0, 10) === date
    const outstanding = reimbursementOutstanding(reimbursementTx)
    if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-8 || Math.round(amount * 100) > Math.round(outstanding * 100) || !validDate || date < reimbursementTx.date) { setNotice('Enter a valid receipt date on or after the expense date and an amount up to the outstanding reimbursement.'); return }
    const legacyReceived = reimbursementTx.reimbursements ? 0 : reimbursementTx.reimbursementReceivedAmount ?? (reimbursementTx.reimbursementStatus === 'received' ? reimbursementExpected(reimbursementTx) : 0)
    const receipts = reimbursementTx.reimbursements ?? (legacyReceived > 0 ? [{ id: `legacy-${reimbursementTx.id}`, date: reimbursementTx.date, amount: legacyReceived, note: 'Previously recorded' }] : [])
    const receipt = { id: uid(), date, amount: Math.round(amount * 100) / 100, note: String(form.get('note') ?? '').trim() || undefined }
    const updated = [...receipts, receipt]
    const received = updated.reduce((sum, item) => sum + item.amount, 0)
    const status = received >= reimbursementExpected(reimbursementTx) ? 'received' : 'pending'
    const previousStatus = reimbursementState(reimbursementTx)
    const statusChange = previousStatus === status ? '' : ` · status ${previousStatus} → ${status}`
    update(s => ({ ...s, transactions: s.transactions.map(item => item.id === reimbursementTx.id ? { ...item, reimbursements: updated, reimbursementReceivedAmount: undefined, reimbursementStatus: status } : item) }), `Recorded reimbursement receipt · ${reimbursementTx.merchant} · ${money(receipt.amount)}${statusChange}`)
    setModal(null); setReimbursementTx(null); setNotice(`Receipt of ${money(receipt.amount)} recorded`)
  }
  function openNewRecurring() { setEditingRecurring(null); setModal('bill') }
  function addBill(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget)
    const cadence = String(form.get('cadence')) as Recurring['cadence']
    const nextDateValue = String(form.get('nextDate') ?? '')
    const amount = Number(form.get('amount'))
    const categoryId = String(form.get('categoryId'))
    const intervalDays = cadence === 'custom' ? Number(form.get('intervalDays')) : undefined
    const secondDay = cadence === 'semimonthly' ? Number(form.get('secondDay')) : undefined
    const weekday = cadence === 'monthly-weekday' ? Number(form.get('weekday')) : undefined
    const weekOrdinal = cadence === 'monthly-weekday' ? Number(form.get('weekOrdinal')) as Recurring['weekOrdinal'] : undefined
    const kind = String(form.get('kind')) as Recurring['kind']
    if (!Number.isFinite(amount) || amount <= 0 || !isValidScheduleDate(nextDateValue) || !state.categories.some(category => category.id === categoryId) || cadence === 'custom' && (!Number.isInteger(intervalDays) || intervalDays! < 1) || cadence === 'semimonthly' && (!Number.isInteger(secondDay) || secondDay! < 1 || secondDay! > 31 || secondDay === Number(nextDateValue.slice(8, 10))) || cadence === 'monthly-weekday' && (!Number.isInteger(weekday) || weekday! < 0 || weekday! > 6 || ![1, 2, 3, 4, -1].includes(weekOrdinal!))) { setNotice('Check the amount, due date, category, and schedule.'); return }
    const linkedCategory = state.categories.find(category => category.id === categoryId)!
    if (kind === 'sinking' && (linkedCategory.rollover !== 'carry' || budgetPeriod(linkedCategory, state.month).rollover !== 'carry')) { setNotice('Sinking funds need an envelope set to carry forward so monthly contributions can accumulate.'); return }
    const occurrenceDate = cadence === 'monthly-weekday' ? nthWeekdayInMonth(nextDateValue.slice(0, 7), weekday!, weekOrdinal!) : nextDateValue
    const date = new Date(`${occurrenceDate}T12:00:00`)
    const name = String(form.get('name')).trim()
    if (!name) { setNotice('Enter a name for this scheduled item.'); return }
    const bill: Recurring = { id: editingRecurring?.id ?? uid(), name, amount, categoryId, cadence, day: date.getDate(), secondDay, intervalDays, weekday, weekOrdinal, nextDate: occurrenceDate, kind, active: editingRecurring?.active ?? true }
    try { nextOccurrence(bill) } catch { setNotice('This schedule has no next occurrence within the supported date range.'); return }
    update(s => ({ ...s, recurring: editingRecurring ? s.recurring.map(item => item.id === bill.id ? bill : item) : [bill, ...s.recurring] }), `${editingRecurring ? 'Edited' : 'Added'} recurring ${bill.kind.toLowerCase()}: ${bill.name} · ${money(bill.amount)}`)
    setModal(null); setEditingRecurring(null); setNotice(`${bill.name} ${editingRecurring ? 'schedule updated' : 'added to upcoming'}`)
  }
  function deleteRecurring(item: Recurring) {
    const hasPostedHistory = state.transactions.some(transaction => transaction.scheduledOccurrenceId?.startsWith(`${item.id}:`))
    const historyNote = hasPostedHistory ? ' Previously posted transactions will remain in your history.' : ''
    if (!window.confirm(`Delete the ${item.name} schedule?${historyNote}`)) return
    update(s => ({ ...s, recurring: s.recurring.filter(row => row.id !== item.id) }), `Deleted recurring schedule: ${item.name}`)
    setNotice(`${item.name} schedule deleted`)
  }
  function addCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const name = String(form.get('name') ?? '').trim()
    if (!name) { setNotice('Name cannot be empty.'); return }
    const plannedText = String(form.get('planned') ?? '').trim(); const planned = Number(plannedText); const rollover = String(form.get('rollover')) as Category['rollover']; const capText = String(form.get('cap') ?? '').trim(); const cap = capText ? Number(capText) : undefined
    if (!plannedText || !Number.isFinite(planned) || planned < 0 || !['carry', 'reset', 'cap'].includes(rollover) || cap !== undefined && (!Number.isFinite(cap) || cap < 0)) { setNotice('Enter a valid plan and rollover cap.'); return }
    const category: Category = { id: uid(), name, color: String(form.get('color')), icon: 'tag', planned, rollover, cap, periods: { [state.month]: { planned, rollover, cap } } }
    update(s => ({ ...s, categories: [...s.categories, category] }), `Created ${name} envelope · ${money(category.planned)} planned`)
    setModal(null); setNotice(`${name} envelope created`)
  }
  function moveFunds(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget)
    const fromCategoryId = String(form.get('fromCategoryId')); const toCategoryId = String(form.get('toCategoryId'))
    const requestedAmount = Number(form.get('amount'))
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
      setNotice('Enter a valid transfer amount greater than zero.')
      return
    }
    const amount = Math.round(requestedAmount * 100) / 100; const note = String(form.get('note')).trim()
    if (amount <= 0) { setNotice('Enter a transfer amount of at least one cent.'); return }
    if (fromCategoryId === toCategoryId) { setNotice('Choose two different envelopes.'); return }
    const source = state.categories.find(c => c.id === fromCategoryId)
    const toCategory = state.categories.find(c => c.id === toCategoryId)
    if (!source) { setNotice('The source envelope no longer exists. Choose an available envelope.'); return }
    if (!toCategory) { setNotice('The destination envelope no longer exists. Choose a valid destination.'); return }
    const available = availableFor(source, state.transactions, state.month, state.moves, state.adjustments ?? [])
    if (Math.round(amount * 100) > Math.round(available * 100)) { setNotice(`Choose an amount up to the ${money(Math.max(0, available))} available.`); return }
    update(s => ({ ...s, moves: [...(s.moves ?? []), { id: uid(), date: s.month === today().slice(0, 7) ? today() : `${s.month}-01`, fromCategoryId, toCategoryId, amount, note }] }), `Moved ${money(amount)} ${source.name} → ${toCategory.name}: ${note}`)
    setModal(null); setNotice(`${money(amount)} moved to ${toCategory.name}`)
  }
  function addIncome(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget)
    const name = String(form.get('name') ?? '').trim()
    if (!name) { setNotice('Name cannot be empty.'); return }
    const frequency = String(form.get('frequency')) as import('./types').ScheduleCadence
    const selectedDate = String(form.get('startDate'))
    const amount = Number(form.get('amount'))
    const weekday = frequency === 'monthly-weekday' ? Number(form.get('weekday')) : undefined
    const weekOrdinal = frequency === 'monthly-weekday' ? Number(form.get('weekOrdinal')) as 1 | 2 | 3 | 4 | -1 : undefined
    const intervalDays = frequency === 'custom' ? Number(form.get('intervalDays')) : undefined
    const secondDay = frequency === 'semimonthly' ? Number(form.get('secondDay')) : undefined
    const selectedDay = isValidScheduleDate(selectedDate) ? Number(selectedDate.slice(8, 10)) : 0
    if (!Number.isFinite(amount) || amount <= 0 || !isValidScheduleDate(selectedDate) || frequency === 'custom' && (!Number.isInteger(intervalDays) || intervalDays! < 1) || frequency === 'semimonthly' && (!Number.isInteger(secondDay) || secondDay! < 1 || secondDay! > 31 || secondDay === selectedDay) || frequency === 'monthly-weekday' && (!Number.isInteger(weekday) || weekday! < 0 || weekday! > 6 || ![1, 2, 3, 4, -1].includes(weekOrdinal!))) { setNotice('Enter a positive income amount and valid first pay date and schedule.'); return }
    const startDate = frequency === 'monthly-weekday' ? nthWeekdayInMonth(selectedDate.slice(0, 7), weekday!, weekOrdinal!) : selectedDate
    const start = new Date(`${startDate}T12:00:00`)
    const incomeItem = { id: uid(), name, amount, cadence: `${frequency} from ${startDate}`, frequency, startDate, day: start.getDate(), secondDay, intervalDays, weekday, weekOrdinal }
    try { nextOccurrence({ cadence: frequency, nextDate: startDate, day: incomeItem.day, secondDay, intervalDays, weekday, weekOrdinal }) } catch { setNotice('This income schedule has no next occurrence within the supported date range.'); return }
    update(s => ({ ...s, income: [...s.income, incomeItem] }), `Added income source ${incomeItem.name} · ${money(incomeItem.amount)}`)
    setNotice(`${incomeItem.name} added`); event.currentTarget.reset()
  }
  function saveIncome(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault(); const form = new FormData(event.currentTarget)
    const name = String(form.get('name') ?? '').trim(); const amount = Number(form.get('amount')); const cadence = String(form.get('cadence') ?? '').trim()
    if (!name) { setNotice('Name cannot be empty.'); return }
    if (!Number.isFinite(amount) || amount <= 0) { setNotice('Enter an income amount greater than zero.'); return }
    if (!cadence) { setNotice('Enter an income schedule.'); return }
    update(s => ({ ...s, income: s.income.map(item => item.id === id ? { ...item, name, amount, cadence } : item) }), `Edited income source ${name} · ${money(amount)}`)
    setNotice('Income source saved')
  }
  function deleteIncome(id: string) {
    const income = state.income.find(item => item.id === id)
    if (!income) return
    update(s => ({ ...s, income: s.income.filter(item => item.id !== id) }), `Removed income source ${income.name}`)
    setNotice('Income source removed')
  }
  function saveCurrentBalance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const value = Number(new FormData(event.currentTarget).get('currentBalance'))
    if (!Number.isFinite(value)) { setNotice('Enter a valid current balance.'); return }
    update(s => ({ ...s, currentBalance: value }), `Updated current balance to ${money(value)}`)
    setModal(null); setNotice('Current balance saved for cash-flow forecast')
  }
  async function postRecurring(item: Recurring) {
    const postingBudgetId = budgetId
    if (!loaded.current || !postingBudgetId || activeBudgetRef.current !== postingBudgetId) return
    const occurrence = scheduledOccurrenceId(item.id, item.nextDate)
    const current = stateRef.current.recurring.find(row => row.id === item.id)
    if (postedOccurrences.current.has(occurrence) || !current?.active || current.nextDate !== item.nextDate) return
    postedOccurrences.current.add(occurrence)
    const baseState = stateRef.current
    setPostingIds(ids => new Set(ids).add(item.id))
    const occurrenceId = scheduledOccurrenceId(item.id, item.nextDate)
    try {
      const revision = revisionsByBudgetRef.current.get(postingBudgetId) ?? revisionRef.current
      const response = await fetch(`/api/recurring/${encodeURIComponent(item.id)}/post?budgetId=${encodeURIComponent(postingBudgetId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ occurrenceDate: item.nextDate, revision }) })
      if (response.ok) {
        const result = await response.json() as { duplicate: boolean; state: AppState & { revision?: number } }
        if (result.state.revision !== undefined) revisionsByBudgetRef.current.set(postingBudgetId, result.state.revision)
        if (activeBudgetRef.current !== postingBudgetId) return
        revisionRef.current = result.state.revision ?? revisionRef.current
        // A post only changes its occurrence, schedule date, and audit entry.
        // Rebase those fields onto current local state so edits made while the
        // request was in flight are not replaced by the older server snapshot.
        const local = stateRef.current
        const postedTransaction = result.state.transactions.find(tx => tx.scheduledOccurrenceId === occurrence)
        const localSchedule = local.recurring.find(row => row.id === item.id)
        const baseSchedule = baseState.recurring.find(row => row.id === item.id)
        const scheduleRule = (row: Recurring | undefined) => row && JSON.stringify([row.cadence, row.day, row.secondDay, row.intervalDays, row.weekday, row.weekOrdinal])
        const serverSchedule = result.state.recurring.find(row => row.id === item.id)
        const mergedRecurring = local.recurring.map(row => {
          if (row.id !== item.id || !serverSchedule || !localSchedule || !baseSchedule || localSchedule.nextDate !== baseSchedule.nextDate) return row
          // Preserve a manual cadence edit, while advancing the occurrence just
          // posted. An explicit manual next-date change takes precedence.
          const nextDate = scheduleRule(localSchedule) === scheduleRule(baseSchedule) ? serverSchedule.nextDate : nextOccurrence({ ...localSchedule, nextDate: item.nextDate })
          return { ...row, nextDate }
        })
        let mergedTransactions = local.transactions
        if (postedTransaction && !mergedTransactions.some(tx => tx.scheduledOccurrenceId === occurrence || tx.id === postedTransaction.id)) {
          const validCategoryId = local.categories.some(category => category.id === postedTransaction.categoryId) ? postedTransaction.categoryId : localSchedule?.categoryId ?? local.categories[0]?.id
          if (validCategoryId) mergedTransactions = [{ ...postedTransaction, categoryId: validCategoryId }, ...mergedTransactions]
        }
        const knownAudit = new Set(local.audit.map(entry => entry.id))
        const merged: AppState & { revision?: number } = { ...local, transactions: mergedTransactions, recurring: mergedRecurring, audit: [...result.state.audit.filter(entry => !knownAudit.has(entry.id)), ...local.audit].slice(0, 250), revision: result.state.revision }
        generationsByBudgetRef.current.set(postingBudgetId, (generationsByBudgetRef.current.get(postingBudgetId) ?? 0) + 1)
        stateRef.current = merged; dispatch(replaceState(merged)); setStatus('online')
        setNotice(result.duplicate ? `${item.name} was already posted for this date` : `${item.name} marked paid and posted`)
      } else if (response.status === 409) {
        const latest = await fetch(`/api/state?budgetId=${encodeURIComponent(postingBudgetId)}`).then(res => res.json() as Promise<AppState & { revision?: number }>)
        if (latest.revision !== undefined) revisionsByBudgetRef.current.set(postingBudgetId, latest.revision)
        if (activeBudgetRef.current === postingBudgetId) { generationsByBudgetRef.current.set(postingBudgetId, (generationsByBudgetRef.current.get(postingBudgetId) ?? 0) + 1); revisionRef.current = latest.revision ?? null; stateRef.current = latest; dispatch(replaceState(latest)); setNotice(`${item.name} schedule was refreshed`) }
      } else {
        const result = await response.json(); if (activeBudgetRef.current === postingBudgetId) setNotice(result.error ?? 'Could not post this scheduled item.')
      }
    } catch {
      if (activeBudgetRef.current !== postingBudgetId) return
      const transaction = scheduledTransactionFor(item, item.nextDate)
      update(s => ({ ...s, transactions: s.transactions.some(tx => tx.scheduledOccurrenceId === occurrenceId || tx.id === transaction.id) ? s.transactions : [transaction, ...s.transactions], recurring: s.recurring.map(row => row.id === item.id && row.nextDate === item.nextDate ? { ...row, nextDate: nextOccurrence(row) } : row) }), `Posted scheduled ${item.kind}: ${item.name} · ${money(item.amount)}`)
      setNotice(`${item.name} marked paid and posted`)
    } finally {
      // This set is an in-flight guard. Persisted transactions prevent reposts;
      // failed attempts must be retryable without a full page reload.
      postedOccurrences.current.delete(occurrence)
      setPostingIds(ids => { const next = new Set(ids); next.delete(item.id); return next })
    }
  }
  function saveCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!editingCategory) return
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name') ?? '').trim()
    if (!name) { setNotice('Name cannot be empty.'); return }
    const plannedText = String(form.get('planned') ?? '').trim(); const planned = Number(plannedText); const capText = String(form.get('cap') ?? '').trim(); const cap = capText ? Number(capText) : undefined
    const rollover = String(form.get('rollover')) as Category['rollover']
    if (!plannedText || !Number.isFinite(planned) || planned < 0 || !['carry', 'reset', 'cap'].includes(rollover) || cap !== undefined && (!Number.isFinite(cap) || cap < 0)) { setNotice('Enter a valid plan and rollover cap.'); return }
    const period = { planned, rollover, cap }
    if (state.recurring.some(item => item.kind === 'sinking' && item.categoryId === editingCategory.id) && period.rollover !== 'carry') { setNotice('This envelope funds a sinking fund. Keep rollover set to carry so contributions can accumulate.'); return }
    const category: Category = { ...editingCategory, name, color: String(form.get('color')), rollover: period.rollover, cap: period.cap }
    const oldPeriod = budgetPeriod(editingCategory, state.month)
    update(s => ({ ...s, categories: s.categories.map(item => item.id === category.id ? { ...category, periods: { ...item.periods, [s.month]: period } } : item) }), `Edited ${editingCategory.name}: plan ${money(oldPeriod.planned)} → ${money(period.planned)}, rollover ${oldPeriod.rollover} → ${period.rollover}${period.rollover === 'cap' ? ` (${money(period.cap ?? period.planned)} cap)` : ''}`)
    setModal(null); setEditingCategory(null); setNotice('Envelope settings saved')
  }
  function deleteCategory() {
    if (!editingCategory) return
    if (state.categories.length < 2) { setNotice('Keep at least one envelope in your plan.'); return }
    const id = editingCategory.id
    const linked = state.transactions.some(tx => tx.categoryId === id || tx.splits?.some(split => split.categoryId === id)) || state.recurring.some(item => item.categoryId === id) || state.moves.some(move => move.fromCategoryId === id || move.toCategoryId === id) || (state.adjustments ?? []).some(item => item.categoryId === id) || state.rules.some(rule => rule.categoryId === id)
    const needsReassignment = linked
    const targetId = reassignmentTargetId
    const targetCategory = state.categories.find(category => category.id === targetId && category.id !== id)
    if (needsReassignment && !targetCategory) { setNotice('Choose another envelope to receive this envelope’s linked history and plans.'); return }
    if (needsReassignment && !window.confirm(`Delete “${editingCategory.name}” and reassign its transactions, transfers, adjustments, recurring items, rules, and monthly plans to ${targetCategory!.name}?`)) return
    update(s => {
      const deleted = s.categories.find(category => category.id === id)!
      const target: Category = s.categories.find(category => category.id === targetId && category.id !== id) ?? { id: targetId, name: '', color: '#9a9c8a', icon: 'tag', planned: 0, rollover: 'reset' }
      const monthKeys = new Set([...Object.keys(deleted.plannedByMonth ?? {}), ...Object.keys(target.plannedByMonth ?? {}), ...Object.keys(deleted.periods ?? {}), ...Object.keys(target.periods ?? {})])
      const plannedByMonth = needsReassignment ? Object.fromEntries([...monthKeys].map(month => [month, plannedAmount(deleted, month) + plannedAmount(target, month)])) : target.plannedByMonth
      const periods = needsReassignment ? Object.fromEntries([...monthKeys].map(month => [month, { ...budgetPeriod(target, month), planned: plannedAmount(deleted, month) + plannedAmount(target, month) }])) : target.periods
      const mergedTarget = { ...target, planned: target.planned + (needsReassignment ? deleted.planned : 0), plannedByMonth, periods }
      const categories = s.categories.filter(category => category.id !== id)
      if (needsReassignment) categories.push(mergedTarget)
      const remap = (categoryId: string) => categoryId === id ? targetId : categoryId
      const moves = (s.moves ?? []).map(move => ({ ...move, fromCategoryId: remap(move.fromCategoryId), toCategoryId: remap(move.toCategoryId) })).filter(move => move.fromCategoryId !== move.toCategoryId)
      return { ...s, categories, moves, transactions: s.transactions.map(tx => ({ ...tx, categoryId: remap(tx.categoryId), splits: tx.splits?.map(split => ({ ...split, categoryId: remap(split.categoryId) })) })), recurring: s.recurring.map(item => ({ ...item, categoryId: remap(item.categoryId) })), adjustments: (s.adjustments ?? []).map(item => ({ ...item, categoryId: remap(item.categoryId) })), rules: s.rules.map(rule => ({ ...rule, categoryId: remap(rule.categoryId) })) }
    }, `Deleted ${editingCategory.name}; historical plans and linked records ${needsReassignment ? `reassigned to ${targetCategory!.name}` : 'removed'}`)
    setModal(null); setEditingCategory(null); setNotice(needsReassignment ? `Envelope history and linked records reassigned to ${targetCategory!.name}` : 'Envelope deleted')
  }
  function createDraft() { setPlanDraft(Object.fromEntries(draftPlan(state).map(row => [row.categoryId, row.suggested]))); setModal('plan') }
  function applyDraft() {
    const current = stateRef.current
    const changes = current.categories.filter(category => plannedAmount(category, current.month) !== (planDraft[category.id] ?? plannedAmount(category, current.month))).map(category => `${category.name} ${money(plannedAmount(category, current.month))} → ${money(planDraft[category.id]!)}`)
    update(s => ({ ...s, categories: s.categories.map(category => ({ ...category, periods: { ...category.periods, [s.month]: { ...budgetPeriod(category, s.month), planned: planDraft[category.id] ?? plannedAmount(category, s.month) } } })) }), `Applied plan changes: ${changes.join('; ') || 'no amount changes'}`)
    setModal(null); setNotice('Your updated plan is saved')
  }
  function applyDraftCategory(categoryId: string) {
    const category = state.categories.find(item => item.id === categoryId)
    if (!category) return
    const amount = planDraft[categoryId] ?? plannedAmount(category, state.month)
    update(current => ({ ...current, categories: current.categories.map(item => item.id === categoryId ? { ...item, periods: { ...item.periods, [current.month]: { ...budgetPeriod(item, current.month), planned: amount } } } : item) }), `Changed ${category.name} plan from ${money(plannedAmount(category, state.month))} to ${money(amount)}`)
    setNotice(`${category.name} plan updated`)
  }
  function duplicateBudget() {
    const nextMonth = new Date(shownDate.getFullYear(), shownDate.getMonth() + 1, 1).toISOString().slice(0, 7)
    update(s => ({ ...s, categories: s.categories.map(c => ({ ...c, periods: { ...c.periods, [nextMonth]: { ...budgetPeriod(c, s.month) } } })), month: nextMonth }), `Copied ${shownMonth} planned amounts and rollover settings forward`)
    setNotice('Planned amounts and rollover settings copied to next month')
  }
  function setReportRange(preset: 'month' | '30days' | '90days' | 'all') {
    if (preset === 'all') { setDateFrom(''); setDateTo(''); return }
    const end = new Date(); end.setHours(12, 0, 0, 0)
    const start = new Date(end)
    if (preset === 'month') start.setDate(1)
    else start.setDate(start.getDate() - (preset === '30days' ? 29 : 89))
    const format = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    setDateFrom(format(start)); setDateTo(format(end))
  }
  async function createNamedBudget() {
    const name = window.prompt('Name this budget (for example, Shared household):')?.trim()
    if (!name) return
    try {
      const response = await fetch('/api/budgets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, sourceId: budgetId ?? 'default' }) })
      const result = await response.json() as { id?: string; name?: string; error?: string }
      if (!response.ok || !result.id || !result.name) throw new Error(result.error ?? 'Could not create budget.')
      setBudgets(current => [...current, { id: result.id!, name: result.name! }])
      activeBudgetRef.current = result.id
      setBudgetId(result.id)
      setNotice(`Created ${result.name}`)
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not create budget.') }
  }

  return <div className={`app-shell min-h-screen bg-gradient-to-br from-paper via-white to-sage-50/70 font-sans text-ink antialiased ${showMenu ? 'mobile-nav-open' : ''}`}>
    <aside className="sidebar">
      <a className="brand" href="#home" onClick={e => { e.preventDefault(); setTab('Overview') }}><span className="brand-mark"><Leaf size={20} fill="currentColor" /></span><span className="brand-name">pocketplan<span className="brand-dot">.</span></span></a>
      <div className="workspace-label">YOUR MONEY</div>
      <nav className="main-nav" aria-label="Main navigation">
        {(['Overview', 'My plan', 'Activity', 'Upcoming'] as Tab[]).map((item, index) => {
          const Icon = [Home, Wallet, CreditCard, CalendarDays][index]
          return <button key={item} className={`nav-item ${tab === item ? 'active' : ''}`} onClick={() => setTab(item)}><Icon size={17} strokeWidth={1.8} /><span>{item}</span>{item === 'Upcoming' && <span className="nav-count">{upcomingBills(state).length}</span>}</button>
        })}
      </nav>
      <div className="sidebar-section"><div className="workspace-label">YOUR ENVELOPES</div><div className="envelope-nav">{state.categories.slice(0, 5).map(cat => <button key={cat.id} onClick={() => { setTab('My plan'); setCatFilter(cat.id) }}><span className="tiny-dot" style={{ background: cat.color }} />{cat.name}</button>)}<button className="add-envelope" onClick={() => setModal('category')}><Plus size={14} />New envelope</button></div></div>
      <div className="sidebar-bottom"><div className={`sync-pill ${status}`}><span className="sync-dot" />{status === 'online' ? 'Saved & in sync' : status === 'offline' ? 'Local preview' : 'Connecting...'}</div><button className="nav-item"><Settings size={17} /><span>Settings</span></button><button className="profile-card"><span className="avatar">V</span><span className="profile-copy"><b>Vikranth</b><small>Personal workspace</small></span><MoreHorizontal size={17} /></button></div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div className="breadcrumbs"><span>My workspace</span><span className="crumb-slash">/</span><b>{tab}</b></div><div className="topbar-actions"><select aria-label="Active budget" className="date-label" value={budgetId ?? ''} onChange={event => { activeBudgetRef.current = event.target.value; loaded.current = false; setBudgetId(event.target.value) }} disabled={!budgets.length}><option value="" disabled>Choose budget</option>{budgets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button className="icon-button" aria-label="Create named budget" title="Create a separate budget" onClick={createNamedBudget}><Plus size={17} /></button><button className="icon-button mobile-menu" aria-label="Menu" onClick={() => setShowMenu(!showMenu)}><Menu size={18} /></button><button className="date-control" onClick={() => changeMonth(-1)} aria-label="Previous month"><ArrowLeft size={15} /></button><button className="date-label" onClick={() => changeMonth(0)}><CalendarDays size={15} />{shownMonth}<ChevronDown size={14} /></button><button className="date-control" onClick={() => changeMonth(1)} aria-label="Next month"><ArrowRight size={15} /></button><span className={`top-status ${status}`}><span />{status === 'online' ? 'Synced' : status === 'offline' ? 'Offline' : 'Syncing'}</span><button className="icon-button" aria-label="Notifications"><Bell size={17} /><i className="notification-dot" /></button><button className="avatar top-avatar" aria-label="Profile">V</button></div></header>
      <div className="page-content">
        {tab === 'Overview' && <>
          <div className="welcome-row"><div><div className="eyebrow"><span className="sun-mark"><Sparkles size={13} /></span> {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase()}</div><h1>A little more <em>clarity.</em></h1><p className="page-subtitle">Your money feels better when it has a plan.</p></div><button className="button primary" onClick={() => openTransaction()}><Plus size={16} />Add transaction</button></div>
          <div className="stat-grid">
            <StatCard label="Available in envelopes" value={money(totalAvailable)} helper={`${money(spent)} spent · ${money(budgeted)} planned this month`} icon={<Wallet size={17} />} tone="sage" progress={Math.min(spent / Math.max(budgeted, 1) * 100, 100)} />
            <StatCard label="Income this month" value={money(income)} helper={`${state.income.length} income sources`} icon={<ArrowDownLeft size={17} />} tone="cream" />
            <StatCard label="Gross spending" value={money(spent)} helper={`${txns.length} original expenses`} icon={<ArrowUpRight size={17} />} tone="rose" />
            <StatCard label="Reimbursements received" value={money(reimbursements)} helper="Money returned so far" icon={<ArrowDownLeft size={17} />} tone="cream" />
            <StatCard label="Net expense" value={money(netExpense)} helper="Gross spending less received reimbursements" icon={<Wallet size={17} />} tone="blue" />
            <StatCard label="Saved by your plan" value={`${savingsRate}%`} helper="Of income not yet spent" icon={<TrendingUp size={17} />} tone="blue" />
          </div>
          <CashFlowForecast configured={state.currentBalance !== undefined} currentBalance={state.currentBalance ?? 0} events={forecast} endingBalance={forecastBalance ?? 0} onSetBalance={() => setModal("balance")} onMoveFunds={() => setModal('transfer')} onReview={kind => setTab(kind === 'bills' ? 'Upcoming' : 'Activity')} />
          <InsightsPanel anomalies={anomalies} categories={state.categories} onMoveFunds={() => setModal('transfer')} onReviewActivity={() => setTab('Activity')} onAdjustPlan={categoryId => { const category = state.categories.find(item => item.id === categoryId); if (category) { setEditingCategory(category); setReassignmentTargetId(state.categories.find(item => item.id !== category.id)?.id ?? ''); setModal('category-edit') } }} />
          <div className="overview-grid"><section className="panel shadow-card plan-panel"><div className="panel-heading"><div><span className="section-kicker">THE BIG PICTURE</span><h2>Your envelopes</h2></div><button className="text-link" onClick={() => setTab('My plan')}>See your plan <ArrowRight size={14} /></button></div><div className="envelope-list">{state.categories.slice(0, 5).map(cat => <EnvelopeRow key={cat.id} category={cat} transactions={state.transactions} month={state.month} moves={state.moves} adjustments={state.adjustments ?? []} onClick={() => { setCatFilter(cat.id); setTab('My plan') }} />)}</div><button className="all-envelopes" onClick={() => setTab('My plan')}>View all {state.categories.length} envelopes <ArrowRight size={14} /></button></section>
            <div className="right-stack"><section className="plan-note"><span className="note-ornament"><Sparkles size={17} /></span><div className="note-kicker">A NOTE FOR YOU</div><h3>{spent > budgeted * .5 ? 'You’re finding your rhythm.' : 'You’re off to a thoughtful start.'}</h3><p>{spent > budgeted * .5 ? `You’ve given every dollar a direction. ${money(Math.max(0, totalAvailable))} is still sitting in its envelope.` : `Your envelopes have ${money(Math.max(0, totalAvailable))} available for the rest of the month.`}</p><button onClick={createDraft}>Review a plan idea <ArrowRight size={14} /></button></section>
              <section className="panel shadow-card upcoming-panel"><div className="panel-heading compact"><div><span className="section-kicker">ON THE HORIZON</span><h2>Coming up</h2></div><button className="round-arrow" onClick={() => setTab('Upcoming')} aria-label="View upcoming"><ArrowRight size={15} /></button></div>{upcomingBills(state).slice(0, 3).map(item => { const category = state.categories.find(c => c.id === item.categoryId); const available = category ? availableFor(category, state.transactions, state.month, state.moves, state.adjustments ?? []) : undefined; return <UpcomingRow key={item.id} item={item} category={category} availableAfter={available === undefined ? undefined : available - item.amount} /> })}<button className="bill-add" onClick={openNewRecurring}><Plus size={14} />Add a bill or sinking fund</button></section></div>
          </div>
          <section className="panel shadow-card transactions-panel"><div className="panel-heading"><div><span className="section-kicker">A LITTLE PAPER TRAIL</span><h2>Recent activity</h2></div><button className="text-link" onClick={() => setTab('Activity')}>All activity <ArrowRight size={14} /></button></div><TransactionTable transactions={recent.slice(0, 5)} categories={state.categories} onEdit={openTransaction} onReimbursement={openReimbursement} /></section>
          <div className="footer-note"><ShieldCheck size={15} /> Your budget belongs to you. Every change is saved in your private workspace.</div>
        </>}
        {tab === 'My plan' && <>
          <div className="welcome-row page-title-row"><div><div className="eyebrow"><span className="sun-mark"><Sparkles size={13} /></span> YOUR MONTHLY PLAN</div><h1>A plan with <em>room to breathe.</em></h1><p className="page-subtitle">Every dollar gets a little place to belong.</p></div><div className="button-cluster"><button className="button secondary" onClick={duplicateBudget}><Command size={15} />Copy to next month</button><button className="button primary" onClick={() => setModal('category')}><Plus size={16} />New envelope</button></div></div>
          <div className="plan-summary"><div><small>MONTHLY INCOME</small><b>{money(income)}</b></div><div><small>GIVEN A JOB</small><b>{money(budgeted)}</b></div><div><small>LEFT TO PLAN</small><b className={unallocated < 0 ? 'negative' : ''}>{money(unallocated)}</b></div><button className="button secondary" onClick={() => setModal('income')}><ArrowDownLeft size={14} />Income sources</button><button className="button secondary" onClick={() => setModal('transfer')}><ArrowRight size={14} />Move money</button><button className="button soft" onClick={createDraft}><Sparkles size={15} />Suggest a plan</button></div>
          {unallocated < 0 && <div className="alert-line"><CircleHelp size={16} />Your envelope plans are {money(Math.abs(unallocated))} above expected income this month. Review your plan before applying it.</div>}
          <div className="plan-layout"><section className="panel shadow-card envelope-panel"><div className="panel-heading"><div><span className="section-kicker">THE PLAN, ENVELOPE BY ENVELOPE</span><h2>Your envelopes <span className="count-pill">{state.categories.length}</span></h2></div><button className="text-link" onClick={() => setModal('category')}><Plus size={15} />Create one</button></div><div className="category-cards">{state.categories.map(cat => <CategoryCard key={cat.id} category={cat} transactions={state.transactions} month={state.month} moves={state.moves} adjustments={state.adjustments ?? []} onEdit={() => { setEditingCategory(cat); setReassignmentTargetId(state.categories.find(category => category.id !== cat.id)?.id ?? ''); setModal('category-edit') }} />)}</div><div className="empty-spaces"><div className="empty-illustration"><Sparkles size={20} /></div><div><b>Give a new goal its own envelope</b><p>Trips, gifts, and annual bills make room for what matters.</p></div><button className="button secondary" onClick={() => setModal('category')}><Plus size={15} />Add envelope</button></div></section><aside className="plan-aside"><section className="panel shadow-card aside-card"><span className="section-kicker">HOW YOUR PLAN IS DOING</span><h2>Room to choose</h2><div className="donut-wrap"><Donut spent={spent} budgeted={budgeted} /><div className="donut-center"><b>{Math.max(0, Math.round(totalAvailable / Math.max(1, totalAvailable + spent) * 100))}%</b><small>AVAILABLE</small></div></div><div className="legend-row"><span><i className="legend-spent" />Spent so far</span><b>{money(spent)}</b></div><div className="legend-row"><span><i className="legend-plan" />Available in envelopes</span><b>{money(totalAvailable)}</b></div><p className="aside-hint">Available amounts include rollovers, transfers, and adjustments, less posted transactions.</p></section><section className="ai-mini"><Sparkles size={17} /><div><b>A thoughtful starting point</b><p>Use a few months of spending to draft your next plan. You choose what to keep.</p><button onClick={createDraft}>See suggestions <ArrowRight size={14} /></button></div></section></aside></div>
        </>}
        {tab === 'Activity' && <>
          <div className="welcome-row activity-title"><div><div className="eyebrow"><span className="sun-mark"><Sparkles size={13} /></span> EVERY LITTLE THING, IN ONE PLACE</div><h1>The <em>paper trail.</em></h1><p className="page-subtitle">Your purchases, adjustments, and reimbursements.</p></div><div className="button-cluster"><button className="button secondary" onClick={() => setModal('bulk-transactions')}><FileClock size={15} />Import CSV</button><button className="button primary" onClick={() => openTransaction()}><Plus size={16} />Add transaction</button></div></div>
          <section className="panel shadow-card range-report"><div className="range-report-heading"><div><span className="section-kicker">BUDGET REPORT</span><h2>{dateFrom || dateTo ? `${dateFrom || 'All time'} — ${dateTo || 'Today'}` : 'All recorded activity'}</h2></div><div className="range-presets"><button onClick={() => setReportRange('month')}>This month</button><button onClick={() => setReportRange('30days')}>30 days</button><button onClick={() => setReportRange('90days')}>90 days</button><button onClick={() => setReportRange('all')}>All time</button></div></div>{rangeIsInvalid && <p className="range-error">Start date must be on or before the end date.</p>}<div className="range-report-metrics"><div><small>PLANNED IN RANGE</small><b>{money(rangeBudget.planned)}</b></div><div><small>ACTUAL SPENDING</small><b>{money(rangeBudget.actual)}</b></div><div><small>AVAILABLE AT END</small><b>{money(rangeBudget.available)}</b></div><div><small>NET SPENDING</small><b>{money(rangeNetSpending)}</b></div></div><div className="range-table"><div className="range-table-row range-table-head"><span>ENVELOPE</span><span>PLANNED</span><span>ACTUAL</span><span>AVAILABLE</span></div>{reportCategories.map(({ category, planned, actual, available }) => <div className="range-table-row" key={category.id}><span><i style={{ background: category.color }} />{category.name}</span><b>{money(planned)}</b><b>{money(actual)}</b><b className={available < 0 ? 'negative' : ''}>{money(available)}</b></div>)}</div><div className="range-report-footer">Gross spending {money(totalSpent(reportTransactions))} · reimbursements received {money(rangeReimbursements)} · {reportTransactions.length} transactions. Planned amounts are prorated by calendar days for partial months.</div></section>
          {state.rules.length > 0 && <section className="panel shadow-card rules-panel"><div className="panel-heading"><div><span className="section-kicker">SMART CATEGORIZATION</span><h2>Saved rules <span className="optional">longer matches take precedence</span></h2></div></div><p className="rules-help">Rules only suggest a category while you enter a purchase. Use “Apply to history” to apply this rule where it has the highest precedence; split transactions are preserved.</p>{state.rules.map(rule => <form className="saved-rule-row" key={rule.id} onSubmit={event => saveEditedRule(event, rule.id)}><label><span>Contains phrase</span><input name="contains" required maxLength={100} defaultValue={rule.contains} /></label><label><span>Suggest envelope</span><select name="categoryId" defaultValue={rule.categoryId}>{state.categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><button className="button secondary small-button" type="submit">Save</button><button className="button soft small-button" type="button" onClick={() => applyRuleToHistory(rule)}>Apply to history</button><button className="text-button" type="button" onClick={() => { if (window.confirm(`Delete the “${rule.contains}” rule?`)) update(current => ({ ...current, rules: current.rules.filter(item => item.id !== rule.id) }), `Deleted categorization rule: ${rule.contains}`) }}>Delete</button></form>)}</section>}
          <section className="panel shadow-card activity-panel"><div className="activity-toolbar"><div><span className="section-kicker">{filtered.length} TRANSACTIONS</span><h2>Recent activity</h2></div><div className="filter-tools"><label className="search-box"><Search size={15} /><input placeholder="Find a transaction..." value={query} onChange={e => setQuery(e.target.value)} /><kbd>? K</kbd></label><label className="select-filter"><ListFilter size={15} /><select value={catFilter} onChange={e => setCatFilter(e.target.value)}><option value="all">All envelopes</option><option value="uncategorized">Uncategorized</option>{state.categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><ChevronDown size={13} /></label><label className="select-filter"><select aria-label="Reimbursement status" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="all">Any status</option><option value="regular">Not reimbursable</option><option value="pending">Reimbursement pending</option><option value="received">Reimbursed</option></select><ChevronDown size={13} /></label><input className="range-filter" type="date" aria-label="From date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} /><input className="range-filter" type="date" aria-label="To date" value={dateTo} onChange={e => setDateTo(e.target.value)} /><input className="amount-filter" type="number" min="0" placeholder="Min $" aria-label="Minimum amount" value={minAmount} onChange={e => setMinAmount(e.target.value)} /><input className="amount-filter" type="number" min="0" placeholder="Max $" aria-label="Maximum amount" value={maxAmount} onChange={e => setMaxAmount(e.target.value)} /></div></div>{selectedTransactions.size > 0 && <div className="bulk-recategory"><span>{selectedTransactions.size} selected · recategorize as</span><select aria-label="Bulk destination envelope" value={bulkCategoryId} onChange={event => setBulkCategoryId(event.target.value)}><option value="">Choose envelope</option>{state.categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select><button className="button soft small-button" onClick={bulkRecategorize}>Move selected</button><button className="text-button" onClick={() => setSelectedTransactions(new Set())}>Clear</button></div>}<TransactionTable transactions={filtered} categories={state.categories} onEdit={openTransaction} onReimbursement={openReimbursement} emptyText="Nothing matches yet. Try another search or add a purchase." selectable selectedIds={selectedTransactions} onToggleSelection={toggleTransactionSelection} onToggleVisible={toggleVisibleSelection} /></section>
          <section className="audit-strip"><div className="audit-icon"><FileClock size={18} /></div><div><b>A clear history, whenever you need it.</b><p>Plan edits, reimbursements, and recurring posts are recorded in your audit trail.</p></div><span>{state.audit.length} saved events</span></section>
        </>}
        {tab === 'Upcoming' && <>
          <div className="welcome-row activity-title"><div><div className="eyebrow"><span className="sun-mark"><Sparkles size={13} /></span> FUTURE YOU SAYS THANKS</div><h1>Coming down <em>the road.</em></h1><p className="page-subtitle">Bills, little subscriptions, and the things you’re setting aside for.</p></div><button className="button primary" onClick={openNewRecurring}><Plus size={16} />Add recurring item</button></div>
          <div className="upcoming-summary"><div className="summary-icon"><CalendarDays size={18} /></div><div><small>SCHEDULED ITEMS</small><b>{state.recurring.length} recurring items</b></div><div className="upcoming-total"><small>NEXT 30 DAYS</small><b>{money(recurringTotalWithinDays(state.recurring, today(), 30))}</b></div></div>
          <section className="panel shadow-card activity-panel"><div className="panel-heading"><div><span className="section-kicker">YOUR RECURRING RHYTHM</span><h2>Scheduled items <span className="optional">not yet paid</span></h2></div><button className="text-link" onClick={openNewRecurring}><Plus size={15} />Add an item</button></div>{state.recurring.slice().sort((a, b) => a.nextDate.localeCompare(b.nextDate)).map(item => { const category = state.categories.find(c => c.id === item.categoryId); const available = category ? availableFor(category, state.transactions, state.month, state.moves, state.adjustments ?? []) : undefined; return <UpcomingFull key={item.id} item={item} category={category} availableAfter={available === undefined ? undefined : available - item.amount} funding={sinkingFundSummary(item, state)} posting={postingIds.has(item.id)} onEdit={() => { setEditingRecurring(item); setModal('bill') }} onDelete={() => deleteRecurring(item)} onToggle={() => update(s => ({ ...s, recurring: s.recurring.map(row => row.id === item.id ? { ...row, active: !row.active } : row) }), `${item.active ? 'Paused' : 'Reactivated'} ${item.name}`)} onPost={() => postRecurring(item)} /> })}{state.recurring.length === 0 && <p className="forecast-empty">No scheduled items yet. Add a bill, subscription, or sinking fund.</p>}</section>
          <div className="forecast-note"><Sparkles size={17} /><div><b>Make room before it’s due.</b><p>Recurring amounts are visible here so you can set aside a little at a time in the matching envelope.</p></div><button onClick={() => setTab('My plan')}>See the plan <ArrowRight size={14} /></button></div>
        </>}
      </div>
    </main>
    {modal && <Modal onClose={() => { setModal(null); setEditingTx(null); setEditingRecurring(null); setEditingCategory(null); setReimbursementTx(null) }} title={modal === 'transaction' ? editingTx ? 'A quick edit' : 'Add a little detail' : modal === 'bulk-transactions' ? 'Import transactions' : modal === 'reimbursement' ? 'Record a reimbursement' : modal === 'bill' ? editingRecurring ? 'Edit scheduled item' : 'Plan for what’s coming' : modal === 'category' ? 'Make room for something' : modal === 'category-edit' ? 'Fine-tune this envelope' : modal === 'transfer' ? 'Move a little money' : modal === 'income' ? 'Income, with a plan' : modal === 'balance' ? 'Set current balance' : 'A thoughtful plan draft'} subtitle={modal === 'balance' ? 'Enter the amount currently available in your account. Forecasted items will be applied from today onward.' : modal === 'bulk-transactions' ? 'Paste a CSV to add up to 500 transactions in one save. All rows are checked before anything is imported.' : modal === 'transaction' ? 'A few details help your plan stay in step with real life.' : modal === 'reimbursement' ? 'Record each payment as it arrives. Receipts reduce net spending, not the original envelope expense.' : modal === 'bill' ? 'We’ll keep this visible so future you has a little warning.' : modal === 'category' ? 'Give a dollar a place to belong.' : modal === 'category-edit' ? 'Update this envelope or remove it from your plan.' : modal === 'transfer' ? 'Move available money between envelopes and leave yourself a note.' : modal === 'income' ? 'Add and update the income sources you expect this month.' : modal === 'plan' ? 'Historical actuals inform a separate draft. Nothing changes unless you apply a suggestion.' : 'Based on your recent spending. Nothing changes until you apply it.'}>
      {modal === 'balance' && <form className="form-grid" onSubmit={saveCurrentBalance}><div className="form-field full"><label>Current balance</label><div className="input-prefix"><span>$</span><input autoFocus name="currentBalance" type="number" step="0.01" required defaultValue={state.currentBalance ?? ''} placeholder="0.00" /></div></div><div className="form-actions"><button type="button" className="button secondary" onClick={() => setModal(null)}>Cancel</button><button className="button primary"><Check size={15} />Save balance</button></div></form>}
      {modal === 'bulk-transactions' && <form className="form-grid" onSubmit={importTransactions}><div className="form-field full"><label>CSV rows</label><textarea name="csv" autoFocus required rows={10} placeholder={'date,merchant,amount,category,description,notes\n2026-10-16,Market,42.50,Food & groceries,Weekly shop,Optional note'} /></div><p className="csv-hint">Required columns: date (YYYY-MM-DD), merchant, amount, category. Category can be an envelope name or ID. Description and notes are optional. Quote values containing commas.</p><div className="form-actions"><button type="button" className="button secondary" onClick={() => setModal(null)}>Cancel</button><button className="button primary"><Check size={15} />Validate and import</button></div></form>}
      {modal === 'reimbursement' && reimbursementTx && <div className="reimbursement-panel"><div className="reimbursement-summary"><b>{reimbursementTx.merchant}</b><span>{money(reimbursementReceived(reimbursementTx))} received of {money(reimbursementExpected(reimbursementTx))}</span><small>{money(reimbursementOutstanding(reimbursementTx))} outstanding</small></div><div className="receipt-list">{(reimbursementTx.reimbursements ?? []).map(receipt => <div className="receipt-row" key={receipt.id}><span>{new Date(`${receipt.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}{receipt.note ? ` · ${receipt.note}` : ''}</span><b>{money(receipt.amount)}</b></div>)}{!reimbursementTx.reimbursements?.length && reimbursementReceived(reimbursementTx) > 0 && <div className="receipt-row"><span>Previously recorded</span><b>{money(reimbursementReceived(reimbursementTx))}</b></div>}</div>{reimbursementOutstanding(reimbursementTx) > 0 ? <form className="form-grid" onSubmit={recordReimbursement}><div className="form-field"><label>Receipt amount</label><div className="input-prefix"><span>$</span><input autoFocus name="amount" type="number" min="0.01" max={reimbursementOutstanding(reimbursementTx)} step="0.01" required placeholder="0.00" /></div></div><div className="form-field"><label>Received date</label><input name="date" type="date" required defaultValue={today()} /></div><div className="form-field full"><label>Note <span className="optional">optional</span></label><input name="note" placeholder="e.g. First half from employer" /></div><div className="form-actions"><button type="button" className="button secondary" onClick={() => { setModal(null); setReimbursementTx(null) }}>Cancel</button><button className="button primary"><ArrowDownLeft size={15} />Record receipt</button></div></form> : <div className="form-actions"><button className="button secondary" onClick={() => { setModal(null); setReimbursementTx(null) }}>Done</button></div>}</div>}
      {modal === 'transaction' && <form className="form-grid" onSubmit={saveTransaction}>
        <div className="form-field full"><label>Merchant or payee</label><input autoFocus name="merchant" defaultValue={editingTx?.merchant} required placeholder="e.g. Green Basket" /></div>
        <div className="form-field"><label>Amount</label><div className="input-prefix"><span>$</span><input name="amount" type="number" min="0.01" step="0.01" required defaultValue={editingTx?.amount} placeholder="0.00" /></div></div>
        <div className="form-field"><label>Date</label><input name="date" type="date" required defaultValue={editingTx?.date ?? today()} /></div>
        <SplitLinesEditor key={splitSuggestionVersion} categories={state.categories} transaction={editingTx} suggested={suggestedSplits} />
        <div className="form-field full"><label>Description <span className="optional">optional</span></label><input name="description" defaultValue={editingTx?.description} placeholder="What was this for?" /></div>
        <div className="form-field full"><label>Account <span className="optional">optional</span></label><input name="account" defaultValue={editingTx?.account} placeholder="e.g. Everyday checking" /></div>
        <div className="form-field full"><label>Notes <span className="optional">optional</span></label><input name="notes" defaultValue={editingTx?.notes} placeholder="A note for later" /></div>
        <ReimbursementField checked={!!editingTx?.reimbursable} expected={editingTx?.reimbursementAmount ?? (editingTx?.reimbursable ? editingTx.amount : 0)} suggestion={reimbursementHint} />
        {!editingTx && <TransactionAssist state={state} onSplitAccept={rows => { setSuggestedSplits(rows); setSplitSuggestionVersion(version => version + 1); setNotice('Split suggestion added. Review or edit every line before saving.') }} onReimbursementAccept={amount => setReimbursementHint(current => ({ token: (current?.token ?? 0) + 1, amount }))} />}
        {!editingTx && <SuggestionPreview state={state} onAccept={categoryId => { const select = document.querySelector<HTMLSelectElement>('select[name="splitCategory"]'); if (select) { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, categoryId); select.dispatchEvent(new Event('change', { bubbles: true })) } setNotice('Suggestion added to the form. Review it before saving.') }} onSaveRule={rule => update(s => ({ ...s, rules: [rule, ...s.rules.filter(item => item.contains.trim().toLowerCase() !== rule.contains.trim().toLowerCase())] }), `Saved categorization rule: ${rule.contains} ? ${state.categories.find(c => c.id === rule.categoryId)?.name ?? ''}`)} />}
        <div className="form-actions"><button type="button" className="button secondary" onClick={() => setModal(null)}>Cancel</button>{editingTx && <button type="button" className="button danger-quiet" onClick={() => deleteTransaction(editingTx)}>Delete</button>}<button className="button primary" type="submit"><Check size={15} />{editingTx ? 'Save changes' : 'Add to my plan'}</button></div>
      </form>}
      {modal === 'bill' && <RecurringItemForm key={editingRecurring?.id ?? 'new'} item={editingRecurring} categories={state.categories} month={state.month} onSubmit={addBill} onCancel={() => { setModal(null); setEditingRecurring(null) }} />}
      {modal === 'category' && <form className="form-grid" onSubmit={addCategory}><div className="form-field full"><label>Envelope name</label><input autoFocus name="name" required placeholder="e.g. Weekend adventures" /></div><div className="form-field"><label>Monthly plan</label><div className="input-prefix"><span>$</span><input type="number" min="0" step="1" name="planned" required placeholder="250" /></div></div><div className="form-field"><label>Color</label><select name="color"><option value="#6c7d5b">Sage</option><option value="#d18a5c">Terracotta</option><option value="#7a83b8">Periwinkle</option><option value="#b47883">Rose</option><option value="#d4ae58">Marigold</option><option value="#659c95">Sea glass</option></select></div><div className="form-field full"><label>At the end of the month</label><select name="rollover"><option value="carry">Carry the closing balance forward, including overspending</option><option value="reset">Start next month at zero rollover</option><option value="cap">Carry the closing balance forward, up to a limit</option></select></div><div className="form-field full"><label>Maximum carried amount (for capped rollover)</label><div className="input-prefix"><span>$</span><input name="cap" type="number" min="0" step="1" placeholder="Defaults to the monthly plan" /></div></div><div className="form-actions"><button className="button secondary" type="button" onClick={() => setModal(null)}>Cancel</button><button className="button primary"><Check size={15} />Create envelope</button></div></form>}
      {modal === 'category-edit' && editingCategory && <form className="form-grid" onSubmit={saveCategory}><div className="form-field full"><label>Envelope name</label><input autoFocus name="name" required defaultValue={editingCategory.name} /></div><div className="form-field"><label>Monthly plan</label><div className="input-prefix"><span>$</span><input type="number" min="0" step="1" name="planned" required defaultValue={plannedAmount(editingCategory, state.month)} /></div></div><div className="form-field"><label>Color</label><select name="color" defaultValue={editingCategory.color}><option value="#6c7d5b">Sage</option><option value="#d18a5c">Terracotta</option><option value="#7a83b8">Periwinkle</option><option value="#b47883">Rose</option><option value="#d4ae58">Marigold</option><option value="#659c95">Sea glass</option><option value="#73936f">Leaf</option><option value="#9a9c8a">Stone</option></select></div><div className="form-field full"><label>At the end of this month</label><select name="rollover" defaultValue={budgetPeriod(editingCategory, state.month).rollover}><option value="carry">Carry the closing balance forward, including overspending</option><option value="reset">Start next month at zero rollover</option><option value="cap">Carry the closing balance forward, up to a limit</option></select></div><div className="form-field full"><label>Maximum carried amount (for capped rollover)</label><div className="input-prefix"><span>$</span><input name="cap" type="number" min="0" step="1" defaultValue={budgetPeriod(editingCategory, state.month).cap ?? plannedAmount(editingCategory, state.month)} /></div></div><div className="form-field full"><p className="delete-explanation">These plan and rollover settings apply to {state.month}. Later months recalculate from this month’s closing balance. If this envelope has linked records, they will move to the selected destination. If it has no linked records, deleting it also removes its saved plan amounts.</p></div><div className="form-field full" hidden={!editingCategoryHasLinkedRecords}><label>Reassign history and plans to</label><select value={reassignmentTargetId} onChange={event => setReassignmentTargetId(event.target.value)}>{state.categories.filter(category => category.id !== editingCategory.id).map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select><small>Transactions, splits, recurring items, transfers, adjustments, rules, and saved monthly plans will be reassigned.</small></div><div className="form-actions"><button type="button" className="button danger-quiet" onClick={deleteCategory}>Delete envelope</button><button type="button" className="button secondary" onClick={() => { setModal(null); setEditingCategory(null) }}>Cancel</button><button className="button primary"><Check size={15} />Save envelope</button></div></form>}
      {modal === 'transfer' && <form className="form-grid" onSubmit={moveFunds}><div className="form-field full"><label>From envelope</label><select name="fromCategoryId" required defaultValue={state.categories[0]?.id}>{state.categories.map(c => <option key={c.id} value={c.id}>{c.name} — {money(Math.max(0, availableFor(c, state.transactions, state.month, state.moves, state.adjustments ?? [])))}</option>)}</select></div><div className="form-field full"><label>Move to</label><select name="toCategoryId" required defaultValue={state.categories[1]?.id ?? state.categories[0]?.id}>{state.categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div><div className="form-field full"><label>Amount</label><div className="input-prefix"><span>$</span><input name="amount" type="number" min="0.01" step="0.01" required placeholder="0.00" /></div></div><div className="form-field full"><label>Why are you moving this? <span className="optional">saved in your audit history</span></label><input name="note" required placeholder="e.g. Moved dining to groceries before hosting" /></div><div className="form-actions"><button type="button" className="button secondary" onClick={() => setModal(null)}>Cancel</button><button className="button primary"><ArrowRight size={14} />Move money</button></div></form>}
      {modal === 'income' && <div className="income-manager"><div className="income-list">{state.income.map(item => <form className="income-row" key={item.id} onSubmit={event => saveIncome(event, item.id)}><label className="income-field"><span>Source</span><input name="name" required defaultValue={item.name} /></label><label className="income-field"><span>Amount per occurrence</span><input name="amount" type="number" min="0" step="0.01" required defaultValue={item.amount} /></label><label className="income-field"><span>{item.frequency ? 'Schedule (edit by removing and re-adding)' : 'Schedule label'}</span><input name="cadence" required defaultValue={item.cadence} readOnly={!!item.frequency} /></label><small className="income-dates">{item.frequency ? incomeDatesForMonth(item, state.month).length ? `Pay dates this month: ${incomeDatesForMonth(item, state.month).join(", ")}` : "No pay dates this month" : item.cadence}</small><button className="button soft small-button" type="submit">Save</button><button className="rule-save" type="button" onClick={() => deleteIncome(item.id)}>Remove</button></form>)}</div><form className="form-grid income-add-form" onSubmit={addIncome}><div className="form-field full"><label>Add another source</label></div><div className="form-field"><label>Name</label><input name="name" required placeholder="e.g. Part-time work" /></div><div className="form-field"><label>Amount per pay date</label><div className="input-prefix"><span>$</span><input name="amount" type="number" min="0" step="0.01" required placeholder="0.00" /></div></div><div className="form-field"><label>Frequency</label><select name="frequency"><option value="monthly">Monthly</option><option value="weekly">Weekly</option><option value="biweekly">Biweekly</option><option value="semimonthly">Twice a month</option><option value="monthly-weekday">Nth weekday monthly</option><option value="quarterly">Quarterly</option><option value="yearly">Yearly</option><option value="custom">Custom interval</option></select></div><div className="form-field"><label>First pay date / month</label><input name="startDate" type="date" required defaultValue={today()} /></div><div className="form-field"><label>Ordinal weekday</label><select name="weekOrdinal"><option value="2">Second</option><option value="1">First</option><option value="3">Third</option><option value="4">Fourth</option><option value="-1">Last</option></select></div><div className="form-field"><label>Weekday</label><select name="weekday"><option value="5">Friday</option><option value="1">Monday</option><option value="2">Tuesday</option><option value="3">Wednesday</option><option value="4">Thursday</option><option value="6">Saturday</option><option value="0">Sunday</option></select></div><div className="form-field"><label>Second day (twice a month)</label><input name="secondDay" type="number" min="1" max="31" defaultValue="15" /></div><div className="form-field"><label>Custom interval (days)</label><input name="intervalDays" type="number" min="1" defaultValue="30" /></div><div className="form-actions"><button className="button secondary" type="button" onClick={() => setModal(null)}>Done</button><button className="button primary"><Plus size={14} />Add source</button></div></form></div>}
      {modal === 'plan' && <div className="draft-content"><div className="ai-explainer"><span><Sparkles size={17} /></span><p>Each suggestion uses actual spending assigned to this envelope in the three completed months before {state.month}, including months with no spending. Actuals are historical records; suggested amounts are a separate draft rounded to the nearest $10. Edit any draft value. You can apply one category, apply all, or ignore the draft.</p></div><div className="draft-table"><div className="draft-header"><span>ENVELOPE</span><span>3-MO ACTUAL AVG.</span><span>CURRENT PLAN</span><span>DRAFT PLAN</span></div>{draftPlan(state).map(row => { const category = state.categories.find(c => c.id === row.categoryId)!; return <div className="draft-row" key={row.categoryId}><span><i style={{ background: category.color }} />{category.name}</span><small>{money(row.average)}<em> / month</em></small><small>{money(row.current)}</small><label className="input-prefix draft-input"><span>$</span><input aria-label={`${category.name} draft amount`} type="number" min="0" step="10" value={planDraft[row.categoryId] ?? row.suggested} onChange={e => setPlanDraft(current => ({ ...current, [row.categoryId]: Number(e.target.value) }))} /></label><div className="draft-reason-row"><small>{row.reason}</small><button type="button" className="rule-save" onClick={() => applyDraftCategory(row.categoryId)}>Apply category</button></div></div>})}</div><p className="draft-footnote"><ShieldCheck size={14} />Nothing changes until you apply a category or all draft amounts. Ignore closes this draft without changing your plan.</p><div className="form-actions"><button type="button" className="button secondary" onClick={() => setModal(null)}>Ignore suggestions</button><button type="button" className="button primary" onClick={applyDraft}><Check size={15} />Apply all suggestions</button></div></div>}
    </Modal>}
    {notice && <div className="toast"><span><Check size={15} /></span>{notice}<button onClick={() => setNotice('')} aria-label="Dismiss"><X size={15} /></button></div>}
  </div>
}

function StatCard({ label, value, helper, icon, tone, progress }: { label: string; value: string; helper: string; icon: ReactNode; tone: string; progress?: number }) { return <div className={`stat-card shadow-card transition-shadow hover:shadow-md tone-${tone}`}><div className="stat-head"><span>{label}</span><i>{icon}</i></div><b>{value}</b><small>{helper}</small>{progress !== undefined && <div className="stat-progress"><span style={{ width: `${progress}%` }} /></div>}</div> }
function CashFlowForecast({ configured, currentBalance, events, endingBalance, onSetBalance, onMoveFunds, onReview }: { configured: boolean; currentBalance: number; events: CashFlowEvent[]; endingBalance: number; onSetBalance: () => void; onMoveFunds: () => void; onReview: (kind: 'bills' | 'spending') => void }) {
  const warnings = events.filter(event => event.warning)
  return <section className="panel shadow-card cash-flow-panel">
    <div className="panel-heading"><div><span className="section-kicker">DATED CASH FLOW ESTIMATE · NEXT 45 DAYS</span><h2>Will the timing work?</h2></div><button className="button secondary small-button" onClick={onSetBalance}>{configured ? 'Update current balance' : 'Set current balance'}</button></div>
    {!configured ? <div className="forecast-empty"><p>Enter your current account balance to see when scheduled income and bills may create a shortfall.</p></div> : <>
      <div className="forecast-balance-row"><span>Starting balance today <b>{money(currentBalance)}</b></span><span>Projected after timeline <b className={endingBalance < 0 ? 'negative' : ''}>{money(endingBalance)}</b></span></div>
      {(currentBalance < 0 || warnings.length > 0) && <div className="forecast-warnings">{currentBalance < 0 && <div className="risk-insight"><p><CircleHelp size={14} /><span>{new Date(`${today()}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}: starting balance is already {money(Math.abs(currentBalance))} below zero.</span></p><small>Review upcoming bills and flexible spending, or move funds between envelopes.</small><div className="insight-actions"><button type="button" onClick={onMoveFunds}>Move funds</button><button type="button" onClick={() => onReview('spending')}>Review spending</button></div></div>}{warnings.map((event, index) => <div className="risk-insight" key={`${event.date}:${event.label}:${index}`}><p><CircleHelp size={14} /><span>{new Date(`${event.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}: {event.warning}</span></p><small>{event.kind === 'bill' ? 'Consider moving funds or reviewing flexible spending before this bill is due.' : event.kind === 'transaction' ? 'Consider delaying discretionary spending until the balance recovers.' : 'Review your planned spending and available envelope funds.'}</small><div className="insight-actions"><button type="button" onClick={onMoveFunds}>Move funds</button><button type="button" onClick={() => onReview(event.kind === 'bill' ? 'bills' : 'spending')}>{event.kind === 'bill' ? 'Review bills' : 'Review spending'}</button></div></div>)}</div>}
      <div className="cash-flow-events">{events.length ? events.map((event, index) => <div className={`cash-flow-event ${event.warning ? 'at-risk' : ''}`} key={`${event.date}:${event.label}:${index}`}><time>{new Date(`${event.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</time><span className={`flow-dot ${event.kind}`} /><span className="flow-label"><b>{event.label}</b><small>{event.kind === 'income' ? 'Expected income' : event.kind === 'bill' ? 'Scheduled bill · unpaid' : event.kind === 'transaction' ? 'Recorded future expense' : event.kind === 'reimbursement' ? 'Recorded reimbursement receipt' : 'Estimate · remaining envelope plan'}</small></span><span className={`flow-amount ${event.amount < 0 ? 'outflow' : ''}`}>{event.amount > 0 ? '+' : '-'}{money(Math.abs(event.amount))}</span><span className="flow-balance">{money(event.balanceAfter)}</span></div>) : <p className="forecast-empty">No dated income, bills, or recorded future activity in the next 45 days.</p>}</div>
      <p className="forecast-assumption">The opening balance is your account balance through today, so transactions dated today or earlier are already included. Later dated transactions, scheduled unpaid bills, and recorded reimbursement receipts appear on their dates. Remaining envelope amounts are shown as estimates at each month end; they subtract recorded spending and scheduled bills so those costs are not counted twice. Expected income is not a confirmed deposit.</p>
    </>}
  </section>
}
function InsightsPanel({ anomalies, categories, onMoveFunds, onReviewActivity, onAdjustPlan }: { anomalies: ReturnType<typeof spendingAnomalies>; categories: Category[]; onMoveFunds: () => void; onReviewActivity: () => void; onAdjustPlan: (categoryId: string) => void }) {
  if (!anomalies.length) return null
  return <section className="panel shadow-card insights-panel"><div className="panel-heading"><div><span className="section-kicker">INSIGHTS & OPTIONS</span><h2>Spending to take a closer look at</h2></div></div>{anomalies.map(anomaly => { const category = categories.find(item => item.id === anomaly.categoryId); if (!category) return null; return <article className="spending-insight" key={anomaly.categoryId}><div className="insight-indicator"><CircleHelp size={16} /></div><div className="spending-insight-copy"><b>{category.name} spending is {anomaly.ratio.toFixed(1)}× its three-month average</b><p>{money(anomaly.actual)} so far this month, compared with a typical {money(anomaly.baseline)} by this point in the month. Consider moving funds, adjusting the plan, or delaying optional purchases.</p><div className="insight-actions"><button type="button" onClick={onMoveFunds}>Move funds</button><button type="button" onClick={() => onAdjustPlan(category.id)}>Adjust plan</button><button type="button" onClick={onReviewActivity}>Review purchases</button></div></div></article> })}<p className="insight-disclaimer">These are suggestions only. No money or plan changes unless you make and save them.</p></section>
}
function EnvelopeRow({ category, transactions, month, moves, adjustments, onClick }: { category: Category; transactions: Transaction[]; month: string; moves: AppState['moves']; adjustments: NonNullable<AppState['adjustments']>; onClick: () => void }) { return <button className="envelope-row" onClick={onClick}><span className="category-icon" style={{ color: category.color, background: `${category.color}16` }}>{iconFor(category.icon, 17)}</span><span className="envelope-main"><b>{category.name}</b><span className="mini-track"><i style={{ width: `${progressFor(category, transactions, month, moves, adjustments)}%`, background: category.color }} /></span></span><span className="envelope-amount"><b>{money(Math.max(0, availableFor(category, transactions, month, moves, adjustments)))}</b><small>of {money(plannedAmount(category, month))}</small></span></button> }
function CategoryCard({ category, transactions, month, moves, adjustments, onEdit }: { category: Category; transactions: Transaction[]; month: string; moves: AppState['moves']; adjustments: NonNullable<AppState['adjustments']>; onEdit: () => void }) { const spent = categorySpend(category.id, transactions.filter(tx => tx.date.startsWith(month))); const left = availableFor(category, transactions, month, moves, adjustments); const policy = budgetPeriod(category, month); return <div className="category-card"><div className="category-card-top"><span className="category-icon large" style={{ color: category.color, background: `${category.color}17` }}>{iconFor(category.icon, 19)}</span><button className="dots-button" aria-label={`Edit ${category.name}`} onClick={onEdit}><MoreHorizontal size={18} /></button></div><div className="category-name">{category.name}</div><div className="category-left"><b>{money(Math.max(0, left))}</b><small>left to spend</small></div><div className="category-track"><i style={{ width: `${progressFor(category, transactions, month, moves, adjustments)}%`, background: category.color }} /></div><div className="category-foot"><span>{money(spent)} spent</span><span>of {money(plannedAmount(category, month))}</span></div><div className="rollover-note">{policy.rollover === 'carry' ? 'Carries forward' : policy.rollover === 'reset' ? 'Resets next month' : `Carries up to ${money(policy.cap ?? policy.planned)}`}</div></div> }
function UpcomingRow({ item, category, availableAfter }: { item: Recurring; category?: Category; availableAfter?: number }) { const date = new Date(`${item.nextDate}T12:00:00`); const due = Math.round((date.getTime() - new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00`).getTime()) / 86400000); return <div className="upcoming-row"><span className="due-date"><b>{date.toLocaleDateString('en-US', { day: '2-digit' })}</b><small>{date.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()}</small></span><span className="upcoming-copy"><b>{item.name}</b><small>{category?.name ?? 'Uncategorized'} · {due < 0 ? 'Past due' : due === 0 ? 'Due today' : `In ${due} days`}{availableAfter !== undefined ? ` · ${money(availableAfter)} after payment` : ''}</small></span><b className="upcoming-amount">{money(item.amount)}</b></div> }
function TransactionTable({ transactions, categories, onEdit, onReimbursement, emptyText, selectable = false, selectedIds, onToggleSelection, onToggleVisible }: { transactions: Transaction[]; categories: Category[]; onEdit: (tx: Transaction) => void; onReimbursement: (tx: Transaction) => void; emptyText?: string; selectable?: boolean; selectedIds?: Set<string>; onToggleSelection?: (id: string) => void; onToggleVisible?: () => void }) {
  if (!transactions.length) return <div className="table-empty"><div><Search size={18} /></div><b>{emptyText ?? 'Your activity will find its way here.'}</b><p>Try adding your first transaction to give your plan a little shape.</p></div>
  const allSelected = selectable && transactions.every(tx => selectedIds?.has(tx.id))
  return <div className="table-scroll"><table className="transaction-table"><thead><tr>{selectable && <th className="select-cell"><input type="checkbox" aria-label="Select all visible transactions" checked={!!allSelected} onChange={onToggleVisible} /></th>}<th>MERCHANT</th><th>ENVELOPE</th><th>DATE</th><th>STATUS</th><th className="right">GROSS</th><th className="right">RECEIVED</th><th className="right">NET</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{transactions.map(tx => {
    const category = categories.find(c => c.id === tx.categoryId); const reimbursed = reimbursementReceived(tx); const outstanding = reimbursementOutstanding(tx); const complete = reimbursementState(tx) === 'received'
    const categoryNames = tx.splits?.length ? [...new Set(tx.splits.map(split => categories.find(c => c.id === split.categoryId)?.name ?? 'Uncategorized'))].join(' + ') : category?.name ?? 'Uncategorized'
    return <tr key={tx.id}>{selectable && <td className="select-cell"><input type="checkbox" aria-label={`Select ${tx.merchant}`} checked={!!selectedIds?.has(tx.id)} onChange={() => onToggleSelection?.(tx.id)} /></td>}<td><button className="merchant-cell" onClick={() => onEdit(tx)}><span className="merchant-icon" style={{ color: category?.color ?? '#758b68', background: `${category?.color ?? '#758b68'}17` }}>{iconFor(category?.icon ?? 'tag', 16)}</span><span><b>{tx.merchant}</b><small>{tx.description || tx.notes || tx.account || 'Everyday purchase'}{tx.splits?.length ? ` · ${tx.splits.length} lines` : ''}</small></span></button></td><td><span className="category-chip"><i style={{ background: category?.color ?? '#9a9c8a' }} />{categoryNames}</span></td><td className="date-cell">{new Date(`${tx.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td><td>{tx.reimbursable ? <button className={`reimburse-status ${complete ? 'received' : ''}`} onClick={() => onReimbursement(tx)} title="Record or view reimbursement receipts"><span />{complete ? `Received ${money(reimbursed)}` : reimbursed > 0 ? `${money(reimbursed)} received · ${money(outstanding)} due` : `${money(outstanding)} pending`}</button> : <span className="status-cleared"><BadgeCheck size={13} />Posted</span>}</td><td className="amount-cell">{money(tx.amount)}</td><td className="amount-cell">{money(reimbursed)}</td><td className="amount-cell">{money(tx.amount - reimbursed)}</td><td><button className="dots-button row-dots" aria-label={`Edit ${tx.merchant}`} onClick={() => onEdit(tx)}><MoreHorizontal size={17} /></button></td></tr>
  })}</tbody></table></div>
}
function UpcomingFull({ item, category, availableAfter, funding, onToggle, onPost, onEdit, onDelete, posting }: { item: Recurring; category?: Category; availableAfter?: number; funding: ReturnType<typeof sinkingFundSummary>; onToggle: () => void; onPost: () => void; onEdit: () => void; onDelete: () => void; posting: boolean }) { const date = new Date(`${item.nextDate}T12:00:00`); return <div className={`upcoming-full ${item.active ? '' : 'paused'}`}><span className="due-date large-date"><b>{date.toLocaleDateString('en-US', { day: '2-digit' })}</b><small>{date.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()}</small></span><div className="recurring-icon" style={{ color: category?.color, background: `${category?.color ?? '#aaa'}18` }}>{item.kind === 'bill' ? <FileClock size={18} /> : item.kind === 'sinking' ? <Leaf size={18} /> : <CreditCard size={18} />}</div><div className="upcoming-full-copy"><b>{item.name}</b><small>{item.cadence[0].toUpperCase() + item.cadence.slice(1)} · {item.kind} · {category?.name ?? 'Uncategorized'}{item.active ? '' : ' · Paused'}{availableAfter !== undefined ? ` · ${money(availableAfter)} after payment` : ''}</small></div>{funding && <div className="sinking-progress"><div><small>FUNDED TOWARD {money(funding.goal)}</small><b>{money(funding.funded)} saved · {money(funding.contribution)}/month planned</b><small>{funding.monthsUntilDue > 0 ? `${funding.monthsUntilDue} months until due · ${money(funding.monthlyNeeded)}/month needed${funding.onTrack ? '' : ' · behind plan'}` : `${money(funding.monthlyNeeded)} still needed for the upcoming bill`}</small>{funding.monthsRemaining !== null && <small>At this plan: funded in about {funding.monthsRemaining} months</small>}</div><span><i style={{ width: `${funding.progress}%`, background: category?.color }} /></span></div>}<b className="upcoming-full-amount">{money(item.amount)}</b><button className="button soft small-button" disabled={!item.active || posting} onClick={onPost}>{posting ? 'Posting…' : <><Check size={14} />Mark paid & post</>}</button><button className="text-button" onClick={onEdit}>Edit</button><button className="text-button" onClick={onDelete}>Delete</button><button className="text-button" onClick={onToggle}>{item.active ? 'Pause' : 'Resume'}</button></div> }
function Donut({ spent, budgeted }: { spent: number; budgeted: number }) { const pct = budgeted ? Math.min(spent / budgeted, 1) : 0; return <div className="donut" style={{ background: `conic-gradient(#b77f62 ${pct * 360}deg, #dce5d8 0deg)` }}><div /></div> }
function Modal({ children, title, subtitle, onClose }: { children: ReactNode; title: string; subtitle: string; onClose: () => void }) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return <div className="modal-backdrop fixed inset-0 z-[60] grid place-items-center overflow-y-auto bg-ink/40 p-3 backdrop-blur-sm sm:p-6" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="modal-card relative my-auto max-h-[calc(100dvh-1.5rem)] w-full max-w-xl overflow-y-auto rounded-2xl border border-sage-200 bg-white p-5 shadow-dialog sm:max-h-[calc(100dvh-3rem)] sm:p-7 has-[.draft-content]:!max-w-5xl has-[.draft-content]:!w-full has-[.income-manager]:!max-w-3xl" role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-subtitle" tabIndex={-1}>
      <div className="modal-top mb-5 flex items-center justify-between">
        <span className="modal-mark grid h-10 w-10 place-items-center rounded-xl bg-sage-100 text-moss"><Leaf size={19} /></span>
        <button className="modal-close grid h-9 w-9 place-items-center rounded-lg border border-sage-200 text-muted transition hover:bg-sage-50 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-moss" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <h2 id="dialog-title" className="mb-1.5 font-display text-2xl font-semibold leading-tight tracking-tight text-ink">{title}</h2>
      <p id="dialog-subtitle" className="modal-subtitle mb-5 text-sm leading-relaxed text-muted">{subtitle}</p>
      {children}
    </div>
  </div>
}
function RecurringItemForm({ item, categories, month, onSubmit, onCancel }: { item: Recurring | null; categories: Category[]; month: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onCancel: () => void }) {
  return <form className="form-grid" onSubmit={onSubmit}>
    <div className="form-field full"><label>Name</label><input autoFocus name="name" required defaultValue={item?.name ?? ''} placeholder="e.g. Water bill" /></div>
    <div className="form-field"><label>Usual amount</label><div className="input-prefix"><span>$</span><input type="number" min="0.01" step="0.01" name="amount" required defaultValue={item?.amount ?? ''} placeholder="0.00" /></div></div>
    <div className="form-field"><label>First due date / next occurrence</label><input type="date" name="nextDate" required defaultValue={item?.nextDate ?? `${month}-21`} /></div>
    <div className="form-field"><label>Envelope</label><select name="categoryId" required defaultValue={item?.categoryId ?? categories[0]?.id}>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></div>
    <div className="form-field"><label>How often</label><select name="cadence" defaultValue={item?.cadence ?? 'monthly'}><option value="weekly">Weekly</option><option value="biweekly">Biweekly</option><option value="semimonthly">Twice a month</option><option value="monthly">Monthly</option><option value="monthly-weekday">Nth weekday monthly</option><option value="quarterly">Quarterly</option><option value="yearly">Yearly</option><option value="custom">Custom interval</option></select></div>
    <div className="form-field"><label>Ordinal weekday</label><select name="weekOrdinal" defaultValue={item?.weekOrdinal ?? 2}><option value={2}>Second</option><option value={1}>First</option><option value={3}>Third</option><option value={4}>Fourth</option><option value={-1}>Last</option></select></div>
    <div className="form-field"><label>Weekday</label><select name="weekday" defaultValue={item?.weekday ?? 5}><option value={5}>Friday</option><option value={1}>Monday</option><option value={2}>Tuesday</option><option value={3}>Wednesday</option><option value={4}>Thursday</option><option value={6}>Saturday</option><option value={0}>Sunday</option></select></div>
    <div className="form-field"><label>Second day (twice a month)</label><input type="number" name="secondDay" min="1" max="31" defaultValue={item?.secondDay ?? 15} /></div>
    <div className="form-field"><label>Custom interval (days)</label><input type="number" name="intervalDays" min="1" defaultValue={item?.intervalDays ?? 30} /></div>
    <div className="form-field full"><label>What kind of item?</label><select name="kind" defaultValue={item?.kind ?? 'bill'}><option value="bill">Bill</option><option value="subscription">Subscription</option><option value="sinking">Sinking fund / annual expense</option></select></div>
    <div className="form-actions"><button className="button secondary" type="button" onClick={onCancel}>Cancel</button><button className="button primary"><Check size={15} />{item ? 'Save schedule' : 'Keep an eye on it'}</button></div>
  </form>
}
function SplitLinesEditor({ categories, transaction, suggested }: { categories: Category[]; transaction: Transaction | null; suggested?: { categoryId: string; amount: number }[] | null }) {
  const [rows, setRows] = useState(() => suggested?.length ? suggested.map(split => ({ key: uid(), categoryId: split.categoryId, amount: String(split.amount) })) : transaction?.splits?.length ? transaction.splits.map(split => ({ key: uid(), categoryId: split.categoryId, amount: String(split.amount) })) : [{ key: uid(), categoryId: transaction?.categoryId ?? categories[0]?.id ?? '', amount: '' }])
  return <div className="form-field full split-editor"><div className="split-editor-heading"><label>Envelope split</label><button type="button" className="rule-save" onClick={() => setRows(current => [...current, { key: uid(), categoryId: categories.find(category => category.id !== current[0]?.categoryId)?.id ?? categories[0]?.id ?? '', amount: '' }])}><Plus size={12} /> Add split line</button></div><p>One line uses the full amount. With multiple lines, the first envelope gets the remainder after the other lines.</p><div className="split-lines">{rows.map((row, index) => <div className="split-line" key={row.key}><select name="splitCategory" aria-label={`Envelope for split line ${index + 1}`} value={row.categoryId} onChange={event => setRows(current => current.map(line => line.key === row.key ? { ...line, categoryId: event.target.value } : line))}>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select>{index === 0 ? <span className="split-remainder">{rows.length === 1 ? 'Full transaction amount' : 'Remaining amount'}</span> : <div className="input-prefix split-amount"><span>$</span><input name="splitAmount" type="number" min="0.01" step="0.01" required value={row.amount} onChange={event => setRows(current => current.map(line => line.key === row.key ? { ...line, amount: event.target.value } : line))} placeholder="0.00" aria-label={`Amount for split line ${index + 1}`} /><button type="button" className="split-remove" aria-label={`Remove split line ${index + 1}`} onClick={() => setRows(current => current.filter(line => line.key !== row.key))}><X size={14} /></button></div>}</div>)}</div></div>
}

function TransactionAssist({ state, onSplitAccept, onReimbursementAccept }: { state: AppState; onSplitAccept: (rows: { categoryId: string; amount: number }[]) => void; onReimbursementAccept: (amount: number) => void }) {
  const [details, setDetails] = useState({ merchant: '', text: '', amount: 0 })
  const [dismissed, setDismissed] = useState(false)
  const [accepted, setAccepted] = useState(false)
  useEffect(() => {
    const form = document.querySelector<HTMLFormElement>('.modal-card form')
    if (!form) return
    const refresh = () => {
      const data = new FormData(form)
      setDetails({ merchant: String(data.get('merchant') ?? ''), text: `${data.get('description') ?? ''} ${data.get('notes') ?? ''}`, amount: Number(data.get('amount') ?? 0) })
      setDismissed(false); setAccepted(false)
    }
    form.addEventListener('input', refresh); refresh()
    return () => form.removeEventListener('input', refresh)
  }, [])
  const split = splitSuggestionFor({ merchant: details.merchant, description: details.text, amount: details.amount }, state)
  const reimbursement = reimbursableSuggestionFor({ merchant: details.merchant, description: details.text })
  if (dismissed || (!split && !reimbursement)) return null
  return <div className="suggestion-box assist-box"><div className="suggestion-heading"><span><Sparkles size={15} /></span><b>Helpful patterns</b><small>REVIEW FIRST</small></div>
    {split && <div className="assist-card"><div className="suggestion-text"><b>Possible split · {split.confidence} confidence</b><small>{split.reason} Review the suggested amounts, then edit any line in the split editor before saving.</small></div><div className="assist-actions"><button type="button" className="button soft small-button" disabled={accepted} onClick={() => { onSplitAccept(split.rows); setAccepted(true) }}>{accepted ? 'Added to form' : 'Review split'}</button><button type="button" className="rule-save" onClick={() => setDismissed(true)}>Dismiss</button></div>{!dismissed && <small className="assist-lines">{split.rows.map(row => `${state.categories.find(category => category.id === row.categoryId)?.name ?? 'Unknown envelope'} ${money(row.amount)}`).join(' · ')}</small>}</div>}
    {reimbursement && <div className="assist-card"><div className="suggestion-text"><b>This may be reimbursable · {reimbursement.confidence} confidence</b><small>{reimbursement.reason} If someone owes you for this expense, review the expected amount before saving.</small></div><div className="assist-actions"><button type="button" className="button soft small-button" disabled={!Number.isFinite(details.amount) || details.amount <= 0} onClick={() => onReimbursementAccept(details.amount)}>Suggest reimbursement</button><button type="button" className="rule-save" onClick={() => setDismissed(true)}>Dismiss</button></div></div>}
  </div>
}
function SuggestionPreview({ state, onAccept, onSaveRule }: { state: AppState; onAccept: (id: string) => void; onSaveRule: (rule: AppState['rules'][number]) => void }) {
  const [details, setDetails] = useState({ merchant: '', description: '', notes: '', amount: 0 })
  const [chosen, setChosen] = useState(false); const [saved, setSaved] = useState(false); const [rejected, setRejected] = useState(false)
  const suggestion = (details.merchant || details.description || details.notes) ? suggestionFor(details, state) : null
  const category = suggestion && state.categories.find(item => item.id === suggestion.categoryId)
  const rulePhrase = (details.merchant.trim() || details.description.trim() || details.notes.trim()).slice(0, 100)
  return <div className="suggestion-box"><div className="suggestion-heading"><span><Sparkles size={15} /></span><b>A little help with categories</b><small>OPTIONAL</small></div><p>As you type, we’ll use the merchant, description, notes, amount, saved rules, and your history. You can accept the suggestion or choose any envelope yourself.</p>
    <SuggestObserve onChange={next => { setDetails(next); setChosen(false); setSaved(false); setRejected(false) }} />
    {suggestion && category && !rejected && <div className="suggestion-result"><span className="category-icon mini" style={{ color: category.color, background: `${category.color}17` }}>{iconFor(category.icon, 14)}</span><span className="suggestion-text"><b>Suggested: {category.name}</b><small>{suggestion.confidence} confidence · {suggestion.reason}</small></span><button type="button" className="button soft small-button" onClick={() => { onAccept(category.id); setChosen(true) }}>{chosen ? <><Check size={13} />Added</> : <>Accept <ArrowRight size={13} /></>}</button><button type="button" className="rule-save" disabled={saved || !rulePhrase} onClick={() => { onSaveRule({ id: uid(), contains: rulePhrase, categoryId: category.id }); setSaved(true) }}>{saved ? 'Rule saved' : 'Save as rule'}</button><button type="button" className="rule-save" onClick={() => { setRejected(true); setChosen(false) }}>Dismiss</button></div>}
    {suggestion && !category && <p className="suggestion-rejected">The suggested envelope no longer exists. Choose an envelope manually.</p>}{rejected && <p className="suggestion-rejected">Suggestion dismissed. Choose the right envelope from the list above.</p>}
  </div>
}
function SuggestObserve({ onChange }: { onChange: (details: { merchant: string; description: string; notes: string; amount: number }) => void }) { useEffect(() => { const form = document.querySelector<HTMLFormElement>('.modal-card form'); if (!form) return; const refresh = () => { const data = new FormData(form); onChange({ merchant: String(data.get('merchant') ?? ''), description: String(data.get('description') ?? ''), notes: String(data.get('notes') ?? ''), amount: Number(data.get('amount') ?? 0) }) }; form.addEventListener('input', refresh); refresh(); return () => form.removeEventListener('input', refresh) }, []); return null }
function ReimbursementField({ checked, expected, suggestion }: { checked: boolean; expected: number; suggestion: { token: number; amount: number } | null }) { const [enabled, setEnabled] = useState(checked); const [amount, setAmount] = useState(expected ? String(expected) : ''); useEffect(() => { if (suggestion) { setEnabled(true); setAmount(suggestion.amount.toFixed(2)) } }, [suggestion?.token]); return <><div className="form-field full"><label className="check-field"><input type="checkbox" name="reimbursable" checked={enabled} onChange={e => setEnabled(e.target.checked)} /><span className="fake-check"><Check size={12} /></span><span><b>Someone will pay me back</b><small>Set the expected amount here; record each partial payment as it arrives.</small></span></label></div>{enabled && <div className="form-field full"><label>Reimbursement expected</label><div className="input-prefix"><span>$</span><input name="reimbursementAmount" type="number" min="0.01" step="0.01" required value={amount} onChange={event => setAmount(event.target.value)} placeholder="0.00" /></div></div>}</> }
