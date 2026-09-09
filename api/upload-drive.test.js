import assert from 'node:assert/strict'
import test from 'node:test'
import {
  fulfillmentSelectionStatus,
  authorizeUpload,
  authorizeLineAction,
  buildForwardedLineActionBody,
  buildForwardedLineActionResponse,
  attachmentFromUploadJob,
  attachmentUploaderFields,
  calendarAttachmentDeletePolicy,
  resolveCalendarAttachmentDeletePolicy,
  canOpenSalesAttachmentCenterFromAccess,
  canServeDirectSalesAttachmentThumbnail,
  canUseErpOrderFulfillmentPermission,
  changedSalesDeliveryFields,
  isForwardedLineAction,
  normalizeSalesDeliveryEventSyncInput,
  normalizeRelatedSalesDeliveryEventSyncInput,
  parseAttachmentUploadJobRequest,
  salesAttachmentUploadMetadata,
  salesDeliveryPatchForEventChanges,
  salesDeliveryEventFieldsMatch,
  syncSalesDeliveryEventFields,
  syncRelatedSalesDeliveryEventFields,
} from './upload-drive.js'

const salesWithThumbnail = {
  attachments: [{ path: 'original-file-id', thumbnailPath: 'thumbnail-file-id' }]
}

test('指定員工不可呼叫 ERP 主事件或附屬事件編輯 API，即使具管理角色', async () => {
  for (const employeeId of ['emp_085101', 'emp_239215']) {
    for (const role of ['employee', 'admin']) {
      const actor = { employeeId, role }
      for (const sync of [syncSalesDeliveryEventFields, syncRelatedSalesDeliveryEventFields]) {
        await assert.rejects(sync(null, actor, {}), (error) => error.status === 403)
      }
    }
  }
})

test('指定員工仍可上傳完成照片、讀取完工狀態並執行完成訂單', async () => {
  const eventId = 'erpSalesDelivery_permission-test'
  const { db } = memoryDb({
    [`calendarEvents/${eventId}`]: {
      source: 'erpSalesDelivery', sourceId: 'sale-test', departmentId: 'dept-ad',
      sourceShippingMethod: '施工', assigneeIds: [],
    },
    'departments/dept-ad': { name: '廣告部' },
  })
  for (const employeeId of ['emp_085101', 'emp_239215']) {
    const actor = {
      employeeId, uid: `test-${employeeId}`, role: 'employee',
      employee: { departmentId: 'dept-ad', departmentName: '廣告部' },
    }
    assert.equal((await authorizeUpload(db, actor, { eventId, uploadKind: 'event' })).uploadKind, 'event')
    for (const action of ['production-photo-status', 'complete-order-fulfillment']) {
      assert.equal((await authorizeLineAction(db, actor, { eventId, action })).canManageEvent, true)
    }
  }
})

test('附件上傳人資料優先使用員工暱稱並保存員工編號', () => {
  assert.deepEqual(attachmentUploaderFields({
    uid: 'user-1',
    employeeId: 'employee-1',
    employee: { empNo: 'C100001', nickname: '小明', name: '王小明' },
    decoded: { name: '登入名稱' },
  }), {
    uploadedByUid: 'user-1',
    uploadedByEmployeeNo: 'C100001',
    uploadedByName: '小明',
  })
})

test('背景附件結果會透傳建立工作時保存的上傳人資料', () => {
  const attachment = attachmentFromUploadJob('job-uploader-1', {
    uploadedByUid: 'user-1',
    uploadedByEmployeeNo: 'C100001',
    uploadedByName: '小明',
    original: { name: '現場.jpg', size: 1024 },
    result: {
      image: {
        path: 'drive-image-id',
        name: '現場.webp',
        type: 'image/webp',
        size: 512,
      },
    },
  })
  assert.deepEqual({
    uploadedByUid: attachment.uploadedByUid,
    uploadedByEmployeeNo: attachment.uploadedByEmployeeNo,
    uploadedByName: attachment.uploadedByName,
  }, {
    uploadedByUid: 'user-1',
    uploadedByEmployeeNo: 'C100001',
    uploadedByName: '小明',
  })
})

test('銷貨附件中心透傳上傳人並以舊建立時間補足上傳時間', () => {
  assert.deepEqual(salesAttachmentUploadMetadata({
    uploadedByUid: 'user-1',
    uploadedByEmployeeNo: 'C100001',
    uploadedByName: '小明',
    createdAtText: '2026/09/05 10:20:30',
  }), {
    uploadedByUid: 'user-1',
    uploadedByEmployeeNo: 'C100001',
    uploadedByName: '小明',
    uploadedAt: '2026/09/05 10:20:30',
  })
  assert.equal(salesAttachmentUploadMetadata({
    uploadedAt: '2026-09-05T02:20:30.000Z',
    createdAtText: '2026/09/04 09:00:00',
  }).uploadedAt, '2026-09-05T02:20:30.000Z')
})

test('完工工作管理中的原圖與縮圖不得由行事曆硬刪除', () => {
  const appProperties = {
    attachmentUploadJobId: 'job-1',
    calendarEventId: 'event-1',
  }
  const job = {
    status: 'committed',
    target: {
      eventId: 'event-1',
      completionMode: 'fulfillment',
      uploadKind: 'event',
    },
  }
  for (const fileId of ['original-file-id', 'thumbnail-file-id']) {
    assert.deepEqual(calendarAttachmentDeletePolicy({ fileId, appProperties, job }), {
      action: 'retain',
      reason: 'fulfillment-job-managed',
    })
  }
})

test('ERP 配送事件與銷貨仍引用的附件交由 ERP 管理', () => {
  const event = {
    source: 'erpSalesDelivery',
    attachments: [{ path: 'event-file-id' }],
  }
  assert.deepEqual(calendarAttachmentDeletePolicy({
    fileId: 'event-file-id',
    event,
  }), {
    action: 'retain',
    reason: 'erp-sales-attachment-managed',
  })
  assert.deepEqual(calendarAttachmentDeletePolicy({
    fileId: 'sales-source-id',
    event: { source: 'erpSalesDelivery', attachments: [] },
    sales: { attachments: [{ sourceAttachmentId: 'sales-source-id' }] },
  }), {
    action: 'retain',
    reason: 'erp-sales-attachment-managed',
  })
})

