import { ArrowDownLeft, ArrowRight, CircleHelp, Command, Plus, Sparkles } from 'lucide-react'
import { money } from '../calculations'
import type { AppState, Category } from '../types'
import { CategoryCard, Donut } from '../components/DashboardComponents'

type Props = {
  state: AppState
  income: number
  budgeted: number
  unallocated: number
  spent: number
  totalAvailable: number
  onDuplicateBudget: () => void
  onAddCategory: () => void
  onOpenIncome: () => void
  onMoveFunds: () => void
  onSuggestPlan: () => void
  onEditCategory: (category: Category) => void
}

export function PlanScreen({ state, income, budgeted, unallocated, spent, totalAvailable, onDuplicateBudget, onAddCategory, onOpenIncome, onMoveFunds, onSuggestPlan, onEditCategory }: Props) {
  return <>
    <div className="welcome-row page-title-row"><div><div className="eyebrow"><span className="sun-mark"><Sparkles size={13} /></span> YOUR MONTHLY PLAN</div><h1>A plan with <em>room to breathe.</em></h1><p className="page-subtitle">Every dollar gets a little place to belong.</p></div><div className="button-cluster"><button className="button secondary" title="Create a separate next-month budget with envelope rollover settings carried forward" onClick={onDuplicateBudget}><Command size={15} />Duplicate budget to next month</button><button className="button primary" onClick={onAddCategory}><Plus size={16} />New envelope</button></div></div>
    <div className="plan-summary"><div><small>MONTHLY INCOME</small><b>{money(income)}</b></div><div><small>GIVEN A JOB</small><b>{money(budgeted)}</b></div><div><small>LEFT TO PLAN</small><b className={unallocated < 0 ? 'negative' : ''}>{money(unallocated)}</b></div><button className="button secondary" onClick={onOpenIncome}><ArrowDownLeft size={14} />Income sources</button><button className="button secondary" onClick={onMoveFunds}><ArrowRight size={14} />Move money</button><button className="button soft" onClick={onSuggestPlan}><Sparkles size={15} />Suggest a plan</button></div>
    {unallocated < 0 && <div className="alert-line"><CircleHelp size={16} />Your envelope plans are {money(Math.abs(unallocated))} above expected income this month. Review your plan before applying it.</div>}
    <div className="plan-layout"><section className="panel shadow-card envelope-panel"><div className="panel-heading"><div><span className="section-kicker">THE PLAN, ENVELOPE BY ENVELOPE</span><h2>Your envelopes <span className="count-pill">{state.categories.length}</span></h2></div><button className="text-link" onClick={onAddCategory}><Plus size={15} />Create one</button></div><div className="category-cards">{state.categories.map(category => <CategoryCard key={category.id} category={category} transactions={state.transactions} month={state.month} moves={state.moves} adjustments={state.adjustments ?? []} onEdit={() => onEditCategory(category)} />)}</div><div className="empty-spaces"><div className="empty-illustration"><Sparkles size={20} /></div><div><b>Give a new goal its own envelope</b><p>Trips, gifts, and annual bills make room for what matters.</p></div><button className="button secondary" onClick={onAddCategory}><Plus size={15} />Add envelope</button></div></section><aside className="plan-aside"><section className="panel shadow-card aside-card"><span className="section-kicker">HOW YOUR PLAN IS DOING</span><h2>Room to choose</h2><div className="donut-wrap"><Donut spent={spent} budgeted={budgeted} /><div className="donut-center"><b>{Math.max(0, Math.round(totalAvailable / Math.max(1, totalAvailable + spent) * 100))}%</b><small>AVAILABLE</small></div></div><div className="legend-row"><span><i className="legend-spent" />Spent so far</span><b>{money(spent)}</b></div><div className="legend-row"><span><i className="legend-plan" />Available in envelopes</span><b>{money(totalAvailable)}</b></div><p className="aside-hint">Available amounts include rollovers, transfers, and adjustments, less posted transactions.</p></section><section className="ai-mini"><Sparkles size={17} /><div><b>A thoughtful starting point</b><p>Use a few months of spending to draft your next plan. You choose what to keep.</p><button onClick={onSuggestPlan}>See suggestions <ArrowRight size={14} /></button></div></section></aside></div>
  </>
}
