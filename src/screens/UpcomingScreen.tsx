import { ArrowRight, CalendarDays, Plus, Sparkles } from 'lucide-react'
import { money, sinkingFundSummary } from '../calculations'
import type { AppState, Recurring } from '../types'
import { UpcomingFull } from '../components/DashboardComponents'

type Props = {
  state: AppState
  totalNext30Days: number
  availableAfterBill: (item: Recurring) => number | undefined
  postingIds: Set<string>
  onAdd: () => void
  onEdit: (item: Recurring) => void
  onDelete: (item: Recurring) => void
  onToggle: (item: Recurring) => void
  onPost: (item: Recurring) => void
  onViewPlan: () => void
}

export function UpcomingScreen({ state, totalNext30Days, availableAfterBill, postingIds, onAdd, onEdit, onDelete, onToggle, onPost, onViewPlan }: Props) {
  return <>
    <div className="welcome-row activity-title"><div><div className="eyebrow"><span className="sun-mark"><Sparkles size={13} /></span> FUTURE YOU SAYS THANKS</div><h1>Coming down <em>the road.</em></h1><p className="page-subtitle">Bills, little subscriptions, and the things you are setting aside for.</p></div><button className="button primary" onClick={onAdd}><Plus size={16} />Add recurring item</button></div>
    <div className="upcoming-summary"><div className="summary-icon"><CalendarDays size={18} /></div><div><small>SCHEDULED ITEMS</small><b>{state.recurring.length} recurring items</b></div><div className="upcoming-total"><small>NEXT 30 DAYS</small><b>{money(totalNext30Days)}</b></div></div>
    <section className="panel shadow-card activity-panel"><div className="panel-heading"><div><span className="section-kicker">YOUR RECURRING RHYTHM</span><h2>Scheduled items <span className="optional">not yet paid</span></h2></div><button className="text-link" onClick={onAdd}><Plus size={15} />Add an item</button></div>{state.recurring.slice().sort((a, b) => a.nextDate.localeCompare(b.nextDate)).map(item => { const category = state.categories.find(c => c.id === item.categoryId); return <UpcomingFull key={item.id} item={item} category={category} availableAfter={availableAfterBill(item)} funding={sinkingFundSummary(item, state)} posting={postingIds.has(item.id)} onEdit={() => onEdit(item)} onDelete={() => onDelete(item)} onToggle={() => onToggle(item)} onPost={() => onPost(item)} /> })}{state.recurring.length === 0 && <p className="forecast-empty">No scheduled items yet. Add a bill, subscription, or sinking fund.</p>}</section>
    <div className="forecast-note"><Sparkles size={17} /><div><b>Make room before it is due.</b><p>Recurring amounts are visible here so you can set aside a little at a time in the matching envelope.</p></div><button onClick={onViewPlan}>See the plan <ArrowRight size={14} /></button></div>
  </>
}