test('一般事件附件與已失敗的孤立完工附件仍可清理', () => {
  assert.deepEqual(calendarAttachmentDeletePolicy({
    fileId: 'ordinary-file-id',
    event: { source: 'manual' },
  }), {
    action: 'delete',
    reason: 'unmanaged',
  })
  assert.deepEqual(calendarAttachmentDeletePolicy({
    fileId: 'orphan-file-id',
    appProperties: { attachmentUploadJobId: 'job-2', calendarEventId: 'event-2' },
    job: {
      status: 'failed',
      target: { eventId: 'event-2', completionMode: 'fulfillment', uploadKind: 'event' },
    },
    event: { source: 'erpSalesDelivery', attachments: [] },
    sales: { attachments: [] },
  }), {
    action: 'delete',
    reason: 'unreferenced',
  })
})

function memoryDb(seed) {
  const records = new Map(Object.entries(seed).map(([path, value]) => [path, structuredClone(value)]))
  let nextId = 1
  const ref = (path) => ({ path, id: path.split('/').at(-1) })
  const snapshot = (documentRef) => ({
    id: documentRef.id,
    ref: documentRef,
    exists: records.has(documentRef.path),
    data: () => structuredClone(records.get(documentRef.path)),
  })
  const querySnapshot = (queryRef) => {
    const prefix = `${queryRef.collectionName}/`
    const docs = Array.from(records.entries()).flatMap(([path, value]) => {
      if (!path.startsWith(prefix) || path.slice(prefix.length).includes('/')) return []
      if (!queryRef.filters.every(({ field, value: expected }) => value?.[field] === expected)) return []
      return [snapshot(ref(path))]
    })
    return { docs, empty: docs.length === 0, size: docs.length }
  }
  const collectionRef = (name) => ({
    doc(id) {
      const documentRef = ref(`${name}/${id || `generated-${nextId++}`}`)
      return {
        ...documentRef,
        get: async () => snapshot(documentRef),
      }
    },
    where(field, operator, value) {
      assert.equal(operator, '==')
      return { kind: 'query', collectionName: name, filters: [{ field, value }] }
    },
  })
  const db = {
    collection: collectionRef,
    async runTransaction(run) {
      return run({
        get: async (documentRef) => documentRef.kind === 'query'
          ? querySnapshot(documentRef)
          : snapshot(documentRef),
        update(documentRef, patch) {
          records.set(documentRef.path, { ...records.get(documentRef.path), ...patch })
        },
        set(documentRef, value) {
          records.set(documentRef.path, structuredClone(value))
        },
      })
    },
  }
  return { db, records }
}

const salesDeliverySyncActor = {
  uid: 'admin-uid',
  role: 'admin',
  employeeId: 'employee-1',
  employee: { name: '測試主管', empNo: 'c100001' },
  decoded: {},
}

function relatedSalesDeliveryEventFields(overrides = {}) {
  return {
    title: '👷 測試事件',
    date: '2026-09-08',
    endDate: '2026-09-08',
    startTime: '10:00',
    endTime: '11:00',
    allDay: false,
    location: '新北市板橋區',
    calendarId: 'department:dept-ad',
    calendarIds: ['department:dept-ad'],
    departmentId: 'dept-ad',
    assigneeIds: ['employee-1'],
    visibleDepartmentIds: [],
    visibleAssigneeIds: [],
    hiddenDepartmentIds: [],
    hiddenAssigneeIds: [],
    titleOverrides: [],
    reminder: 'none',
    url: '',
    ...overrides,
  }
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

test('完工 action 只轉送事件、附件與預期 lifecycle', () => {
  assert.deepEqual(buildForwardedLineActionBody({
    action: 'complete-order-fulfillment',
    eventId: 'event-1',
    attachmentIds: ['photo-1'],
    expectedShippingMethod: '施工',
    expectedOrderStatus: '生產中',
    amount: 999,
    customerId: 'forged-customer',
    paymentMethod: '匯款'
  }), {
    action: 'complete-order-fulfillment',
    eventId: 'event-1',
    attachmentIds: ['photo-1'],
    expectedShippingMethod: '施工',
    expectedOrderStatus: '生產中'
  })
})

test('舊版獨立活動照片 action 不再提供 LINE 傳送', () => {
  assert.equal(isForwardedLineAction('production-photo-status'), true)
  assert.equal(isForwardedLineAction('complete-order-fulfillment'), true)
  assert.equal(isForwardedLineAction('record-fulfillment-cash-payment'), true)
  assert.equal(isForwardedLineAction('send-production-photos'), false)
})

test('舊版 production 模式只保留活動附件，不建立另一套 LINE 傳送流程', () => {
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

test('完工照片背景工作必須帶入有效批次資料', () => {
  const input = {
    eventId: 'event-1',
    originalName: 'delivery.jpg',
    contentType: 'image/jpeg',
    originalSize: 1024,
    completionMode: 'fulfillment',
    clientUploadId: 'delivery-photo-1',
    fulfillmentBatchId: 'delivery-batch-1',
    fulfillmentBatchSize: 3,
  }
  const request = parseAttachmentUploadJobRequest(input)
  assert.equal(request.fulfillmentBatchId, 'delivery-batch-1')
  assert.equal(request.fulfillmentBatchSize, 3)
  assert.throws(() => parseAttachmentUploadJobRequest({
    ...input,
    fulfillmentBatchId: '',
  }), /批次識別碼/)
  assert.throws(() => parseAttachmentUploadJobRequest({
    ...input,
    fulfillmentBatchSize: 0,
  }), /批次張數/)
  assert.equal(parseAttachmentUploadJobRequest({
    ...input,
    fulfillmentBatchSize: 20,
  }).fulfillmentBatchSize, 20)
  assert.throws(() => parseAttachmentUploadJobRequest({
    ...input,
    fulfillmentBatchSize: 21,
  }), /批次張數/)
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

test('銷貨完成權限套用於 ERP 外送、施工或活動事件', () => {
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
    sourceShippingMethod: '活動',
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
      endDate: '2026-08-09',
      startTime: '13:30',
      endTime: '10:00',
      allDay: false,
      location: '瑞豐國中',
    },
  })
  assert.deepEqual(input.sales, {
    calendarTitle: '鄭光峰(瑞豐國中)-進場',
    deliveryDate: '2026/08/08',
    deliveryStartTime: '13:30',
    deliveryEndTime: '10:00',
    deliveryTime: '指定時間',
    deliveryScheduleSource: 'manual',
    recipientAddress: '瑞豐國中',
    recipientPostalCode: '',
  })
})

test('行事曆配送同步允許跨日，並拒絕倒置日期、全天與倒置時間', () => {
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
  assert.doesNotThrow(() => normalizeSalesDeliveryEventSyncInput({
    ...base,
    event: { ...base.expected, endDate: '2026-08-09' },
  }))
  assert.throws(() => normalizeSalesDeliveryEventSyncInput({
    ...base,
    event: { ...base.expected, date: '2026-08-09', endDate: '2026-08-08' },
  }), /結束日期不得早於開始日期/)
  assert.throws(() => normalizeSalesDeliveryEventSyncInput({
    ...base,
    event: { ...base.expected, allDay: true },
  }), /必須指定開始與結束時間/)
  assert.throws(() => normalizeSalesDeliveryEventSyncInput({
    ...base,
    event: { ...base.expected, startTime: '12:00', endTime: '11:00' },
  }), /結束時間必須晚於開始時間/)
})

test('舊的全天配送事件可被修正成跨日指定時間', () => {
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
      endDate: '2026-08-09',
      startTime: '11:00',
      endTime: '10:00',
      allDay: false,
      location: '民族路',
    },
  }))
})

