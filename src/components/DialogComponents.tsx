import { useEffect, type FormEvent, type ReactNode } from 'react'
import { Check, Leaf, X } from 'lucide-react'
import type { Category, Recurring } from '../types'

export function Modal({ children, title, subtitle, onClose }: { children: ReactNode; title: string; subtitle: string; onClose: () => void }) {
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
export function RecurringItemForm({ item, categories, month, onSubmit, onCancel }: { item: Recurring | null; categories: Category[]; month: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onCancel: () => void }) {
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
