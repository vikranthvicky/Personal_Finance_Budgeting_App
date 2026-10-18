import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import { relationalSchema } from '../server/schema.ts'
import type { AppState } from '../src/types.ts'

const testUrl = process.env.MYSQL_TEST_URL

async function unusedPort() {
  const listener = createServer()
  await new Promise<void>((resolve, reject) => listener.listen(0, '127.0.0.1', resolve).once('error', reject))
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('Could not allocate an API test port.')
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
  return address.port
}

async function stop(process?: ChildProcess) {
  if (!process || process.exitCode !== null) return
  process.kill()
  await new Promise<void>(resolve => process.once('exit', () => resolve()))
}

test('MySQL API migrates legacy snapshots, persists records, rejects invalid data, and serializes concurrent writes', { skip: !testUrl }, async () => {
  const pool = mysql.createPool(testUrl!)
  const budgetId = `test-${crypto.randomUUID()}`
  let api: ChildProcess | undefined
  try {
    // Seed one old-format JSON budget before the API creates normalized tables.
    await pool.query(relationalSchema[0])
    const state: AppState & { revision: number } = {
      month: '2026-10', currentBalance: 200, revision: 3,
      income: [{ id: 'pay', name: 'Payday', amount: 1000, cadence: '15th, monthly' }],
      categories: [{ id: 'food', name: 'Food', color: '#123456', icon: 'food', planned: 500, rollover: 'carry', periods: { '2026-09': { planned: 400, rollover: 'carry' } } }],
      transactions: [{ id: 'old-tx', date: '2026-10-01', merchant: 'Legacy shop', description: 'Imported expense', amount: 10, categoryId: 'food', splits: [{ id: 'old-split', categoryId: 'food', amount: 10 }] }],
      recurring: [{ id: 'rent', name: 'Rent', amount: 800, categoryId: 'food', cadence: 'monthly', day: 20, nextDate: '2026-10-20', kind: 'bill', active: true }],
      moves: [], audit: [{ id: 'legacy-audit', at: '2026-10-01T00:00:00.000Z', message: 'Imported' }], rules: [],
    }
    const now = new Date().toISOString()
    await pool.execute('INSERT INTO budgets (id,name,budget_month,current_balance,state_json,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', [budgetId, 'Migration fixture', state.month, state.currentBalance, JSON.stringify(state), state.revision, now, now])

    const port = await unusedPort()
    api = spawn(process.execPath, ['--import', fileURLToPath(new URL('./tsx-userinfo-shim.cjs', import.meta.url)), '--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(), env: { ...process.env, MYSQL_URL: testUrl, PORT: String(port) }, stdio: 'ignore' })
    const baseUrl = `http://127.0.0.1:${port}`
    let ready = false
    for (let attempt = 0; attempt < 120; attempt++) {
      if (api.exitCode !== null) throw new Error(`Test API exited during startup with code ${api.exitCode}.`)
      try { if ((await fetch(`${baseUrl}/api/health`)).ok) { ready = true; break } } catch { /* wait for startup */ }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(ready, 'test API should start against MYSQL_TEST_URL')

    const stateUrl = `${baseUrl}/api/state?budgetId=${encodeURIComponent(budgetId)}`
    const loadState = async () => {
      const response = await fetch(stateUrl)
      assert.equal(response.status, 200)
      return response.json() as Promise<AppState & { revision: number }>
    }
    let loaded = await loadState()
    assert.equal(loaded.transactions[0].id, 'old-tx')
    assert.equal(loaded.transactions[0].splits?.[0].id, 'old-split')
    assert.equal(loaded.revision, 3)

    const [migration] = await pool.execute('SELECT source_revision FROM relational_migrations WHERE budget_id = ?', [budgetId]) as any
    const [transactionRows] = await pool.execute('SELECT COUNT(*) AS total FROM transactions WHERE budget_id = ?', [budgetId]) as any
    assert.equal(migration[0].source_revision, 3)
    assert.equal(Number(transactionRows[0].total), 1)

    const invalidAmount = structuredClone(loaded)
    invalidAmount.transactions[0].amount = 0
    let response = await fetch(stateUrl, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(invalidAmount) })
    assert.equal(response.status, 400)
    const emptyName = structuredClone(loaded)
    emptyName.income[0].name = '   '
    response = await fetch(stateUrl, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(emptyName) })
    assert.equal(response.status, 400)
    loaded = await loadState()

    const firstUpdate = structuredClone(loaded)
    const secondUpdate = structuredClone(loaded)
    firstUpdate.currentBalance = 210
    secondUpdate.currentBalance = 220
    const concurrent = await Promise.all([firstUpdate, secondUpdate].map(value => fetch(stateUrl, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })))
    assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 409])
    loaded = await loadState()

    const occurrenceUrl = `${baseUrl}/api/recurring/rent/post?budgetId=${encodeURIComponent(budgetId)}`
    const post = () => fetch(occurrenceUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ occurrenceDate: '2026-10-20', revision: loaded.revision }) })
    const duplicateResults = await Promise.all([post(), post()])
    assert.ok(duplicateResults.every(result => result.status === 200))
    loaded = await loadState()
    assert.equal(loaded.transactions.filter(transaction => transaction.scheduledOccurrenceId === 'rent:2026-10-20').length, 1)

    // Reloading through the API reads the committed relational representation.
    assert.ok(loaded.transactions.some(transaction => transaction.id === 'old-tx'))
    const [postedRows] = await pool.execute('SELECT COUNT(*) AS total FROM scheduled_occurrences WHERE budget_id = ? AND occurrence_id = ? AND status = \'posted\'', [budgetId, 'rent:2026-10-20']) as any
    assert.equal(Number(postedRows[0].total), 1)
  } finally {
    await stop(api!)
    await pool.execute('DELETE FROM budgets WHERE id = ?', [budgetId]).catch(() => undefined)
    await pool.end()
  }
})