test('原本就是全天的活動事件可保持全天並移動日期', () => {
  const input = normalizeSalesDeliveryEventSyncInput({
    eventId: 'erpSalesDelivery_sales-activity',
    calendarTitle: '全天活動',
    expected: {
      title: '🎪 全天活動',
      date: '2026-08-08',
      endDate: '2026-08-09',
      startTime: '',
      endTime: '',
      allDay: true,
      location: '中央公園',
    },
    event: {
      title: '🎪 全天活動',
      date: '2026-08-10',
      endDate: '2026-08-11',
      startTime: '',
      endTime: '',
      allDay: true,
      location: '中央公園',
    },
  })
  assert.equal(input.sales.deliveryDate, '2026/08/10')
  assert.equal(input.sales.deliveryTime, '')
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
    recipientPostalCode: '',
  }), {
    recipientAddress: '新地址',
    recipientPostalCode: '',
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
      endDate: '2026-08-10',
      startTime: '13:00',
      endTime: '10:00',
      allDay: false,
      location: '新地址',
    },
  })
  assert.equal(result.ok, true)
  assert.deepEqual({
    title: records.get(`calendarEvents/${eventId}`).title,
    date: records.get(`calendarEvents/${eventId}`).date,
    endDate: records.get(`calendarEvents/${eventId}`).endDate,
    location: records.get(`calendarEvents/${eventId}`).location,
  }, {
    title: '👷 新標題',
    date: '2026-08-08',
    endDate: '2026-08-10',
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
    deliveryEndTime: '10:00',
    deliveryScheduleSource: 'manual',
    recipientAddress: '新地址',
  })
  assert.equal(Array.from(records.keys()).filter((path) => path.startsWith('sales_audit_logs/')).length, 1)
})

test('拖曳全天活動事件會同步銷售單日期並保留跨日範圍', async () => {
  const eventId = 'erpSalesDelivery_sales-activity'
  const { db, records } = memoryDb({
    [`calendarEvents/${eventId}`]: {
      source: 'erpSalesDelivery',
      sourceId: 'sales-activity',
      sourceSalesNo: '263500',
      title: '🎪 全天活動',
      date: '2026-08-08',
      endDate: '2026-08-09',
      startTime: '',
      endTime: '',
      allDay: true,
      location: '中央公園',
    },
    'sales/sales-activity': {
      salesNo: '263500',
      shippingMethod: '活動',
      deliveryCalendarEventId: eventId,
      calendarTitle: '全天活動',
      deliveryDate: '2026/08/08',
      deliveryStartTime: '',
      deliveryEndTime: '',
      deliveryTime: '',
      deliveryScheduleSource: 'manual',
      recipientAddress: '中央公園',
    },
  })

  await syncSalesDeliveryEventFields(db, {
    uid: 'admin-uid',
    role: 'admin',
    employeeId: 'employee-1',
    employee: { name: '測試主管', empNo: 'c100001' },
    decoded: {},
  }, {
    eventId,
    calendarTitle: '全天活動',
    expected: {
      title: '🎪 全天活動',
      date: '2026-08-08',
      endDate: '2026-08-09',
      startTime: '',
      endTime: '',
      allDay: true,
      location: '中央公園',
    },
    event: {
      title: '🎪 全天活動',
      date: '2026-08-10',
      endDate: '2026-08-11',
      startTime: '',
      endTime: '',
      allDay: true,
      location: '中央公園',
    },
  })

  assert.equal(records.get(`calendarEvents/${eventId}`).date, '2026-08-10')
  assert.equal(records.get(`calendarEvents/${eventId}`).endDate, '2026-08-11')
  assert.equal(records.get('sales/sales-activity').deliveryDate, '2026/08/10')
  assert.equal(records.get('sales/sales-activity').deliveryTime, '')
})

