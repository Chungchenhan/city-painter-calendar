import assert from 'node:assert/strict'
import test from 'node:test'
import { visualViewportKeyboardInset } from '../src/lib/visualViewport.ts'

test('正常 viewport 不會被判定有鍵盤底部縮減', () => {
  assert.equal(visualViewportKeyboardInset(874, 874, 0), 0)
})

test('鍵盤開啟時會計算縮減後的可視高度', () => {
  assert.equal(visualViewportKeyboardInset(874, 520, 0), 354)
})

test('viewport 上移量不會重複計入鍵盤高度', () => {
  assert.equal(visualViewportKeyboardInset(874, 520, 24), 330)
})
