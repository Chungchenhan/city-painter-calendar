import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveEventDetailAttachments, type EventDetailAttachment } from '../src/lib/eventDetailAttachments.ts'

function attachment(overrides: Partial<EventDetailAttachment>): EventDetailAttachment {
  return {
    name: '照片.jpg',
    url: '',
    path: '',
    ...overrides,
  }
}

test('ERP 銷貨附件以 canonical 上傳人覆蓋事件中的過期 metadata', () => {
  const [result] = resolveEventDetailAttachments({
    eventSource: 'erpSalesDelivery',
    eventAttachments: [attachment({
      path: '263850-photo-1',
      url: 'https://drive.example.com/263850-photo-1',
      originalName: '263850 現場照片.jpg',
      uploadedByName: '事件舊上傳人',
      uploadedAt: '2026-09-04T01:00:00.000Z',
    })],
    salesAttachments: [attachment({
      path: '263850-photo-1',
      url: '',
      uploadedByName: '銷貨實際上傳人',
      uploadedAt: '2026-09-05T02:30:00.000Z',
      linePreviewUrl: '/api/upload-drive?variant=preview',
    })],
    salesSourceAvailable: true,
  })

  assert.equal(result.uploadedByName, '銷貨實際上傳人')
  assert.equal(result.uploadedAt, '2026-09-05T02:30:00.000Z')
  assert.equal(result.originalName, '263850 現場照片.jpg')
  assert.equal(result.url, 'https://drive.example.com/263850-photo-1')
  assert.equal(result.linePreviewUrl, '/api/upload-drive?variant=preview')
})

test('canonical 缺少上傳人時不從事件附件猜測，但會補同檔案顯示欄位', () => {
  const [result] = resolveEventDetailAttachments({
    eventSource: 'erpSalesDelivery',
    eventAttachments: [attachment({
      path: 'same-path',
      uploadedByName: '事件舊上傳人',
      originalName: '原始檔名.jpg',
    })],
    salesAttachments: [attachment({ path: 'same-path', name: '' })],
    salesSourceAvailable: true,
  })
  assert.equal(result.uploadedByName, undefined)
  assert.equal(result.originalName, '原始檔名.jpg')
  assert.equal(result.name, '照片.jpg')
})

test('缺少 path 時仍能以 url stable key 合併同一附件', () => {
  const [result] = resolveEventDetailAttachments({
    eventSource: 'erpSalesDelivery',
    eventAttachments: [attachment({
      url: 'https://files.example.com/photo-1',
      originalName: 'url-match.jpg',
    })],
    salesAttachments: [attachment({
      url: 'https://files.example.com/photo-1',
      name: '',
      uploadedByName: '銷貨上傳人',
    })],
    salesSourceAvailable: true,
  })
  assert.equal(result.originalName, 'url-match.jpg')
  assert.equal(result.uploadedByName, '銷貨上傳人')
})

test('ERP canonical 成功回傳空清單時不沿用事件附件', () => {
  assert.deepEqual(resolveEventDetailAttachments({
    eventSource: 'erpSalesDelivery',
    eventAttachments: [attachment({ path: 'stale-event-photo' })],
    salesAttachments: [],
    salesSourceAvailable: true,
  }), [])
})

test('ERP 銷貨 API 尚未可用時回退事件附件', () => {
  const eventAttachments = [attachment({ path: 'fallback-event-photo' })]
  assert.deepEqual(resolveEventDetailAttachments({
    eventSource: 'erpSalesDelivery',
    eventAttachments,
    salesAttachments: [],
    salesSourceAvailable: false,
  }), eventAttachments)
})

test('非 ERP 配送事件只讀取事件附件', () => {
  const eventAttachments = [attachment({ path: 'manual-event-photo' })]
  assert.deepEqual(resolveEventDetailAttachments({
    eventSource: 'manual',
    eventAttachments,
    salesAttachments: [attachment({ path: 'sales-photo' })],
    salesSourceAvailable: true,
  }), eventAttachments)
})