test('主事件只改地址會同步正確關聯的所有附屬事件', async () => {
  const eventId = 'erpSalesDelivery_sales-address-main'
  const expected = {
    title: '👷 主事件',
    date: '2026-09-08',
    endDate: '2026-09-08',
    startTime: '10:00',
    endTime: '11:00',
    allDay: false,
    location: '舊地址',
  }
  const siblingOne = 'related-main-address-1'
  const siblingTwo = 'related-main-address-2'
  const seed = {
    [`calendarEvents/${eventId}`]: {
      ...expected,
      source: 'erpSalesDelivery',
      sourceId: 'sales-address-main',
      sourceSalesNo: '263710',
      sourceEventRole: 'primary',
    },
    [`calendarEvents/${siblingOne}`]: {
      ...relatedSalesDeliveryEventFields({ title: '📦 附屬一', location: '舊地址' }),
      source: 'erpSalesDelivery', sourceId: 'sales-address-main', sourceSalesNo: '263710',
      sourceEventRole: 'related', sourceParentEventId: eventId,
    },
    [`calendarEvents/${siblingTwo}`]: {
      ...relatedSalesDeliveryEventFields({ title: '📦 附屬二', startTime: '14:00', endTime: '15:00', location: '其他舊地址' }),
      source: 'erpSalesDelivery', sourceId: 'sales-address-main', sourceSalesNo: '263710',
      sourceEventRole: 'related', sourceParentEventId: eventId,
    },
    'calendarEvents/related-main-wrong-parent': {
      ...relatedSalesDeliveryEventFields({ location: '不可改' }),
      source: 'erpSalesDelivery', sourceId: 'sales-address-main', sourceSalesNo: '263710',
      sourceEventRole: 'related', sourceParentEventId: 'other-primary',
    },
    'calendarEvents/related-main-wrong-sales-no': {
      ...relatedSalesDeliveryEventFields({ location: '不可改' }),
      source: 'erpSalesDelivery', sourceId: 'sales-address-main', sourceSalesNo: '999999',
      sourceEventRole: 'related', sourceParentEventId: eventId,
    },
    'sales/sales-address-main': {
      salesNo: '263710',
      shippingMethod: '施工',
      deliveryCalendarEventId: eventId,
      calendarTitle: '主事件',
      recipientPostalCode: '220',
      recipientAddress: '舊地址',
      orderStatus: '生產中',
    },
  }
  const { db, records } = memoryDb(seed)
  await syncSalesDeliveryEventFields(db, salesDeliverySyncActor, {
    eventId,
    calendarTitle: '主事件',
    expected,
    event: { ...expected, location: '新地址' },
  })

  assert.equal(records.get(`calendarEvents/${eventId}`).location, '新地址')
  assert.deepEqual({
    title: records.get(`calendarEvents/${siblingOne}`).title,
    startTime: records.get(`calendarEvents/${siblingOne}`).startTime,
    location: records.get(`calendarEvents/${siblingOne}`).location,
  }, { title: '📦 附屬一', startTime: '10:00', location: '新地址' })
  assert.deepEqual({
    title: records.get(`calendarEvents/${siblingTwo}`).title,
    startTime: records.get(`calendarEvents/${siblingTwo}`).startTime,
    location: records.get(`calendarEvents/${siblingTwo}`).location,
  }, { title: '📦 附屬二', startTime: '14:00', location: '新地址' })
  assert.equal(records.get('calendarEvents/related-main-wrong-parent').location, '不可改')
  assert.equal(records.get('calendarEvents/related-main-wrong-sales-no').location, '不可改')
  assert.deepEqual({
    recipientPostalCode: records.get('sales/sales-address-main').recipientPostalCode,
    recipientAddress: records.get('sales/sales-address-main').recipientAddress,
    orderStatus: records.get('sales/sales-address-main').orderStatus,
  }, { recipientPostalCode: '', recipientAddress: '新地址', orderStatus: '生產中' })
  const siblingActivities = Array.from(records.values()).filter((record) => (
    record?.action === 'update' && [siblingOne, siblingTwo].includes(record.eventId)
  ))
  assert.equal(siblingActivities.length, 2)
  assert.ok(siblingActivities.every((activity) => activity.changes[0].field === 'location'))
})

test('地址改為空白會被拒絕，但舊空白地址不會阻擋改名', async () => {
  const eventId = 'erpSalesDelivery_sales-empty-location'
  const expected = {
    title: '👷 舊標題', date: '2026-09-08', endDate: '2026-09-08',
    startTime: '10:00', endTime: '11:00', allDay: false, location: '',
  }
  const { db, records } = memoryDb({
    [`calendarEvents/${eventId}`]: {
      ...expected, source: 'erpSalesDelivery', sourceId: 'sales-empty-location', sourceSalesNo: '263711',
    },
    'sales/sales-empty-location': {
      salesNo: '263711', shippingMethod: '施工', deliveryCalendarEventId: eventId, calendarTitle: '舊標題',
    },
  })
  await syncSalesDeliveryEventFields(db, salesDeliverySyncActor, {
    eventId,
    calendarTitle: '新標題',
    expected,
    event: { ...expected, title: '👷 新標題' },
  })
  assert.equal(records.get(`calendarEvents/${eventId}`).title, '👷 新標題')

  await assert.rejects(syncSalesDeliveryEventFields(db, salesDeliverySyncActor, {
    eventId,
    calendarTitle: '新標題',
    expected: { ...expected, title: '👷 新標題', location: '舊地址' },
    event: { ...expected, title: '👷 新標題', location: '' },
  }), (error) => error?.status === 400 && /收件地址不可空白/.test(error.message))

  const related = relatedSalesDeliveryEventFields({ location: '舊地址' })
  await assert.rejects(syncRelatedSalesDeliveryEventFields(db, salesDeliverySyncActor, {
    requestId: 'request-empty-location-0001',
    relatedEventId: 'related-empty-location',
    primaryEventId: eventId,
    calendarTitle: '附屬事件',
    expected: { related, primary: relatedSalesDeliveryEventFields({ location: '舊地址' }) },
    events: { related: { ...related, location: '' }, primary: { ...related, location: '' } },
  }), (error) => error?.status === 400 && /收件地址不可空白/.test(error.message))
})

