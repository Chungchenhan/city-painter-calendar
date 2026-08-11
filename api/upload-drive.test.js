import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildForwardedLineActionBody,
  buildForwardedLineActionResponse,
  canOpenSalesAttachmentCenterFromAccess,
  canServeDirectSalesAttachmentThumbnail,
  canUseErpOrderFulfillmentPermission,
  changedSalesDeliveryFields,
  isForwardedLineAction,
  normalizeSalesDeliveryEventSyncInput,
  parseAttachmentUploadJobRequest,
  salesDeliveryPatchForEventChanges,
  salesDeliveryEventFieldsMatch,
  syncSalesDeliveryEventFields,
} from './upload-drive.js'

const salesWithThumbnail = {
  attachments: [{ path: 'original-file-id', thumbnailPath: 'thumbnail-file-id' }]
}

function memoryDb(seed) {
  const records = new Map(Object.entries(seed).map(([path, value]) => [path, structuredClone(value)]))
  let nextId = 1
  const ref = (path) => ({ path, id: path.split('/').at(-1) })
  const snapshot = (documentRef) => ({
    id: documentRef.id,
    exists: records.has(documentRef.path),
    data: () => structuredClone(records.get(documentRef.path)),
  })
  const db = {
    collection(name) {
      return {
        doc(id) {
          return ref(`${name}/${id || `generated-${nextId++}`}`)
        },
      }
    },
    async runTransaction(run) {
      return run({
        get: async (documentRef) => snapshot(documentRef),
        update(documentRef, patch) {
          records.set(documentRef.path, { ...records.get(documentRef.path), ...patch })
        },
        set(documentRef, value) {
          records.set(documentRef.path, structuredClone(value))
        },
      })
    },
  }
  db.collection = (name) => ({
    doc(id) {
      const documentRef = ref(`${name}/${id || `generated-${nextId++}`}`)
      return {
        ...documentRef,
        get: async () => snapshot(documentRef),
      }
    },
  })
  return { db, records }
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

test('活動事件照片不再提供 LINE 傳送 action', () => {
  assert.equal(isForwardedLineAction('production-photo-status'), true)
  assert.equal(isForwardedLineAction('complete-order-fulfillment'), true)
  assert.equal(isForwardedLineAction('record-fulfillment-cash-payment'), true)
  assert.equal(isForwardedLineAction('send-production-photos'), false)
})

test('舊版活動照片背景工作只保留附件，不再建立 LINE 傳送流程', () => {
  const request = parseAttachmentUploadJobRequest({
    eventId: 'event-1',
    originalName: 'activity.jpg',
    contentType: 'image/jpeg',
    originalSize: 1024,
    completionMode: 'production',
    clientUploadId: 'activity-photo-1'
  })
  assert.equal(request.completionMode, 'none')
})

test('留言照片背景工作必須綁定留言且不允許完工模式', () => {
  const input = {
    eventId: 'event-1',
    commentId: 'comment-1',
    uploadKind: 'comment',
    originalName: '留言照片.jpg',
    contentType: 'image/jpeg',
    originalSize: 1024,
    completionMode: 'none',
    clientUploadId: 'comment-photo-1',
  }
  const request = parseAttachmentUploadJobRequest(input)
  assert.equal(request.uploadKind, 'comment')
  assert.equal(request.commentId, 'comment-1')
  assert.throws(() => parseAttachmentUploadJobRequest({
    ...input,
    completionMode: 'fulfillment',
  }), /留言照片完成模式/)
  assert.throws(() => parseAttachmentUploadJobRequest({
    ...input,
    commentId: '',
  }), /留言識別碼/)
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

test('銷貨完成權限只套用於 ERP 外送或施工事件', () => {
  assert.equal(canUseErpOrderFulfillmentPermission({
    source: 'erpSalesDelivery',
    sourceShippingMethod: '外送',
  }, true), true)
  assert.equal(canUseErpOrderFulfillmentPermission({
    source: 'erpSalesDelivery',
    sourceShippingMethod: '施工',
  }, true), true)
  assert.equal(canUseErpOrderFulfillmentPermission({
    source: 'erpSalesDelivery',
    sourceShippingMethod: '民族自取',
  }, true), false)
  assert.equal(canUseErpOrderFulfillmentPermission({
    source: 'erpSalesDelivery',
    sourceShippingMethod: '外送',
  }, false), false)
  assert.equal(canUseErpOrderFulfillmentPermission({
    source: 'timeTreeImport',
    sourceShippingMethod: '外送',
  }, true), false)
})

test('行事曆配送欄位會正規化成銷貨單欄位', () => {
  const input = normalizeSalesDeliveryEventSyncInput({
    eventId: 'erpSalesDelivery_sales-1',
    calendarTitle: '鄭光峰(瑞豐國中)-進場',
    expected: {
      title: '👷 舊標題',
      date: '2026-08-07',
      endDate: '2026-08-07',
      startTime: '11:00',
      endTime: '12:00',
      allDay: false,
      location: '舊地址',
    },
    event: {
      title: '👷 鄭光峰(瑞豐國中)-進場',
      date: '2026-08-08',
      endDate: '2026-08-08',
      startTime: '13:30',
      endTime: '15:00',
      allDay: false,
      location: '瑞豐國中',
    },
  })
  assert.deepEqual(input.sales, {
    calendarTitle: '鄭光峰(瑞豐國中)-進場',
    deliveryDate: '2026/08/08',
    deliveryStartTime: '13:30',
    deliveryEndTime: '15:00',
    deliveryTime: '指定時間',
    deliveryScheduleSource: 'manual',
    recipientAddress: '瑞豐國中',
  })
})

test('行事曆配送同步拒絕跨日、全天與倒置時間', () => {
  const base = {
    eventId: 'erpSalesDelivery_sales-1',
    calendarTitle: '測試配送',
    expected: {
      title: '📦 測試配送',
      date: '2026-08-08',
      endDate: '2026-08-08',
      startTime: '11:00',
      endTime: '12:00',
      allDay: false,
      location: '民族路',
    },
  }
  assert.throws(() => normalizeSalesDeliveryEventSyncInput({
    ...base,
    event: { ...base.expected, endDate: '2026-08-09' },
  }), /只支援單日日期/)
  assert.throws(() => normalizeSalesDeliveryEventSyncInput({
    ...base,
    event: { ...base.expected, allDay: true },
  }), /必須指定開始與結束時間/)
  assert.throws(() => normalizeSalesDeliveryEventSyncInput({
    ...base,
    event: { ...base.expected, startTime: '12:00', endTime: '11:00' },
  }), /結束時間必須晚於開始時間/)
})

test('舊的跨日或全天配送事件可被修正成單日指定時間', () => {
  assert.doesNotThrow(() => normalizeSalesDeliveryEventSyncInput({
    eventId: 'erpSalesDelivery_sales-1',
    calendarTitle: '修正後配送',
    expected: {
      title: '📦 舊配送',
      date: '2026-08-08',
      endDate: '2026-08-09',
      startTime: '',
      endTime: '',
      allDay: true,
      location: '民族路',
    },
    event: {
      title: '📦 修正後配送',
      date: '2026-08-08',
      endDate: '2026-08-08',
      startTime: '11:00',
      endTime: '12:00',
      allDay: false,
      location: '民族路',
    },
  }))
})

test('行事曆配送同步可偵測並行更新與實際銷貨差異', () => {
  const expected = {
    title: '📦 測試配送',
    date: '2026-08-08',
    endDate: '2026-08-08',
    startTime: '11:00',
    endTime: '12:00',
    allDay: false,
    location: '民族路',
  }
  assert.equal(salesDeliveryEventFieldsMatch(expected, expected), true)
  assert.equal(salesDeliveryEventFieldsMatch({ ...expected, location: '其他地址' }, expected), false)
  assert.deepEqual(changedSalesDeliveryFields({
    calendarTitle: '測試配送',
    deliveryDate: '2026-08-08',
    deliveryStartTime: '11:00',
    deliveryEndTime: '12:00',
    deliveryTime: '指定時間',
    deliveryScheduleSource: 'manual',
    recipientAddress: '舊地址',
  }, {
    calendarTitle: '測試配送',
    deliveryDate: '2026/08/08',
    deliveryStartTime: '11:00',
    deliveryEndTime: '12:00',
    deliveryTime: '指定時間',
    deliveryScheduleSource: 'manual',
    recipientAddress: '新地址',
  }), ['收件地址'])
})

test('只變更地點時不會改寫條碼或自動排程來源', () => {
  const expected = {
    title: '📦 測試配送',
    date: '2026-08-08',
    endDate: '2026-08-08',
    startTime: '11:00',
    endTime: '12:00',
    allDay: false,
    location: '舊地址',
  }
  assert.deepEqual(salesDeliveryPatchForEventChanges(expected, {
    ...expected,
    location: '新地址',
  }, {
    calendarTitle: '測試配送',
    deliveryDate: '2026/08/08',
    deliveryStartTime: '11:00',
    deliveryEndTime: '12:00',
    deliveryTime: '指定時間',
    deliveryScheduleSource: 'manual',
    recipientAddress: '新地址',
  }), {
    recipientAddress: '新地址',
  })
})

test('既有 API action 會在同一交易更新事件、銷貨單與稽核紀錄', async () => {
  const eventId = 'erpSalesDelivery_sales-1'
  const { db, records } = memoryDb({
    [`calendarEvents/${eventId}`]: {
      source: 'erpSalesDelivery',
      sourceId: 'sales-1',
      sourceSalesNo: '263387',
      title: '👷 舊標題',
      date: '2026-08-07',
      endDate: '2026-08-07',
      startTime: '11:00',
      endTime: '12:00',
      allDay: false,
      location: '舊地址',
    },
    'sales/sales-1': {
      salesNo: '263387',
      shippingMethod: '施工',
      deliveryCalendarEventId: eventId,
      calendarTitle: '舊標題',
      deliveryDate: '2026/08/07',
      deliveryStartTime: '11:00',
      deliveryEndTime: '12:00',
      deliveryTime: '指定時間',
      deliveryScheduleSource: 'construction-auto',
      recipientAddress: '舊地址',
    },
  })
  const result = await syncSalesDeliveryEventFields(db, {
    uid: 'admin-uid',
    role: 'admin',
    employeeId: 'employee-1',
    employee: { name: '測試主管', empNo: 'c100001' },
    decoded: {},
  }, {
    eventId,
    calendarTitle: '新標題',
    expected: {
      title: '👷 舊標題',
      date: '2026-08-07',
      endDate: '2026-08-07',
      startTime: '11:00',
      endTime: '12:00',
      allDay: false,
      location: '舊地址',
    },
    event: {
      title: '👷 新標題',
      date: '2026-08-08',
      endDate: '2026-08-08',
      startTime: '13:00',
      endTime: '14:30',
      allDay: false,
      location: '新地址',
    },
  })
  assert.equal(result.ok, true)
  assert.deepEqual({
    title: records.get(`calendarEvents/${eventId}`).title,
    date: records.get(`calendarEvents/${eventId}`).date,
    location: records.get(`calendarEvents/${eventId}`).location,
  }, {
    title: '👷 新標題',
    date: '2026-08-08',
    location: '新地址',
  })
  assert.deepEqual({
    calendarTitle: records.get('sales/sales-1').calendarTitle,
    deliveryDate: records.get('sales/sales-1').deliveryDate,
    deliveryStartTime: records.get('sales/sales-1').deliveryStartTime,
    deliveryEndTime: records.get('sales/sales-1').deliveryEndTime,
    deliveryScheduleSource: records.get('sales/sales-1').deliveryScheduleSource,
    recipientAddress: records.get('sales/sales-1').recipientAddress,
  }, {
    calendarTitle: '新標題',
    deliveryDate: '2026/08/08',
    deliveryStartTime: '13:00',
    deliveryEndTime: '14:30',
    deliveryScheduleSource: 'manual',
    recipientAddress: '新地址',
  })
  assert.equal(Array.from(records.keys()).filter((path) => path.startsWith('sales_audit_logs/')).length, 1)
})
