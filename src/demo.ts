import type { AppState } from './types'

export function createDemoState(): AppState {
  const month = new Date().toISOString().slice(0, 7)
  const year = Number(month.slice(0, 4)); const monthNumber = Number(month.slice(5, 7))
  const d = (day: number) => `${month}-${String(day).padStart(2, '0')}`
  const nextDue = (day: number) => {
    const due = new Date(year, monthNumber - 1, day, 12)
    if (due.toISOString().slice(0, 10) < new Date().toISOString().slice(0, 10)) due.setMonth(due.getMonth() + 1)
    return due.toISOString().slice(0, 10)
  }
  const categories = [
    { id: 'home', name: 'Home & bills', color: '#6c7d5b', icon: 'home', planned: 1750, rollover: 'carry' as const },
    { id: 'food', name: 'Food & groceries', color: '#d18a5c', icon: 'food', planned: 820, rollover: 'carry' as const },
    { id: 'transport', name: 'Getting around', color: '#7a83b8', icon: 'transport', planned: 360, rollover: 'carry' as const },
    { id: 'health', name: 'Health & care', color: '#b47883', icon: 'health', planned: 250, rollover: 'carry' as const },
    { id: 'fun', name: 'Little joys', color: '#d4ae58', icon: 'spark', planned: 420, rollover: 'reset' as const },
    { id: 'personal', name: 'Personal', color: '#659c95', icon: 'person', planned: 300, rollover: 'carry' as const },
    { id: 'savings', name: 'Future you', color: '#73936f', icon: 'leaf', planned: 900, rollover: 'carry' as const },
  ]
  const transactions = [
    ['t1', 2, 'Northside Market', 'Weekly groceries', 86.42, 'food'],
    ['t2', 3, 'Metro Transit', 'Monthly transit pass', 68, 'transport'],
    ['t3', 4, 'Green Basket', 'Groceries & pantry', 112.75, 'food'],
    ['t4', 5, 'Cedar Cafe', 'Lunch with Maya', 24.5, 'fun'],
    ['t5', 7, 'City Power', 'Electricity bill', 94.18, 'home'],
    ['t6', 8, 'Corner Pharmacy', 'Prescription refill', 32.6, 'health'],
    ['t7', 9, 'Northside Market', 'Groceries', 74.28, 'food'],
    ['t8', 11, 'Rideshare', 'Airport pickup', 41.8, 'transport'],
    ['t9', 12, 'Oak & Stone', 'Dinner with Alex', 58.2, 'fun'],
    ['t10', 13, 'Studio Supply Co.', 'Project materials', 126.4, 'personal'],
    ['t11', 14, 'Water Works', 'Water & sewer', 38.5, 'home'],
  ].map(([id, day, merchant, description, amount, categoryId]) => ({ id: String(id), date: d(Number(day)), merchant: String(merchant), description: String(description), amount: Number(amount), categoryId: String(categoryId), account: 'Everyday •• 4821' }))
  const recurring = [
    { id: 'r1', name: 'Apartment rent', amount: 1450, categoryId: 'home', cadence: 'monthly' as const, day: 1, nextDate: nextDue(1), kind: 'bill' as const, active: true },
    { id: 'r2', name: 'Internet', amount: 64.99, categoryId: 'home', cadence: 'monthly' as const, day: 21, nextDate: nextDue(21), kind: 'bill' as const, active: true },
    { id: 'r3', name: 'Cloud storage', amount: 2.99, categoryId: 'personal', cadence: 'monthly' as const, day: 24, nextDate: nextDue(24), kind: 'subscription' as const, active: true },
    { id: 'r4', name: 'Car insurance', amount: 420, categoryId: 'transport', cadence: 'quarterly' as const, day: 28, nextDate: nextDue(28), kind: 'sinking' as const, active: true },
  ]
  const history = [
    ['h1', 'Northside Market', 'Groceries', 318.24, 'food'], ['h2', 'City Power', 'Electricity', 91.45, 'home'], ['h3', 'Metro Transit', 'Transit', 68, 'transport'], ['h4', 'Cedar Cafe', 'Dinner out', 107.6, 'fun'],
    ['h5', 'Green Basket', 'Groceries', 347.88, 'food'], ['h6', 'Water Works', 'Water bill', 36, 'home'], ['h7', 'Rideshare', 'Local rides', 82.35, 'transport'], ['h8', 'Corner Pharmacy', 'Pharmacy', 46.2, 'health'],
    ['h9', 'Northside Market', 'Groceries', 295.18, 'food'], ['h10', 'City Power', 'Electricity', 88.1, 'home'], ['h11', 'Cedar Cafe', 'Dinner out', 94.35, 'fun'], ['h12', 'Studio Supply Co.', 'Materials', 74.9, 'personal'],
  ].map(([id, merchant, description, amount, categoryId], index) => {
    const offset = Math.floor(index / 4) + 1
    const date = new Date(year, monthNumber - 1 - offset, 4 + (index % 4) * 5, 12)
    return { id: String(id), date: date.toISOString().slice(0, 10), merchant: String(merchant), description: String(description), amount: Number(amount), categoryId: String(categoryId), account: 'Everyday •• 4821' }
  })
  return {
    month,
    income: [{ id: 'i1', name: 'Northstar Studio', amount: 4200, cadence: '15th, monthly' }, { id: 'i2', name: 'Freelance retainer', amount: 2000, cadence: 'Last weekday' }],
    categories,
    transactions: [...transactions, ...history],
    recurring,
    moves: [],
    audit: [{ id: 'a1', at: new Date().toISOString(), message: 'Your October plan is ready.' }],
    rules: [{ id: 'rule1', contains: 'Northside Market', categoryId: 'food' }, { id: 'rule2', contains: 'Metro Transit', categoryId: 'transport' }, { id: 'rule3', contains: 'City Power', categoryId: 'home' }],
  }
}