test('整組地址同步會在附屬事件超過安全上限時停止', async () => {
  const eventId = 'erpSalesDelivery_sales-too-many-related'
  const expected = {
    title: '👷 主事件', date: '2026-09-08', endDate: '2026-09-08',
    startTime: '10:00', endTime: '11:00', allDay: false, location: '舊地址',
  }
  const seed = {
    [`calendarEvents/${eventId}`]: {
      ...expected, source: 'erpSalesDelivery', sourceId: 'sales-too-many-related', sourceSalesNo: '263712',
    },
    'sales/sales-too-many-related': {
      salesNo: '263712', shippingMethod: '外送', deliveryCalendarEventId: eventId,
      recipientAddress: '舊地址',
    },
  }
  for (let index = 0; index < 201; index += 1) {
    seed[`calendarEvents/related-limit-${index}`] = {
      ...relatedSalesDeliveryEventFields({ location: '舊地址' }),
      source: 'erpSalesDelivery', sourceId: 'sales-too-many-related', sourceSalesNo: '263712',
      sourceEventRole: 'related', sourceParentEventId: eventId,
    }
  }
  const { db, records } = memoryDb(seed)
  await assert.rejects(syncSalesDeliveryEventFields(db, salesDeliverySyncActor, {
    eventId,
    calendarTitle: '主事件',
    expected,
    event: { ...expected, location: '新地址' },
  }), (error) => error?.status === 409 && /數量過多/.test(error.message))
  assert.equal(records.get(`calendarEvents/${eventId}`).location, '舊地址')
  assert.equal(records.get('sales/sales-too-many-related').recipientAddress, '舊地址')
})

test('關聯事件原子同步僅接受明確白名單欄位', () => {
  const baseBody = {
    requestId: 'request-related-0001',
    relatedEventId: 'related-event-1',
    primaryEventId: 'erpSalesDelivery_sales-related-1',
    calendarTitle: '主事件',
    expected: {
      related: relatedSalesDeliveryEventFields(),
      primary: relatedSalesDeliveryEventFields({ title: '👷 主事件' }),
    },
    events: {
      related: relatedSalesDeliveryEventFields(),
      primary: relatedSalesDeliveryEventFields({ title: '👷 主事件' }),
    },
  }
  for (const forbiddenField of [
    'attachments', 'comments', 'done', 'source', 'sourceId', 'sourceEventRole',
    'orderStatus', 'orderFulfillment', 'fulfillmentRetry', 'createdAt', 'repeat',
    'repeatCustom', 'note', 'todos',
  ]) {
    assert.throws(() => normalizeRelatedSalesDeliveryEventSyncInput({
      ...baseBody,
      events: {
        ...baseBody.events,
        related: { ...baseBody.events.related, [forbiddenField]: forbiddenField === 'done' ? false : [] },
      },
    }), /不允許的欄位/)
  }
})

