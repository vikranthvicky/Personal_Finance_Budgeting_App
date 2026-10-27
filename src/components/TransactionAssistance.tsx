import { useEffect, useState } from 'react'
import { ArrowRight, Car, Check, HeartPulse, Home, Leaf, Plus, Sparkles, Tag, Utensils, UserRound, X } from 'lucide-react'
import { money, reimbursableSuggestionFor, splitSuggestionFor, suggestionFor } from '../calculations'
import type { AppState, Category, Transaction } from '../types'

const uid = () => crypto.randomUUID()
const iconFor = (key: string, size = 18) => {
  const props = { size, strokeWidth: 1.8 }
  if (key === 'home') return <Home {...props} />
  if (key === 'food') return <Utensils {...props} />
  if (key === 'transport') return <Car {...props} />
  if (key === 'health') return <HeartPulse {...props} />
  if (key === 'person') return <UserRound {...props} />
  if (key === 'spark') return <Sparkles {...props} />
  if (key === 'leaf') return <Leaf {...props} />
  return <Tag {...props} />
}

export function SplitLinesEditor({ categories, transaction, suggested }: { categories: Category[]; transaction: Transaction | null; suggested?: { categoryId: string; amount: number }[] | null }) {
  const [rows, setRows] = useState(() => suggested?.length ? suggested.map(split => ({ key: uid(), categoryId: split.categoryId, amount: String(split.amount) })) : transaction?.splits?.length ? transaction.splits.map(split => ({ key: uid(), categoryId: split.categoryId, amount: String(split.amount) })) : [{ key: uid(), categoryId: transaction?.categoryId ?? categories[0]?.id ?? '', amount: '' }])
  return <div className="form-field full split-editor"><div className="split-editor-heading"><label>Envelope split</label><button type="button" className="rule-save" onClick={() => setRows(current => [...current, { key: uid(), categoryId: categories.find(category => category.id !== current[0]?.categoryId)?.id ?? categories[0]?.id ?? '', amount: '' }])}><Plus size={12} /> Add split line</button></div><p>One line uses the full amount. With multiple lines, the first envelope gets the remainder after the other lines.</p><div className="split-lines">{rows.map((row, index) => <div className="split-line" key={row.key}><select name="splitCategory" aria-label={`Envelope for split line ${index + 1}`} value={row.categoryId} onChange={event => setRows(current => current.map(line => line.key === row.key ? { ...line, categoryId: event.target.value } : line))}><option value="">Uncategorized</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select>{index === 0 ? <span className="split-remainder">{rows.length === 1 ? 'Full transaction amount' : 'Remaining amount'}</span> : <div className="input-prefix split-amount"><span>$</span><input name="splitAmount" type="number" min="0.01" step="0.01" required value={row.amount} onChange={event => setRows(current => current.map(line => line.key === row.key ? { ...line, amount: event.target.value } : line))} placeholder="0.00" aria-label={`Amount for split line ${index + 1}`} /><button type="button" className="split-remove" aria-label={`Remove split line ${index + 1}`} onClick={() => setRows(current => current.filter(line => line.key !== row.key))}><X size={14} /></button></div>}</div>)}</div></div>
}

