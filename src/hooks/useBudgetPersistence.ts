import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { useDispatch } from 'react-redux'
import { replaceState } from '../store'
import type { AppState } from '../types'

type SyncStatus = 'connecting' | 'online' | 'offline'

export function useBudgetPersistence(state: AppState, budgetId: string | null, setBudgetId: Dispatch<SetStateAction<string | null>>, setStatus: Dispatch<SetStateAction<SyncStatus>>, setNotice: Dispatch<SetStateAction<string>>) {
  const dispatch = useDispatch()
  const [budgets, setBudgets] = useState<{ id: string; name: string }[]>([])
  const [loadError, setLoadError] = useState(false)
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
    setLoadError(false)
    fetch('/api/budgets').then(response => { if (!response.ok) throw new Error('API unavailable'); return response.json() as Promise<{ id: string; name: string }[]> }).then(items => {
      if (!active) return
      setBudgets(items)
      const remembered = localStorage.getItem('pocketplan.activeBudget')
      const selected = items.some(item => item.id === remembered) ? remembered! : items[0]?.id ?? 'default'
      activeBudgetRef.current = selected
      setBudgetId(selected)
    }).catch(() => { if (active) { setStatus('offline'); setLoadError(true); loaded.current = true } })
    return () => { active = false }
  }, [dispatch])
  useEffect(() => {
    if (!budgetId) return
    let active = true
    loaded.current = false
    setStatus('connecting')
    setLoadError(false)
    fetch(`/api/state?budgetId=${encodeURIComponent(budgetId)}`).then(response => { if (!response.ok) throw new Error('API unavailable'); return response.json() }).then((data: AppState & { revision?: number }) => { if (active && activeBudgetRef.current === budgetId) { if (data.revision !== undefined) revisionsByBudgetRef.current.set(budgetId, data.revision); generationsByBudgetRef.current.set(budgetId, (generationsByBudgetRef.current.get(budgetId) ?? 0) + 1); revisionRef.current = data.revision ?? null; stateRef.current = data; dispatch(replaceState(data)); localStorage.setItem('pocketplan.activeBudget', budgetId); setStatus('online'); setLoadError(false); loaded.current = true } }).catch(() => { if (active && activeBudgetRef.current === budgetId) { setStatus('offline'); setLoadError(true); loaded.current = true } })
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
        const result = await response.json() as { revision: number; audit?: AppState['audit'] }; revisionsByBudgetRef.current.set(saveBudgetId, result.revision)
        if (activeBudgetRef.current === saveBudgetId) {
          revisionRef.current = result.revision; setStatus('online')
          if (result.audit && JSON.stringify(stateRef.current.audit) !== JSON.stringify(result.audit)) { const latest = { ...stateRef.current, audit: result.audit }; stateRef.current = latest; dispatch(replaceState(latest)) }
        }
      }).catch(() => { if (activeBudgetRef.current === saveBudgetId) setStatus('offline') })
    }, 350)
    return () => window.clearTimeout(timer)
  }, [state, budgetId])
  return { budgets, setBudgets, loaded, loadError, stateRef, revisionRef, activeBudgetRef, revisionsByBudgetRef, generationsByBudgetRef, blockedSaveBudgetsRef }
}