test('關聯事件改地址會同步整組地址並保留各事件名稱與時間', async () => {
  const relatedEventId = 'related-event-atomic-1'
  const primaryEventId = 'erpSalesDelivery_sales-related-atomic-1'
  const siblingEventId = 'related-event-atomic-2'
  const wrongParentEventId = 'related-event-wrong-parent'
  const wrongSalesNoEventId = 'related-event-wrong-sales-no'
  const expectedRelated = relatedSalesDeliveryEventFields({ title: '📦 附屬事件', location: '舊地址' })
  const expectedPrimary = relatedSalesDeliveryEventFields({
    title: '👷 主事件',
    date: '2026-09-10',
    endDate: '2026-09-11',
    startTime: '15:00',
    endTime: '12:00',
    location: '舊地址',
    calendarId: 'department:dept-management',
    calendarIds: ['department:dept-management'],
    departmentId: 'dept-management',
    reminder: '1h',
  })
  const nextRelated = relatedSalesDeliveryEventFields({
    title: '📦 附屬事件獨立改名',
    date: '2026-09-09',
    endDate: '2026-09-09',
    startTime: '13:00',
    endTime: '14:00',
    location: '新地址',
  })
  const oldClientPrimaryPayload = { ...nextRelated }
  const preservedFields = {
    note: '原始備註',
    todos: [{ id: 'todo-1', text: '不可覆寫' }],
    attachments: [{ path: 'drive-file-1' }],
    done: true,
    orderStatus: '已完成',
    sourceShippingMethod: '施工',
  }
  const { db, records } = memoryDb({
    [`calendarEvents/${relatedEventId}`]: {
      ...expectedRelated,
      ...preservedFields,
      source: 'erpSalesDelivery',
      sourceId: 'sales-related-atomic-1',
      sourceSalesNo: '263700',
      sourceEventRole: 'related',
      sourceParentEventId: primaryEventId,
    },
    [`calendarEvents/${primaryEventId}`]: {
      ...expectedPrimary,
      ...preservedFields,
      source: 'erpSalesDelivery',
      sourceId: 'sales-related-atomic-1',
      sourceSalesNo: '263700',
      sourceEventRole: 'primary',
    },
    [`calendarEvents/${siblingEventId}`]: {
      ...relatedSalesDeliveryEventFields({
        title: '📦 其他附屬事件',
        startTime: '16:00',
        endTime: '17:00',
        location: '舊地址',
      }),
      source: 'erpSalesDelivery',
      sourceId: 'sales-related-atomic-1',
      sourceSalesNo: '263700',
      sourceEventRole: 'related',
      sourceParentEventId: primaryEventId,
    },
    [`calendarEvents/${wrongParentEventId}`]: {
      ...relatedSalesDeliveryEventFields({ location: '不可改的地址' }),
      source: 'erpSalesDelivery',
      sourceId: 'sales-related-atomic-1',
      sourceSalesNo: '263700',
      sourceEventRole: 'related',
      sourceParentEventId: 'other-primary',
    },
    [`calendarEvents/${wrongSalesNoEventId}`]: {
      ...relatedSalesDeliveryEventFields({ location: '不可改的地址' }),
      source: 'erpSalesDelivery',
      sourceId: 'sales-related-atomic-1',
      sourceSalesNo: '999999',
      sourceEventRole: 'related',
      sourceParentEventId: primaryEventId,
    },
    'sales/sales-related-atomic-1': {
      salesNo: '263700',
      shippingMethod: '施工',
      deliveryCalendarEventId: primaryEventId,
      calendarTitle: '主事件不可被附屬事件改名',
      deliveryDate: '2026/09/10',
      deliveryStartTime: '15:00',
      deliveryEndTime: '12:00',
      deliveryTime: '指定時間',
      deliveryScheduleSource: 'manual',
      recipientPostalCode: '220',
      recipientAddress: '舊地址',
      orderStatus: '生產中',
      note: '銷貨單備註不可覆寫',
    },
  })
  const body = {
    requestId: 'request-related-atomic-0001',
    relatedEventId,
    primaryEventId,
    calendarTitle: '附屬事件獨立改名',
    expected: { related: expectedRelated, primary: expectedPrimary },
    events: { related: nextRelated, primary: oldClientPrimaryPayload },
  }

  const result = await syncRelatedSalesDeliveryEventFields(db, salesDeliverySyncActor, body)
  assert.equal(result.ok, true)
  assert.equal(result.reused, false)
  assert.equal(records.get(`calendarEvents/${relatedEventId}`).title, '📦 附屬事件獨立改名')
  assert.deepEqual({
    title: records.get(`calendarEvents/${primaryEventId}`).title,
    date: records.get(`calendarEvents/${primaryEventId}`).date,
    endDate: records.get(`calendarEvents/${primaryEventId}`).endDate,
    startTime: records.get(`calendarEvents/${primaryEventId}`).startTime,
    endTime: records.get(`calendarEvents/${primaryEventId}`).endTime,
    location: records.get(`calendarEvents/${primaryEventId}`).location,
    calendarId: records.get(`calendarEvents/${primaryEventId}`).calendarId,
    reminder: records.get(`calendarEvents/${primaryEventId}`).reminder,
  }, {
    title: expectedPrimary.title,
    date: expectedPrimary.date,
    endDate: expectedPrimary.endDate,
    startTime: expectedPrimary.startTime,
    endTime: expectedPrimary.endTime,
    location: '新地址',
    calendarId: 'department:dept-management',
    reminder: '1h',
  })
  assert.deepEqual({
    title: records.get(`calendarEvents/${siblingEventId}`).title,
    startTime: records.get(`calendarEvents/${siblingEventId}`).startTime,
    endTime: records.get(`calendarEvents/${siblingEventId}`).endTime,
    location: records.get(`calendarEvents/${siblingEventId}`).location,
  }, {
    title: '📦 其他附屬事件',
    startTime: '16:00',
    endTime: '17:00',
    location: '新地址',
  })
  assert.equal(records.get(`calendarEvents/${wrongParentEventId}`).location, '不可改的地址')
  assert.equal(records.get(`calendarEvents/${wrongSalesNoEventId}`).location, '不可改的地址')
  for (const eventId of [relatedEventId, primaryEventId]) {
    for (const [field, value] of Object.entries(preservedFields)) {
      assert.deepEqual(records.get(`calendarEvents/${eventId}`)[field], value)
    }
  }
  assert.deepEqual({
    calendarTitle: records.get('sales/sales-related-atomic-1').calendarTitle,
    deliveryDate: records.get('sales/sales-related-atomic-1').deliveryDate,
    deliveryStartTime: records.get('sales/sales-related-atomic-1').deliveryStartTime,
    deliveryEndTime: records.get('sales/sales-related-atomic-1').deliveryEndTime,
    deliveryTime: records.get('sales/sales-related-atomic-1').deliveryTime,
    deliveryScheduleSource: records.get('sales/sales-related-atomic-1').deliveryScheduleSource,
    recipientPostalCode: records.get('sales/sales-related-atomic-1').recipientPostalCode,
    recipientAddress: records.get('sales/sales-related-atomic-1').recipientAddress,
    orderStatus: records.get('sales/sales-related-atomic-1').orderStatus,
    note: records.get('sales/sales-related-atomic-1').note,
  }, {
    calendarTitle: '主事件不可被附屬事件改名',
    deliveryDate: '2026/09/10',
    deliveryStartTime: '15:00',
    deliveryEndTime: '12:00',
    deliveryTime: '指定時間',
    deliveryScheduleSource: 'manual',
    recipientPostalCode: '',
    recipientAddress: '新地址',
    orderStatus: '生產中',
    note: '銷貨單備註不可覆寫',
  })
  assert.equal(Array.from(records.keys()).filter((path) => path.startsWith('sales_audit_logs/')).length, 1)
  assert.equal(Array.from(records.keys()).filter((path) => path.startsWith('calendarActivityLogs/')).length, 3)
  const activities = Array.from(records.entries())
    .filter(([path]) => path.startsWith('calendarActivityLogs/'))
    .map(([, value]) => value)
  assert.ok(activities.every((activity) => activity.changes.every((change) => change.before && change.after)))
  assert.ok(activities.some((activity) => activity.eventId === siblingEventId
    && activity.changes.some((change) => change.field === 'location')))
  assert.deepEqual(result.siblingAddressEventIds, [siblingEventId])

  const replay = await syncRelatedSalesDeliveryEventFields(db, salesDeliverySyncActor, body)
  assert.equal(replay.reused, true)
  assert.equal(Array.from(records.keys()).filter((path) => path.startsWith('sales_audit_logs/')).length, 1)
  assert.equal(Array.from(records.keys()).filter((path) => path.startsWith('calendarActivityLogs/')).length, 3)
})

