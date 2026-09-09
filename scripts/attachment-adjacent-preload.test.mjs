import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../src/components/ZoomableAttachmentImage.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText

function render(props, authorized = {}) {
  const calls = []
  const module = { exports: {} }
  const require = (name) => {
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }) }
    if (name.includes('calendarAttachmentAccess')) return {
      calendarDriveFileId: source => source.startsWith('drive:') ? source.slice(6) : '',
      useCalendarAttachmentAccess: (eventId, fileId) => {
        calls.push([eventId, fileId])
        return { links: authorized[`${eventId}:${fileId}`] }
      },
    }
    if (name.includes('AttachmentImageViewer')) return { default: 'viewer' }
    throw new Error(`Unexpected import ${name}`)
  }
  new Function('require', 'module', 'exports', compiled)(require, module, module.exports)
  return { props: module.exports.default({ src: 'drive:current', eventId: 'event', ...props }).props, calls }
}

test('相鄰原圖使用同事件有效授權並限量兩張', () => {
  const result = render({ preloadSources: ['drive:current', '', 'drive:previous', 'drive:previous', 'drive:next', 'drive:extra'] }, {
    'event:previous': { lineOriginalUrl: 'signed-previous' },
    'event:next': { lineOriginalUrl: 'signed-next' },
  })
  assert.deepEqual(result.props.preloadSources, ['signed-previous', 'signed-next'])
  assert.deepEqual(result.calls, [['event', 'current'], ['event', 'previous'], ['event', 'next']])
})

test('授權未就緒或已過期不退回舊 Drive 網址；換事件不沿用原授權', () => {
  const authorized = { 'event:next': { lineOriginalUrl: 'signed-next' } }
  assert.deepEqual(render({ preloadSources: ['drive:next'] }).props.preloadSources, [])
  assert.deepEqual(render({ eventId: 'other', preloadSources: ['drive:next'] }, authorized).props.preloadSources, [])
})

test('既有 ERP 代理與本機圖片維持原來源', () => {
  const sources = ['/api/sales?scope=sales-attachment', 'blob:local']
  assert.deepEqual(render({ preloadSources: sources }).props.preloadSources, sources)
})
