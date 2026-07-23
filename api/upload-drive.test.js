import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildForwardedLineActionBody,
  buildForwardedLineActionResponse,
  canOpenSalesAttachmentCenterFromAccess,
  canServeDirectSalesAttachmentThumbnail,
} from './upload-drive.js'

const salesWithThumbnail = {
  attachments: [{ path: 'original-file-id', thumbnailPath: 'thumbnail-file-id' }]
}

test('只有已綁定的安全小縮圖可略過 Sharp 轉檔', () => {
  for (const mimeType of ['image/webp', 'image/jpeg', 'image/png']) {
    assert.equal(canServeDirectSalesAttachmentThumbnail(salesWithThumbnail, {
      fileId: 'thumbnail-file-id',
      variant: 'preview',
      mimeType,
      size: 2 * 1024 * 1024
    }), true)
  }
})

test('原圖、未知縮圖、危險格式與超限檔案仍必須轉檔', () => {
  const base = {
    fileId: 'thumbnail-file-id',
    variant: 'preview',
    mimeType: 'image/webp',
    size: 120_000
  }
  assert.equal(canServeDirectSalesAttachmentThumbnail(salesWithThumbnail, { ...base, variant: 'original' }), false)
  assert.equal(canServeDirectSalesAttachmentThumbnail(salesWithThumbnail, { ...base, fileId: 'original-file-id' }), false)
  assert.equal(canServeDirectSalesAttachmentThumbnail(salesWithThumbnail, { ...base, fileId: 'unknown-file-id' }), false)
  assert.equal(canServeDirectSalesAttachmentThumbnail(salesWithThumbnail, { ...base, mimeType: 'image/svg+xml' }), false)
  assert.equal(canServeDirectSalesAttachmentThumbnail(salesWithThumbnail, { ...base, mimeType: 'image/gif' }), false)
  assert.equal(canServeDirectSalesAttachmentThumbnail(salesWithThumbnail, { ...base, size: 2 * 1024 * 1024 + 1 }), false)
  assert.equal(canServeDirectSalesAttachmentThumbnail(salesWithThumbnail, { ...base, size: 0 }), false)
})

test('舊的完工 action 只轉送事件與附件資料', () => {
  assert.deepEqual(buildForwardedLineActionBody({
    action: 'complete-order-fulfillment',
    eventId: 'event-1',
    attachmentIds: ['photo-1'],
    amount: 999,
    customerId: 'forged-customer',
    paymentMethod: '匯款'
  }), {
    action: 'complete-order-fulfillment',
    eventId: 'event-1',
    attachmentIds: ['photo-1']
  })
})

test('現金付款 action 只轉送金額與冪等鍵', () => {
  assert.deepEqual(buildForwardedLineActionBody({
    action: 'record-fulfillment-cash-payment',
    eventId: 'event-1',
    amount: 1200,
    idempotencyKey: 'payment-attempt-1',
    attachmentIds: ['photo-1'],
    customerId: 'forged-customer',
    salesId: 'forged-sales',
    paymentMethod: '匯款'
  }), {
    action: 'record-fulfillment-cash-payment',
    eventId: 'event-1',
    amount: 1200,
    idempotencyKey: 'payment-attempt-1'
  })
})

test('只有可管理事件者能取得背景未付款提示', () => {
  const result = {
    ok: true,
    bound: true,
    paymentPrompt: { required: true, outstandingTotal: 5867 }
  }
  assert.deepEqual(buildForwardedLineActionResponse('production-photo-status', result, { canManageEvent: false }), {
    ok: true,
    bound: true,
    paymentPrompt: undefined,
    paymentState: undefined,
    currentOrderUnpaidAmount: undefined,
    outstandingTotal: undefined,
    canCompleteOrder: false
  })
  assert.deepEqual(buildForwardedLineActionResponse('production-photo-status', result, { canManageEvent: true }), {
    ...result,
    canCompleteOrder: true
  })
})

test('銷貨單掃描權限可查看附件中心，但不會放行缺少更新權限者', () => {
  const actor = {
    uid: 'scanner-uid',
    employeeId: 'emp-scanner',
    employee: { empNo: '239215' },
  }
  const baseAccess = {
    enabled: true,
    uid: actor.uid,
    employeeId: actor.employeeId,
    employeeNo: actor.employee.empNo,
    schemaVersion: 2,
  }

  assert.equal(canOpenSalesAttachmentCenterFromAccess({
    ...baseAccess,
    permissionMatrix: {
      'sales-order-scan': { browse: true, update: true, special: false },
    },
  }, actor), true)

  assert.equal(canOpenSalesAttachmentCenterFromAccess({
    ...baseAccess,
    permissionMatrix: {
      'sales-order-scan': { browse: true, update: false, special: false },
    },
  }, actor), false)

  assert.equal(canOpenSalesAttachmentCenterFromAccess({
    ...baseAccess,
    employeeId: 'other-employee',
    permissionMatrix: {
      'sales-order-scan': { browse: true, update: true, special: false },
    },
  }, actor), false)
})