test('關聯事件 API 在主或附屬事件並行變更時停止同步', async () => {
  const relatedEventId = 'related-event-conflict-1'
  const primaryEventId = 'erpSalesDelivery_sales-related-conflict-1'
  const expectedRelated = relatedSalesDeliveryEventFields({ title: '📦 附屬事件' })
  const expectedPrimary = relatedSalesDeliveryEventFields({ title: '👷 主事件' })
  const { db, records } = memoryDb({
    [`calendarEvents/${relatedEventId}`]: {
      ...expectedRelated,
      title: '📦 已被其他畫面修改',
      source: 'erpSalesDelivery',
      sourceId: 'sales-related-conflict-1',
      sourceSalesNo: '263701',
      sourceEventRole: 'related',
      sourceParentEventId: primaryEventId,
    },
    [`calendarEvents/${primaryEventId}`]: {
      ...expectedPrimary,
      source: 'erpSalesDelivery',
      sourceId: 'sales-related-conflict-1',
      sourceSalesNo: '263701',
    },
    'sales/sales-related-conflict-1': {
      salesNo: '263701',
      shippingMethod: '外送',
      deliveryCalendarEventId: primaryEventId,
    },
  })
  await assert.rejects(syncRelatedSalesDeliveryEventFields(db, salesDeliverySyncActor, {
    requestId: 'request-related-conflict-0001',
    relatedEventId,
    primaryEventId,
    calendarTitle: '主事件',
    expected: { related: expectedRelated, primary: expectedPrimary },
    events: { related: expectedRelated, primary: expectedPrimary },
  }), (error) => error?.status === 409 && /其他畫面更新/.test(error.message))
  assert.equal(Array.from(records.keys()).some((path) => path.startsWith('calendarEventSyncRequests/')), false)
  assert.equal(Array.from(records.keys()).some((path) => path.startsWith('sales_audit_logs/')), false)
})

test('關聯事件 API 會拒絕銷貨單主事件指標或關聯單號不一致', async () => {
  const relatedEventId = 'related-event-link-1'
  const primaryEventId = 'erpSalesDelivery_sales-related-link-1'
  const related = relatedSalesDeliveryEventFields({ title: '📦 附屬事件' })
  const primary = relatedSalesDeliveryEventFields({ title: '👷 主事件' })
  for (const scenario of [
    { requestId: 'request-related-link-0001', relatedSalesNo: '999999', primaryPointer: primaryEventId, message: /關聯已變更/ },
    { requestId: 'request-related-link-0002', relatedSalesNo: '263702', primaryPointer: 'another-primary-event', message: /主要事件指標不一致/ },
  ]) {
    const { db } = memoryDb({
      [`calendarEvents/${relatedEventId}`]: {
        ...related,
        source: 'erpSalesDelivery',
        sourceId: 'sales-related-link-1',
        sourceSalesNo: scenario.relatedSalesNo,
        sourceEventRole: 'related',
        sourceParentEventId: primaryEventId,
      },
      [`calendarEvents/${primaryEventId}`]: {
        ...primary,
        source: 'erpSalesDelivery',
        sourceId: 'sales-related-link-1',
        sourceSalesNo: '263702',
        sourceEventRole: 'primary',
      },
      'sales/sales-related-link-1': {
        salesNo: '263702',
        shippingMethod: '施工',
        deliveryCalendarEventId: scenario.primaryPointer,
      },
    })
    await assert.rejects(syncRelatedSalesDeliveryEventFields(db, salesDeliverySyncActor, {
      requestId: scenario.requestId,
      relatedEventId,
      primaryEventId,
      calendarTitle: '主事件',
      expected: { related, primary },
      events: { related, primary },
    }), (error) => error?.status === 409 && scenario.message.test(error.message))
  }
})

test('舊版主事件同步 API 不得在銷貨單指標空白時誤用附屬事件', async () => {
  const eventId = 'erpSalesDelivery_sales-related-legacy'
  const fields = relatedSalesDeliveryEventFields({ title: '📦 附屬事件' })
  const { db } = memoryDb({
    [`calendarEvents/${eventId}`]: {
      ...fields,
      source: 'erpSalesDelivery',
      sourceId: 'sales-related-legacy',
      sourceSalesNo: '263703',
      sourceEventRole: 'related',
      sourceParentEventId: 'primary-event-legacy',
    },
    'sales/sales-related-legacy': {
      salesNo: '263703',
      shippingMethod: '施工',
      deliveryCalendarEventId: '',
    },
  })
  await assert.rejects(syncSalesDeliveryEventFields(db, salesDeliverySyncActor, {
    eventId,
    calendarTitle: '附屬事件',
    expected: fields,
    event: fields,
  }), (error) => error?.status === 409 && /附屬事件/.test(error.message))
})


test('合併配達原圖及縮圖保留實體檔案，不因單張解除關聯或工作失敗而刪除', () => {
  for (const fileId of ['shared-original', 'shared-thumbnail']) {
    for (const context of [
      { appProperties: { fulfillmentBatchId: 'delivery-batch-1' } },
      { job: { status: 'failed', target: { fulfillmentOrders: [{ eventId: 'event-a' }, { eventId: 'event-b' }] } } },
      { event: { attachments: [{ path: 'shared-original', thumbnailPath: 'shared-thumbnail', fulfillmentBatchId: 'delivery-batch-1' }] } },
      { sales: { attachments: [{ path: 'shared-original', thumbnailPath: 'shared-thumbnail', fulfillmentBatchId: 'delivery-batch-1' }] } },
    ]) {
      assert.deepEqual(calendarAttachmentDeletePolicy({ fileId, ...context }), { action: 'retain', reason: 'shared-fulfillment-attachment' })
    }
  }
})


test('本單引用解除後，合併配達紀錄仍保護原圖及縮圖', async () => {
  for (const [fileId, matchedField] of [['original', 'attachmentIds'], ['thumbnail', 'protectedFileIds']]) {
    const db = { collection(name) {
      assert.equal(name, 'calendar_fulfillment_batches')
      return { where(field, operator, value) {
        assert.equal(operator, 'array-contains')
        assert.equal(value, fileId)
        return { limit(count) { assert.equal(count, 1); return { get: async () => ({ empty: field !== matchedField }) } } }
      } }
    } }
    assert.deepEqual(await resolveCalendarAttachmentDeletePolicy(db, fileId, 'source-event', {}), { action: 'retain', reason: 'shared-fulfillment-attachment' })
  }
})