export function TransactionAssist({ state, onSplitAccept, onReimbursementAccept }: { state: AppState; onSplitAccept: (rows: { categoryId: string; amount: number }[]) => void; onReimbursementAccept: (amount: number) => void }) {
  const [details, setDetails] = useState({ merchant: '', text: '', amount: 0 })
  const [dismissed, setDismissed] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState('')
  const [aiSplit, setAiSplit] = useState<{ rows: { categoryId: string; amount: number }[]; reason: string; confidence: string } | null>(null)
  useEffect(() => {
    const form = document.querySelector<HTMLFormElement>('.modal-card form')
    if (!form) return
    const refresh = () => {
      const data = new FormData(form)
      setDetails({ merchant: String(data.get('merchant') ?? ''), text: `${data.get('description') ?? ''} ${data.get('notes') ?? ''}`, amount: Number(data.get('amount') ?? 0) })
      setDismissed(false); setAccepted(false)
      setAiSplit(null); setAiError('')
    }
    form.addEventListener('input', refresh); refresh()
    return () => form.removeEventListener('input', refresh)
  }, [])
  const split = splitSuggestionFor({ merchant: details.merchant, description: details.text, amount: details.amount }, state)
  const reimbursement = reimbursableSuggestionFor({ merchant: details.merchant, description: details.text })
  async function askAI() {
    setAiBusy(true); setAiError(''); setAiSplit(null)
    try {
      const response = await fetch('/api/ai/suggest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'split', input: { merchant: details.merchant, description: details.text, amount: details.amount, categories: state.categories.map(({ id, name }) => ({ id, name })) } }) })
      const data = await response.json(); if (!response.ok) throw new Error(data.error ?? 'AI suggestion unavailable.')
      const proposed = data.suggestion; const cents = Math.round(details.amount * 100)
      if (proposed.suggested && proposed.rows.every((row: {categoryId: string; amount: number}) => state.categories.some(category => category.id === row.categoryId)) && proposed.rows.reduce((sum: number, row: {amount: number}) => sum + Math.round(row.amount * 100), 0) === cents) setAiSplit(proposed)
      else setAiError(proposed.reason ?? 'AI did not find enough evidence for a split.')
    } catch (error) { setAiError(error instanceof Error ? error.message : 'AI suggestion unavailable.') }
    finally { setAiBusy(false) }
  }
  if (dismissed) return null
  return <div className="suggestion-box assist-box"><div className="suggestion-heading"><span><Sparkles size={15} /></span><b>Helpful patterns</b><small>REVIEW FIRST</small></div><button type="button" className="rule-save" disabled={aiBusy || details.amount <= 0} onClick={askAI}>{aiBusy ? 'Asking AI…' : 'Ask AI for a split suggestion'}</button>{aiError && <small className="suggestion-rejected">{aiError}</small>}
    {aiSplit && <div className="assist-card"><div className="suggestion-text"><b>AI split suggestion · {aiSplit.confidence} confidence</b><small>{aiSplit.reason} Review and edit before saving.</small></div><button type="button" className="button soft small-button" onClick={() => onSplitAccept(aiSplit.rows)}>Review split</button><small className="assist-lines">{aiSplit.rows.map(row => `${state.categories.find(category => category.id === row.categoryId)?.name} ${money(row.amount)}`).join(' · ')}</small></div>}
    {split && <div className="assist-card"><div className="suggestion-text"><b>Possible split · {split.confidence} confidence</b><small>{split.reason} Review the suggested amounts, then edit any line in the split editor before saving.</small></div><div className="assist-actions"><button type="button" className="button soft small-button" disabled={accepted} onClick={() => { onSplitAccept(split.rows); setAccepted(true) }}>{accepted ? 'Added to form' : 'Review split'}</button><button type="button" className="rule-save" onClick={() => setDismissed(true)}>Dismiss</button></div>{!dismissed && <small className="assist-lines">{split.rows.map(row => `${state.categories.find(category => category.id === row.categoryId)?.name ?? 'Unknown envelope'} ${money(row.amount)}`).join(' · ')}</small>}</div>}
    {reimbursement && <div className="assist-card"><div className="suggestion-text"><b>This may be reimbursable · {reimbursement.confidence} confidence</b><small>{reimbursement.reason} If someone owes you for this expense, review the expected amount before saving.</small></div><div className="assist-actions"><button type="button" className="button soft small-button" disabled={!Number.isFinite(details.amount) || details.amount <= 0} onClick={() => onReimbursementAccept(details.amount)}>Suggest reimbursement</button><button type="button" className="rule-save" onClick={() => setDismissed(true)}>Dismiss</button></div></div>}
  </div>
}
export function SuggestionPreview({ state, onAccept, onSaveRule }: { state: AppState; onAccept: (id: string) => void; onSaveRule: (rule: AppState['rules'][number]) => void }) {
  const [details, setDetails] = useState({ merchant: '', description: '', notes: '', amount: 0 })
  const [chosen, setChosen] = useState(false); const [saved, setSaved] = useState(false); const [rejected, setRejected] = useState(false)
  const [aiBusy, setAiBusy] = useState(false); const [aiError, setAiError] = useState(''); const [aiSuggestion, setAiSuggestion] = useState<{ categoryId: string; confidence: string; reason: string } | null>(null)
  const suggestion = (details.merchant || details.description || details.notes) ? suggestionFor(details, state) : null
  const category = suggestion && state.categories.find(item => item.id === suggestion.categoryId)
  const rulePhrase = (details.merchant.trim() || details.description.trim() || details.notes.trim()).slice(0, 100)
  async function askAI() {
    setAiBusy(true); setAiError(''); setAiSuggestion(null)
    try {
      const response = await fetch('/api/ai/suggest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'category', input: { merchant: details.merchant, description: details.description, notes: details.notes, amount: details.amount, categories: state.categories.map(({ id, name }) => ({ id, name })), history: state.transactions.slice(0, 15).map(tx => ({ merchant: tx.merchant, description: tx.description, amount: tx.amount, categoryId: tx.categoryId })) } }) })
      const data = await response.json(); if (!response.ok) throw new Error(data.error ?? 'AI suggestion unavailable.')
      if (!state.categories.some(item => item.id === data.suggestion.categoryId)) throw new Error('AI returned an unknown category. Choose an envelope manually.')
      setAiSuggestion(data.suggestion)
    } catch (error) { setAiError(error instanceof Error ? error.message : 'AI suggestion unavailable.') }
    finally { setAiBusy(false) }
  }
  return <div className="suggestion-box"><div className="suggestion-heading"><span><Sparkles size={15} /></span><b>A little help with categories</b><small>OPTIONAL</small></div><p>Local suggestions use saved rules and history. Ask the AI for a model generated category suggestion, then review it before applying.</p><button type="button" className="rule-save" disabled={aiBusy || !(details.merchant || details.description || details.notes)} onClick={askAI}>{aiBusy ? 'Asking AI' : 'Ask AI to categorize'}</button>{aiError && <p className="suggestion-rejected">{aiError}</p>}{aiSuggestion && <div className="suggestion-result"><span className="suggestion-text"><b>AI suggestion: {state.categories.find(item => item.id === aiSuggestion.categoryId)?.name}</b><small>{aiSuggestion.confidence} confidence: {aiSuggestion.reason}</small></span><button type="button" className="button soft small-button" onClick={() => onAccept(aiSuggestion.categoryId)}>Accept AI suggestion</button></div>}
    <SuggestObserve onChange={next => { setDetails(next); setChosen(false); setSaved(false); setRejected(false); setAiSuggestion(null); setAiError('') }} />
    {suggestion && category && !rejected && <div className="suggestion-result"><span className="category-icon mini" style={{ color: category.color, background: `${category.color}17` }}>{iconFor(category.icon, 14)}</span><span className="suggestion-text"><b>Suggested: {category.name}</b><small>{suggestion.confidence} confidence · {suggestion.reason}</small></span><button type="button" className="button soft small-button" onClick={() => { onAccept(category.id); setChosen(true) }}>{chosen ? <><Check size={13} />Added</> : <>Accept <ArrowRight size={13} /></>}</button><button type="button" className="rule-save" disabled={saved || !rulePhrase} onClick={() => { onSaveRule({ id: uid(), contains: rulePhrase, categoryId: category.id }); setSaved(true) }}>{saved ? 'Rule saved' : 'Save as rule'}</button><button type="button" className="rule-save" onClick={() => { setRejected(true); setChosen(false) }}>Dismiss</button></div>}
    {suggestion && !category && <p className="suggestion-rejected">The suggested envelope no longer exists. Choose an envelope manually.</p>}{rejected && <p className="suggestion-rejected">Suggestion dismissed. Choose the right envelope from the list above.</p>}
  </div>
}
export function SuggestObserve({ onChange }: { onChange: (details: { merchant: string; description: string; notes: string; amount: number }) => void }) { useEffect(() => { const form = document.querySelector<HTMLFormElement>('.modal-card form'); if (!form) return; const refresh = () => { const data = new FormData(form); onChange({ merchant: String(data.get('merchant') ?? ''), description: String(data.get('description') ?? ''), notes: String(data.get('notes') ?? ''), amount: Number(data.get('amount') ?? 0) }) }; form.addEventListener('input', refresh); refresh(); return () => form.removeEventListener('input', refresh) }, []); return null }
export function ReimbursementField({ checked, expected, suggestion }: { checked: boolean; expected: number; suggestion: { token: number; amount: number } | null }) { const [enabled, setEnabled] = useState(checked); const [amount, setAmount] = useState(expected ? String(expected) : ''); useEffect(() => { if (suggestion) { setEnabled(true); setAmount(suggestion.amount.toFixed(2)) } }, [suggestion?.token]); return <><div className="form-field full"><label className="check-field"><input type="checkbox" name="reimbursable" checked={enabled} onChange={e => setEnabled(e.target.checked)} /><span className="fake-check"><Check size={12} /></span><span><b>Someone will pay me back</b><small>Set the expected amount here; record each partial payment as it arrives.</small></span></label></div>{enabled && <div className="form-field full"><label>Reimbursement expected</label><div className="input-prefix"><span>$</span><input name="reimbursementAmount" type="number" min="0.01" step="0.01" required value={amount} onChange={event => setAmount(event.target.value)} placeholder="0.00" /></div></div>}</> }
