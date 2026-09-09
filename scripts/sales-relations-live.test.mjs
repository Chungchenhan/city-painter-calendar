import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'
import ts from 'typescript'

const source = readFileSync(new URL('../src/pages/CalendarPage.tsx', import.meta.url), 'utf8')
const start = source.indexOf('    if (!selectedEventId || !selectedSalesRelationSourceId || !user?.uid) return')
const body = source.slice(start, source.indexOf('\n  }, [Boolean(selectedEventId)', start))
const run = new Function('selectedEventId', 'selectedSalesRelationSourceId', 'user', 'setLiveSalesRelations', 'onSnapshot', 'query', 'collection', 'db', 'where', ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)

test('開啟詳情只監聽同銷貨單，追加與刪除會取代舊清單，關閉可解除監聽', () => {
  let next, fail, state, filter
  const unsubscribe = () => {}
  const result = run('visit', 'sale', { uid: 'viewer' }, value => { state = value }, (q, onNext, onError) => { filter = q; next = onNext; fail = onError; return unsubscribe }, (...args) => args, (_, name) => name, {}, (...args) => args)
  assert.equal(result, unsubscribe)
  assert.deepEqual(filter, ['calendarEvents', ['sourceId', '==', 'sale']])
  const snapshot = ids => ({ docs: ids.map(id => ({ id, data: () => ({ sourceId: 'sale' }) })) })
  next(snapshot(['primary', 'teardown']))
  next(snapshot(['primary', 'visit', 'teardown']))
  assert.deepEqual(state.events.map(e => e.id), ['primary', 'visit', 'teardown'])
  next(snapshot(['primary', 'teardown']))
  assert.deepEqual(state.events.map(e => e.id), ['primary', 'teardown'])
  fail(new Error('permission-denied'))
  assert.equal(state.error, true)
  assert.equal(state.loading, false)
})

test('未開啟事件時不讀取完整關聯清單', () => {
  run('', 'sale', { uid: 'viewer' }, () => assert.fail('unexpected state'), () => assert.fail('unexpected subscription'))
})