test('合併配達勾選確認拒絕無效批次，尚未讀取資料', async () => {
  const db = { collection() { assert.fail('無效批次不得查詢') } }
  for (const eventIds of [undefined, [], [''], ['a/b'], [' a'], [null], [123], ['a'.repeat(201)], Array(21).fill('a')]) {
    await assert.rejects(fulfillmentSelectionStatus(db, salesDeliverySyncActor, { eventIds }), (error) => error.status === 400)
  }
})

test('合併配達勾選確認去重並只讀精確事件與銷貨，不讀付款或通知', async () => {
  const { db } = memoryDb({
    'calendarEvents/a': { source: 'erpSalesDelivery', sourceId: 'sale-a' },
    'calendarEvents/b': { source: 'erpSalesDelivery', sourceId: 'sale-b', sourceShippingMethod: '施工' },
    'sales/sale-a': { shippingMethod: '外送', orderStatus: '即將配送', customer: '不可回傳', amount: 500 },
    'sales/sale-b': { shippingMethod: '外送', orderStatus: '已配達' },
  })
  const reads = []
  const original = db.collection
  db.collection = (name) => {
    assert.ok(['calendarEvents', 'sales'].includes(name), '不得讀付款、LINE、投影或其他集合')
    return { doc(id) { reads.push(`${name}/${id}`); return original(name).doc(id) } }
  }
  const result = await fulfillmentSelectionStatus(db, salesDeliverySyncActor, { eventIds: ['a', 'b', 'a'] })
  assert.deepEqual(result, { ok: true, statuses: [
    { eventId: 'a', salesId: 'sale-a', status: { canCompleteOrder: true, shippingMethod: '外送', orderStatus: '即將配送' } },
    { eventId: 'b', salesId: 'sale-b', status: { canCompleteOrder: true, shippingMethod: '外送', orderStatus: '已配達' } },
  ], errors: [] })
  assert.equal(reads.length, 4)
})

test('合併配達勾選確認權限拒絕不讀銷貨，也不透露單號', async () => {
  const { db } = memoryDb({
    'calendarEvents/hidden': { source: 'erpSalesDelivery', sourceId: 'secret', hiddenAssigneeIds: ['employee-test'] },
    'calendarEvents/view-only': { source: 'erpSalesDelivery', sourceId: 'secret' },
  })
  const actor = { uid: 'test-user', employeeId: 'employee-test', role: 'employee', employee: {} }
  const original = db.collection
  db.collection = (name) => { assert.notEqual(name, 'sales'); return original(name) }
  const result = await fulfillmentSelectionStatus(db, actor, { eventIds: ['hidden', 'view-only'] })
  assert.deepEqual(result.statuses, [])
  assert.deepEqual(result.errors, [
    { eventId: 'hidden', message: '沒有查看此銷貨單事件的權限' },
    { eventId: 'view-only', message: '沒有配達回報權限' },
  ])
})

test('合併配達勾選確認逐筆拒絕附屬、缺少精確來源與作廢訂單', async () => {
  const { db } = memoryDb({
    'calendarEvents/related': { source: 'erpSalesDelivery', sourceId: 'sale', sourceEventRole: 'related' },
    'calendarEvents/missing': { source: 'erpSalesDelivery', sourceSalesNo: 'sale' },
    'calendarEvents/void': { source: 'erpSalesDelivery', sourceId: 'sale' },
    'sales/sale': { status: '作廢', shippingMethod: '外送' },
  })
  const result = await fulfillmentSelectionStatus(db, salesDeliverySyncActor, { eventIds: ['related', 'missing', 'void'] })
  assert.equal(result.statuses.length, 0)
  assert.equal(result.errors.length, 3)
  assert.match(result.errors[0].message, /附屬/)
  assert.match(result.errors[1].message, /有效/)
  assert.match(result.errors[2].message, /作廢/)
})

test('合併配達勾選確認最多四筆查詢並行且維持輸入順序', async () => {
  let active = 0
  let peak = 0
  const db = { collection(name) { return { doc(id) { return { async get() {
    active++
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 1))
    active--
    return { exists: true, data: () => name === 'calendarEvents'
      ? { source: 'erpSalesDelivery', sourceId: id }
      : { shippingMethod: '外送', orderStatus: '即將配送' } }
  } } } } } }
  const eventIds = Array.from({ length: 12 }, (_, index) => `event-${index}`)
  const result = await fulfillmentSelectionStatus(db, salesDeliverySyncActor, { eventIds })
  assert.equal(peak, 4)
  assert.deepEqual(result.statuses.map((entry) => entry.eventId), eventIds)
})


test('合併配達勾選確認與 ERP 完成訂單一致正規化空白及舊狀態，出貨方式不猜測', async () => {
  const { db } = memoryDb({
    'calendarEvents/empty': { source: 'erpSalesDelivery', sourceId: 'sale-empty', sourceShippingMethod: '外送' },
    'calendarEvents/legacy': { source: 'erpSalesDelivery', sourceId: 'sale-legacy' },
    'sales/sale-empty': { shippingMethod: '  ', orderStatus: '  ' },
    'sales/sale-legacy': { shippingMethod: ' 外送 ', orderStatus: ' 已送出 ' },
  })
  const result = await fulfillmentSelectionStatus(db, salesDeliverySyncActor, { eventIds: ['empty', 'legacy'] })
  assert.deepEqual(result.statuses.map((entry) => entry.status), [
    { canCompleteOrder: true, shippingMethod: '', orderStatus: '未設定' },
    { canCompleteOrder: true, shippingMethod: '外送', orderStatus: '已寄出' },
  ])
})
