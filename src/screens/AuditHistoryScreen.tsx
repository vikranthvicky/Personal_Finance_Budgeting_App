import { FileClock } from 'lucide-react'
import type { AuditItem } from '../types'

export function AuditHistoryScreen({ audit }: { audit: AuditItem[] }) {
  return <>
    <div className="welcome-row activity-title"><div><div className="eyebrow"><span className="sun-mark"><FileClock size={13} /></span> ACCOUNTABILITY</div><h1>Your <em>audit history.</em></h1><p className="page-subtitle">Review an append-only timeline of plan changes, fund transfers and their notes, reimbursements, and recurring posts.</p></div><span className="audit-count">{audit.length} saved events</span></div>
    <section className="panel shadow-card audit-history-panel"><div className="panel-heading"><div><span className="section-kicker">MOST RECENT FIRST</span><h2>Budget changes</h2></div></div>{audit.length ? <ol className="audit-history-list">{audit.map(entry => <li key={entry.id}><span className="audit-timeline-icon"><FileClock size={15} /></span><div><b>{entry.message}</b><time dateTime={entry.at}>{new Date(entry.at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</time></div></li>)}</ol> : <p className="forecast-empty">No saved changes yet.</p>}</section>
  </>
}
