import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../src/pages/CalendarPage.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('CalendarPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let handler, buttonClick
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'handleDetailAttachmentFileChange') handler = node.getText(ast)
  if (ts.isJsxOpeningElement(node) && node.tagName.getText(ast) === 'button') {
    const attrs = node.attributes.properties
    if (attrs.some(a => a.name?.text === 'className' && a.initializer?.text === 'event-detail-upload-btn')) {
      buttonClick = attrs.find(a => a.name?.text === 'onClick').initializer.expression.getText(ast)
    }
  }
  ts.forEachChild(node, visit)
}
visit(ast)
const transpile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
function setup(overrides = {}) {
  const calls = []
  const deps = {
    selectedOperationalEvent: { id: 'test-event', source: 'erpSalesDelivery' },
    productionLineStatus: {},
    canUploadDetailAttachment: () => true,
    isHrReadonlyEvent: () => false,
    isErpOrderFulfillmentEvent: () => true,
    canUseBackgroundImageUpload: f => f.type === 'image/jpeg',
    isTouchDevice: true,
    setDetailAttachmentUploading: value => calls.push(['busy', value]),
    requestDevicePhotoLocationForEvent: async () => { calls.push(['location']); return {} },
    setDetailAttachmentUploadNotice: notice => calls.push(['notice', notice.message]),
    queueDetailBackgroundUploads: (...args) => calls.push(['queue', ...args]),
    setFulfillmentPaymentModal: () => {},
    setFulfillmentPaymentAmount: () => {},
    setFulfillmentPaymentError: () => {},
    alert: message => calls.push(['error', message]),
    ...overrides,
  }
  const run = new Function(...Object.keys(deps), `${transpile(handler)}; return handleDetailAttachmentFileChange`)(...Object.values(deps))
  return { calls, run }
}
const photo = { name: 'test.jpg', type: 'image/jpeg' }
const change = (files = [photo]) => ({ target: { files, value: 'test.jpg' } })

test('按完成照片同步開啟選檔，不在選檔前要求定位', () => {
  let opened = 0
  new Function('detailAttachmentInputRef', `return (${buttonClick})()`)({ current: { click() { opened += 1 } } })
  assert.equal(opened, 1)
})
test('取消選檔不定位、不上傳；允許再次選擇相同檔案', async () => {
  const { calls, run } = setup()
  const event = change([])
  await run(event)
  assert.equal(event.target.value, '')
  assert.deepEqual(calls, [])
})
test('選完照片立即顯示忙碌，定位完成才將同一批照片交給背景佇列', async () => {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const { calls, run } = setup({ requestDevicePhotoLocationForEvent: () => pending })
  const event = change()
  const task = run(event)
  assert.deepEqual(calls, [['busy', true]])
  const location = { latitude: 22, longitude: 120, source: 'device' }
  finish({ location })
  await task
  assert.equal(event.target.value, '')
  assert.deepEqual(calls.map(c => c[0]), ['busy', 'queue', 'busy'])
  assert.deepEqual(calls[1].slice(2), [[photo], location])
  assert.deepEqual(calls.at(-1), ['busy', false])
})
test('拒絕定位保留提示並仍交給背景上傳', async () => {
  const { calls, run } = setup({ requestDevicePhotoLocationForEvent: async () => ({ warning: '未允許定位' }) })
  await run(change())
  assert.deepEqual(calls.map(c => c[0]), ['busy', 'notice', 'queue', 'busy'])
  assert.equal(calls[1][1], '未允許定位')
})
test('桌面選照片不要求手機定位', async () => {
  const { calls, run } = setup({ isTouchDevice: false })
  await run(change())
  assert.deepEqual(calls.map(c => c[0]), ['busy', 'queue', 'busy'])
})
test('無權限、非照片或超過20張時，在定位及入列前阻擋', async () => {
  for (const [overrides, files] of [
    [{ canUploadDetailAttachment: () => false }, [photo]],
    [{}, [{ type: 'application/pdf' }]],
    [{}, Array(21).fill(photo)],
  ]) {
    const { calls, run } = setup(overrides)
    await run(change(files))
    assert.deepEqual(calls.map(c => c[0]), ['error'])
  }
})
test('準備照片發生例外時有錯誤提示並解除忙碌狀態', async () => {
  const { calls, run } = setup({ requestDevicePhotoLocationForEvent: async () => { throw new Error('test failure') } })
  await run(change())
  assert.deepEqual(calls, [['busy', true], ['error', 'test failure'], ['busy', false]])
})
