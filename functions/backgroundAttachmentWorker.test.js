const assert = require('node:assert/strict')
const test = require('node:test')
const sharp = require('sharp')

process.env.FIREBASE_CONFIG ||= JSON.stringify({
  projectId: 'city-painter-erp',
  storageBucket: 'city-painter-erp.firebasestorage.app',
})

const {
  CLEANUP_AGE_MS,
  assertDecodedImage,
  calendarAttachmentFromJobResult,
  classifyFulfillmentBatchJobs,
  cleanupExpiredJobs,
  commitCalendarCommentAttachment,
  commitCalendarEventFulfillmentAttachment,
  exchangeCustomTokenForIdToken,
  fulfillmentBatchDocumentId,
  fulfillmentBatchId,
  fulfillmentBatchLeaseDecision,
  fulfillmentBatchSize,
  fulfillmentFailureState,
  fulfillmentLineResultDecision,
  fulfillmentRetryDelayMs,
  lineImageUrls,
  parseStagingObjectPath,
  resultFileIds,
  shouldCleanupJob,
  sendFulfillmentLineRequest,
  transformVariants,
  variantNames,
} = require('./backgroundAttachmentWorker')

test('只有新格式且完整的完工批次會交給背景 worker', () => {
  const job = {
    target: {
      fulfillmentBatchId: 'batch-12345678',
      fulfillmentBatchSize: 20,
    },
  }
  assert.equal(fulfillmentBatchId(job), 'batch-12345678')
  assert.equal(fulfillmentBatchSize(job), 20)
  assert.equal(fulfillmentBatchId({ target: {} }), '')
  assert.equal(fulfillmentBatchSize({ target: { fulfillmentBatchSize: 21 } }), 0)
  assert.equal(fulfillmentBatchDocumentId('batch-12345678').length, 64)
})

test('LINE 圖片簽名綁定期限並保留金鑰尾端換行', () => {
  const expires = 2000000000
  const urls = lineImageUrls('drive-file-1', 'test-secret\n', 'https://sch.city-painter.com/', expires)
  for (const [field, variant] of [['lineOriginalUrl', 'original'], ['linePreviewUrl', 'preview']]) {
    const url = new URL(urls[field])
    assert.equal(url.searchParams.get('expires'), String(expires))
    assert.equal(url.searchParams.get('signature'), require('node:crypto').createHmac('sha256', 'test-secret\n').update(`drive-file-1:${variant}:${expires}`).digest('hex'))
  }
})

test('背景身分交換只回傳 ID token', async () => {
  let request = null
  const idToken = await exchangeCustomTokenForIdToken('custom-token', 'web-api-key', async (url, options) => {
    request = { url, options }
    return { ok: true, status: 200, json: async () => ({ idToken: 'firebase-id-token' }) }
  })
  assert.equal(idToken, 'firebase-id-token')
  assert.match(request.url, /signInWithCustomToken\?key=web-api-key$/)
  assert.deepEqual(JSON.parse(request.options.body), { token: 'custom-token', returnSecureToken: true })
})

test('背景完工呼叫既有 ERP API 並同時帶 Auth 與 App Check', async () => {
  let request = null
  const { payload } = await sendFulfillmentLineRequest({
    eventId: 'event-1',
    attachmentIds: ['image-1', 'image-2'],
    idToken: 'firebase-id-token',
    appCheckToken: 'limited-use-app-check-token',
    fetchImpl: async (url, options) => {
      request = { url, options }
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    },
  })
  assert.deepEqual(payload, { ok: true })
  assert.equal(request.url, 'https://erp.city-painter.com/api/line')
  assert.equal(request.options.headers.Authorization, 'Bearer firebase-id-token')
  assert.equal(request.options.headers['X-Firebase-AppCheck'], 'limited-use-app-check-token')
  assert.deepEqual(JSON.parse(request.options.body), {
    action: 'complete-order-fulfillment',
    eventId: 'event-1',
    attachmentIds: ['image-1', 'image-2'],
  })
})

test('完工重試採指數退避且最多一小時', () => {
  assert.equal(fulfillmentRetryDelayMs(1), 60_000)
  assert.equal(fulfillmentRetryDelayMs(3), 240_000)
  assert.equal(fulfillmentRetryDelayMs(20), 3_600_000)
})

function fulfillmentJob(overrides = {}) {
  return {
    uploaderUid: 'user-1',
    status: 'committed',
    attachment: { path: 'image-1' },
    target: {
      kind: 'calendar-event',
      uploadKind: 'event',
      completionMode: 'fulfillment',
      eventId: 'event-1',
      fulfillmentBatchId: 'batch-12345678',
      fulfillmentBatchSize: 2,
    },
    ...overrides,
  }
}

test('完工批次未達 expected 時等待且不具備送出條件', () => {
  assert.deepEqual(
    classifyFulfillmentBatchJobs([fulfillmentJob()], 'batch-12345678'),
    { state: 'waiting' },
  )
})

test('完工批次只有全部 committed 才產生一次完整附件清單', () => {
  const jobs = [
    fulfillmentJob(),
    fulfillmentJob({ attachment: { path: 'image-2' } }),
  ]
  assert.deepEqual(classifyFulfillmentBatchJobs(jobs, 'batch-12345678'), {
    state: 'ready',
    expectedSize: 2,
    eventId: 'event-1',
    uploaderUid: 'user-1',
    attachmentIds: ['image-1', 'image-2'],
  })
  assert.deepEqual(
    classifyFulfillmentBatchJobs([jobs[0], { ...jobs[1], status: 'ready' }], 'batch-12345678'),
    { state: 'waiting' },
  )
})

test('同批不同 event、uploader 或 size 一律拒絕', () => {
  const base = fulfillmentJob()
  const mismatches = [
    { ...fulfillmentJob({ attachment: { path: 'image-2' } }), target: { ...base.target, eventId: 'event-2' } },
    fulfillmentJob({ uploaderUid: 'user-2', attachment: { path: 'image-2' } }),
    { ...fulfillmentJob({ attachment: { path: 'image-2' } }), target: { ...base.target, fulfillmentBatchSize: 3 } },
  ]
  mismatches.forEach((mismatch) => {
    assert.deepEqual(classifyFulfillmentBatchJobs([base, mismatch], 'batch-12345678'), { state: 'invalid' })
  })
})

test('completed 與有效 lease 都不會再次取得送出權', () => {
  const now = Date.parse('2026-08-12T00:00:00.000Z')
  assert.equal(fulfillmentBatchLeaseDecision({ status: 'completed' }, now), 'terminal')
  assert.equal(fulfillmentBatchLeaseDecision({ status: 'processing', leaseUntil: new Date(now + 60_000) }, now), 'busy')
  assert.equal(fulfillmentBatchLeaseDecision({ status: 'processing', leaseUntil: new Date(now - 1) }, now), 'acquire')
})

test('暫時錯誤進入 retry，LINE warning 則終止自動重試並保留人工處理', () => {
  const now = Date.parse('2026-08-12T00:00:00.000Z')
  assert.deepEqual(fulfillmentFailureState(2, now), {
    status: 'retry',
    exhausted: false,
    nextAttemptAtMs: now + 120_000,
  })
  assert.equal(fulfillmentLineResultDecision({ sent: false, skipped: false }), 'retry')
  assert.equal(fulfillmentLineResultDecision({ skipped: true, lineWarning: '客戶尚未綁定 LINE' }), 'manual')
  assert.equal(fulfillmentLineResultDecision({ skipped: true, reason: 'notification_disabled' }), 'completed')
})

test('只接受完整的附件暫存路徑', () => {
  assert.deepEqual(
    parseStagingObjectPath('attachment-staging/user-1/job-1/original'),
    { uid: 'user-1', jobId: 'job-1', fileName: 'original' },
  )
  assert.equal(parseStagingObjectPath('attachment-staging/user-1/job-1'), null)
  assert.equal(parseStagingObjectPath('other/user-1/job-1/original'), null)
})

test('輸出檔名不沿用來源路徑且固定為 WebP', () => {
  assert.deepEqual(variantNames('../施工照片.JPG'), {
    image: '施工照片.webp',
    thumbnail: '施工照片-thumbnail.webp',
  })
})

test('圖片會產生 1920 與 360 上限的兩種 WebP', async () => {
  const input = await sharp({
    create: {
      width: 2400,
      height: 1200,
      channels: 3,
      background: '#336699',
    },
  }).jpeg().toBuffer()
  const [image, thumbnail] = await transformVariants(input)
  const [imageMetadata, thumbnailMetadata] = await Promise.all([
    sharp(image).metadata(),
    sharp(thumbnail).metadata(),
  ])

  assert.equal(imageMetadata.format, 'webp')
  assert.equal(imageMetadata.width, 1920)
  assert.equal(imageMetadata.height, 960)
  assert.equal(thumbnailMetadata.format, 'webp')
  assert.equal(thumbnailMetadata.width, 360)
  assert.equal(thumbnailMetadata.height, 180)
})

test('副檔名或 content type 無法掩飾無效圖片內容', async () => {
  await assert.rejects(
    assertDecodedImage(Buffer.from('not-an-image')),
    error => error.code === 'PERMANENT_JOB_ERROR' && error.message === '附件內容不是有效圖片',
  )
})

test('Drive 結果 ID 去重並兼容主要與舊欄位', () => {
  assert.deepEqual(resultFileIds({
    image: { path: 'image-1' },
    webp: { id: 'image-1' },
    thumbnail: { path: 'thumb-1' },
  }), ['image-1', 'thumb-1'])
})

test('留言附件結果包含 WebP、縮圖與冪等工作識別碼', () => {
  const attachment = calendarAttachmentFromJobResult('job-1', {
    uploadedByUid: 'user-1',
    uploadedByEmployeeNo: 'C100001',
    uploadedByName: '小明',
    original: { name: '留言照片.jpg', size: 4096 },
    capture: { capturedAtSource: 'unknown' },
  }, {
    image: { path: 'image-1', name: '留言照片.webp', size: 2048, type: 'image/webp' },
    thumbnail: { path: 'thumb-1' },
  })
  assert.equal(attachment.path, 'image-1')
  assert.equal(attachment.thumbnailPath, 'thumb-1')
  assert.equal(attachment.uploadJobId, 'job-1')
  assert.equal(attachment.uploadedByUid, 'user-1')
  assert.equal(attachment.uploadedByEmployeeNo, 'C100001')
  assert.equal(attachment.uploadedByName, '小明')
})

test('舊背景工作不以 uploader 欄位猜測上傳人姓名', () => {
  const attachment = calendarAttachmentFromJobResult('legacy-job-1', {
    uploaderUid: 'legacy-user',
    uploaderEmployeeId: 'legacy-employee',
    original: { name: '舊照片.jpg', size: 1024 },
  }, {
    image: { path: 'legacy-image-1', name: '舊照片.webp', size: 512, type: 'image/webp' },
  })
  assert.equal(attachment.uploadedByUid, undefined)
  assert.equal(attachment.uploadedByEmployeeNo, undefined)
  assert.equal(attachment.uploadedByName, undefined)
})

test('留言附件提交會在同一交易去重並完成工作', async () => {
  const jobRef = { path: 'attachmentUploadJobs/job-1' }
  const commentRef = { path: 'calendarEvents/event-1/comments/comment-1' }
  const records = new Map([
    [jobRef.path, {
      status: 'ready',
      uploaderUid: 'user-1',
      original: { name: '留言照片.jpg', size: 4096 },
      target: { kind: 'calendar-event', uploadKind: 'comment', eventId: 'event-1', commentId: 'comment-1' },
      result: {
        image: { path: 'image-1', name: '留言照片.webp', size: 2048, type: 'image/webp' },
        thumbnail: { path: 'thumb-1' },
      },
    }],
    [commentRef.path, { authorUid: 'user-1', attachments: [], pendingAttachmentCount: 1 }],
  ])
  const snapshot = ref => ({ exists: records.has(ref.path), data: () => records.get(ref.path) })
  const db = {
    collection: name => ({
      doc: id => ({
        path: `${name}/${id}`,
        collection: child => ({ doc: childId => ({ path: `${name}/${id}/${child}/${childId}` }) }),
      }),
    }),
    runTransaction: async callback => callback({
      get: async ref => snapshot(ref),
      update: (ref, patch) => records.set(ref.path, { ...records.get(ref.path), ...patch }),
    }),
  }

  await commitCalendarCommentAttachment(db, jobRef, 'job-1', records.get(jobRef.path))
  await commitCalendarCommentAttachment(db, jobRef, 'job-1', records.get(jobRef.path))

  assert.equal(records.get(commentRef.path).attachments.length, 1)
  assert.equal(records.get(commentRef.path).pendingAttachmentCount, 0)
  assert.equal(records.get(jobRef.path).status, 'committed')
})

test('只有逾期且未 committed 的工作需要清理', () => {
  const now = Date.parse('2026-08-01T00:00:00.000Z')
  const old = new Date(now - CLEANUP_AGE_MS - 1)
  assert.equal(shouldCleanupJob({ status: 'created', createdAt: old }, now), true)
  assert.equal(shouldCleanupJob({ status: 'failed', failedAt: old }, now), true)
  assert.equal(shouldCleanupJob({ status: 'ready', processedAt: old }, now), true)
  assert.equal(shouldCleanupJob({ status: 'processing', processingStartedAt: old }, now), true)
  assert.equal(shouldCleanupJob({
    status: 'processing',
    processingStartedAt: old,
    processingLeaseUntil: new Date(now + 60_000),
  }, now), false)
  assert.equal(shouldCleanupJob({ status: 'committed', processedAt: old }, now), false)
  assert.equal(shouldCleanupJob({ status: 'ready', processedAt: new Date(now) }, now), false)
})

test('逾期清理會刪除暫存與 Drive 變體並標記 expired', async () => {
  const now = new Date('2026-08-01T00:00:00.000Z')
  const deletedStorage = []
  const deletedDrive = []
  const patches = []
  const document = {
    id: 'job-1',
    data: () => ({
      status: 'ready',
      uploaderUid: 'user-1',
      stagingPath: 'attachment-staging/user-1/job-1/original',
      processedAt: new Date(now.getTime() - CLEANUP_AGE_MS - 1),
      result: {
        image: { path: 'image-1' },
        thumbnail: { path: 'thumb-1' },
      },
    }),
    ref: {
      set: async patch => patches.push(patch),
    },
  }
  const db = {
    runTransaction: async callback => callback({
      get: async () => ({ exists: true, data: document.data }),
      set: () => {},
    }),
    collection: () => ({
      where: () => ({
        limit: () => ({
          get: async () => ({ docs: [document], size: 1 }),
        }),
      }),
    }),
  }
  const bucket = {
    file: name => ({
      delete: async () => deletedStorage.push(name),
    }),
  }
  const drive = {
    files: {
      delete: async ({ fileId }) => deletedDrive.push(fileId),
    },
  }

  const result = await cleanupExpiredJobs({ db, bucket, drive, now })

  assert.deepEqual(result, { scanned: 1, cleaned: 1 })
  assert.deepEqual(deletedStorage, ['attachment-staging/user-1/job-1/original'])
  assert.deepEqual(deletedDrive, ['image-1', 'thumb-1'])
  assert.equal(patches[0].status, 'expired')
})

function automaticSalesJob(overrides = {}) {
  return {
    status: 'ready', autoCommitSalesAttachment: true, uploaderUid: 'employee-1',
    target: { kind: 'sales', salesId: 'sales-1' },
    stagingPath: 'attachment-staging/employee-1/job-123456789/original',
    ...overrides,
  }
}

function salesCommitOptions(fetchImpl) {
  return {
    jobRef: { set: async () => {} }, job: automaticSalesJob(), jobId: 'job-123456789',
    auth: { createCustomToken: async (uid) => { assert.equal(uid, 'employee-1'); return 'custom-token' } },
    appCheck: { createToken: async () => ({ token: 'app-check' }) },
    apiKey: 'web-key', appId: 'web-app', fetchImpl,
  }
}

test('銷貨背景提交沿用既有 API 並忽略工作內提供的網址，不發 LINE', async () => {
  const { commitSalesAttachmentInBackground } = require('./backgroundAttachmentWorker')
  const requests = []
  const options = salesCommitOptions(async (url, request) => {
    requests.push({ url, request })
    return { ok: true, status: 200, json: async () => requests.length === 1 ? { idToken: 'id-token' } : { committed: true } }
  })
  options.job.target.url = 'https://invalid.example/api/line'
  assert.deepEqual(await commitSalesAttachmentInBackground(options), { committed: true })
  assert.equal(requests[1].url, 'https://erp.city-painter.com/api/upload-drive')
  assert.equal(requests[1].request.headers.Authorization, 'Bearer id-token')
  assert.equal(requests[1].request.headers['X-Firebase-AppCheck'], 'app-check')
  assert.deepEqual(JSON.parse(requests[1].request.body), { action: 'finalize-attachment-upload-job', jobId: 'job-123456789' })
})

test('ERP 拒絕或網路未知結果保留 ready 狀態與原檔', async () => {
  const { commitSalesAttachmentInBackground } = require('./backgroundAttachmentWorker')
  for (const failure of [403, 500, 'timeout']) {
    const writes = []
    const options = salesCommitOptions(async (url) => {
      if (url.includes('identitytoolkit')) return { ok: true, json: async () => ({ idToken: 'id-token' }) }
      if (failure === 'timeout') throw new Error('timeout')
      return { ok: false, status: failure, json: async () => ({}) }
    })
    options.jobRef.set = async (data) => writes.push(data)
    await assert.rejects(commitSalesAttachmentInBackground(options))
    assert.equal(writes.length, 1)
    assert.equal('status' in writes[0], false)
    assert.match(writes[0].commitError, /照片已保留/)
  }
})

test('新銷貨背景工作不因七天清理遺失，舊工作維持期限', () => {
  const old = new Date(Date.now() - CLEANUP_AGE_MS - 1000)
  for (const status of ['created', 'processing', 'failed', 'ready']) {
    const job = automaticSalesJob({ status, createdAt: old, processedAt: old, failedAt: old })
    assert.equal(shouldCleanupJob(job), false)
    assert.equal(shouldCleanupJob({ ...job, autoCommitSalesAttachment: false }), true)
  }
})

test('關頁後排程提交成功才刪原圖，失敗不刪且下一輪可恢復', async () => {
  const { recoverReadySalesAttachments } = require('./backgroundAttachmentWorker')
  const deleted = []
  const writes = []
  let shouldFail = true
  const job = automaticSalesJob()
  const ref = { set: async (data) => writes.push(data) }
  const options = salesCommitOptions(async (url) => {
    if (url.includes('identitytoolkit')) return { ok: true, json: async () => ({ idToken: 'id-token' }) }
    return { ok: !shouldFail, status: shouldFail ? 503 : 200, json: async () => ({ committed: !shouldFail }) }
  })
  const params = {
    ...options,
    db: { collection: () => ({ where: () => ({ limit: () => ({ get: async () => ({ docs: [{ id: 'job-123456789', ref, data: () => job }] }) }) }) }) },
    bucket: { file: (path) => ({ delete: async () => deleted.push(path) }) },
  }
  await recoverReadySalesAttachments(params)
  assert.equal(deleted.length, 0)
  shouldFail = false
  await recoverReadySalesAttachments(params)
  assert.deepEqual(deleted, [job.stagingPath])
  assert.equal(writes.at(-1).autoCommitSalesAttachment, false)
})

test('銷貨已 committed 但索引失敗仍重送 API，成功才刪原圖並清除錯誤', async () => {
  const { recoverReadySalesAttachments } = require('./backgroundAttachmentWorker')
  const writes = []
  const deleted = []
  let requests = 0
  let failIndex = true
  const job = automaticSalesJob({ status: 'committed', commitError: '索引待同步' })
  const ref = { set: async (data) => writes.push(data) }
  const options = salesCommitOptions(async (url) => {
    if (url.includes('identitytoolkit')) return { ok: true, json: async () => ({ idToken: 'id-token' }) }
    requests += 1
    return { ok: !failIndex, status: failIndex ? 500 : 200, json: async () => ({ committed: !failIndex }) }
  })
  const params = {
    ...options,
    db: { collection: () => ({ where: () => ({ limit: () => ({ get: async () => ({ docs: [{ id: 'job-123456789', ref, data: () => job }] }) }) }) }) },
    bucket: { file: (path) => ({ delete: async () => deleted.push(path) }) },
  }
  await recoverReadySalesAttachments(params)
  assert.equal(requests, 1)
  assert.equal(deleted.length, 0)
  assert.equal(writes.some((data) => data.autoCommitSalesAttachment === false), false)
  failIndex = false
  await recoverReadySalesAttachments(params)
  assert.equal(requests, 2)
  assert.deepEqual(deleted, [job.stagingPath])
  assert.equal(writes.some((data) => data.commitError?.constructor.name === 'DeleteTransform'), true)
  assert.equal(writes.at(-1).autoCommitSalesAttachment, false)
})

test('背景銷貨查詢每頁至多一百筆並翻頁，查詢失敗不阻斷後續排程', async () => {
  const { recoverReadySalesAttachments } = require('./backgroundAttachmentWorker')
  const docs = Array.from({ length: 100 }, (_, index) => ({ id: `job-${index}`, data: () => automaticSalesJob({ status: 'created' }) }))
  let pages = 0
  let cursor = null
  const query = {
    where: (field, op, value) => { assert.deepEqual([field, op, value], ['autoCommitSalesAttachment', '==', true]); return query },
    limit: (n) => { assert.equal(n, 100); return query },
    startAfter: (document) => { cursor = document; return query },
    get: async () => { pages += 1; if (pages === 2) throw new Error('temporary query failure'); return { docs } },
  }
  await assert.doesNotReject(recoverReadySalesAttachments({ db: { collection: () => query }, bucket: {} }))
  assert.equal(pages, 2)
  assert.equal(cursor, docs.at(-1))
})

function automaticCalendarJob(overrides = {}) {
  return {
    ...automaticSalesJob(), autoCommitSalesAttachment: false, autoCommitCalendarAttachment: true,
    target: { kind: 'calendar-event', uploadKind: 'event', eventId: 'event-1', completionMode: 'none' },
    ...overrides,
  }
}

test('普通與製作照片只提交行事曆 API，草稿與完工不走此路徑', async () => {
  const { commitCalendarAttachmentInBackground, isAutomaticCalendarAttachment } = require('./backgroundAttachmentWorker')
  for (const completionMode of ['none', 'production']) {
    const requests = []
    const options = salesCommitOptions(async (url, request) => {
      requests.push({ url, request })
      return { ok: true, status: 200, json: async () => requests.length === 1 ? { idToken: 'id-token' } : { committed: true } }
    })
    options.job = automaticCalendarJob()
    options.job.target.completionMode = completionMode
    options.job.target.url = 'https://invalid.example/api/upload-drive'
    assert.deepEqual(await commitCalendarAttachmentInBackground(options), { committed: true })
    assert.equal(requests[1].url, 'https://sch.city-painter.com/api/upload-drive')
    assert.equal(requests[1].request.headers['X-Firebase-AppCheck'], 'app-check')
    assert.equal(requests[1].request.headers.Authorization, 'Bearer id-token')
    assert.deepEqual(JSON.parse(requests[1].request.body), { action: 'finalize-attachment-upload-job', jobId: 'job-123456789' })
  }
  for (const target of [
    { kind: 'calendar-event', uploadKind: 'draft-event', eventId: 'draft-1' },
    { kind: 'calendar-event', uploadKind: 'event', eventId: '', completionMode: 'none' },
    { kind: 'calendar-event', uploadKind: 'event', eventId: 'event-1', completionMode: 'fulfillment' },
  ]) {
    assert.equal(isAutomaticCalendarAttachment(automaticCalendarJob({ target })), false)
  }
})

test('行事曆關頁恢復遇已 committed 但 API 失敗仍保留原圖，下一輪成功才清除', async () => {
  const { recoverReadyCalendarAttachments } = require('./backgroundAttachmentWorker')
  const deleted = []
  const writes = []
  let fail = true
  let apiRequests = 0
  const job = automaticCalendarJob({ status: 'committed' })
  const options = salesCommitOptions(async (url) => {
    if (url.includes('identitytoolkit')) return { ok: true, json: async () => ({ idToken: 'id-token' }) }
    apiRequests += 1
    assert.equal(url, 'https://sch.city-painter.com/api/upload-drive')
    return { ok: !fail, status: fail ? 500 : 200, json: async () => ({ committed: !fail }) }
  })
  const ref = { set: async (data) => writes.push(data) }
  const params = {
    ...options,
    db: { collection: () => ({ where: (field) => ({ limit: () => ({ get: async () => ({ docs: field === 'status' ? [] : [{ id: 'job-123456789', ref, data: () => job }] }) }) }) }) },
    bucket: { file: (path) => ({ delete: async () => deleted.push(path) }) },
  }
  await recoverReadyCalendarAttachments(params)
  assert.equal(deleted.length, 0)
  assert.equal(writes.some(data => data.autoCommitCalendarAttachment === false), false)
  fail = false
  await recoverReadyCalendarAttachments(params)
  assert.equal(apiRequests, 2)
  assert.deepEqual(deleted, [job.stagingPath])
  assert.equal(writes.at(-1).autoCommitCalendarAttachment, false)
})

test('等待提交的普通、留言及完工照片不被七天清理，草稿仍維持期限', () => {
  const createdAt = new Date(Date.now() - CLEANUP_AGE_MS - 1000)
  const job = automaticCalendarJob({ createdAt })
  assert.equal(shouldCleanupJob(job), false)
  assert.equal(shouldCleanupJob({ ...job, autoCommitCalendarAttachment: false, target: { kind: 'calendar-event', uploadKind: 'comment' } }), false)
  assert.equal(shouldCleanupJob({ ...job, autoCommitCalendarAttachment: false, target: { kind: 'calendar-event', fulfillmentBatchId: 'batch-12345678' } }), false)
  assert.equal(shouldCleanupJob({ ...job, target: { kind: 'calendar-event', uploadKind: 'draft-event' } }), true)
})

test('Storage 重入必須等行事曆提交成功才刪原圖，草稿 ready 不刪除', async () => {
  const { processAttachmentUpload } = require('./backgroundAttachmentWorker')
  for (const mode of ['failure', 'success', 'draft']) {
    const deleted = []
    const job = automaticCalendarJob()
    if (mode === 'draft') job.target.uploadKind = 'draft-event'
    const opts = salesCommitOptions(async (url) => {
      if (url.includes('identitytoolkit')) return { ok: true, json: async () => ({ idToken: 'id-token' }) }
      return { ok: mode === 'success', status: mode === 'success' ? 200 : 503, json: async () => ({ committed: mode === 'success' }) }
    })
    const db = {
      collection: () => ({ doc: () => ({ set: async () => {} }) }),
      runTransaction: async (callback) => callback({ get: async () => ({ exists: true, data: () => job }) }),
    }
    const pending = processAttachmentUpload({
      db, bucket: { file: (path) => ({ delete: async () => deleted.push(path) }) },
      objectData: { name: job.stagingPath, contentType: 'image/jpeg', size: 24_000, metadata: { jobId: 'job-123456789' } },
      eventId: 'storage-event', fulfillmentOptions: opts,
    })
    if (mode === 'failure') await assert.rejects(pending)
    else assert.equal((await pending).terminalStatus, mode === 'success' ? 'committed' : 'ready')
    assert.equal(deleted.length, mode === 'success' ? 1 : 0)
  }
})

test('留言 ready 排程恢復完成交易後才清原圖，不呼叫外部通知', async () => {
  const { recoverReadyCalendarAttachments } = require('./backgroundAttachmentWorker')
  const deleted = []
  const job = automaticCalendarJob({
    target: { kind: 'calendar-event', uploadKind: 'comment', eventId: 'event-1', commentId: 'comment-1' },
    result: { image: { path: 'image-1' }, thumbnail: { path: 'thumb-1' } },
  })
  const comment = { authorUid: job.uploaderUid, attachments: [], pendingAttachmentCount: 1 }
  const records = new Map([['attachmentUploadJobs/job-123456789', job], ['calendarEvents/event-1/comments/comment-1', comment]])
  const makeRef = (path) => ({ path, set: async patch => records.set(path, { ...records.get(path), ...patch }), collection: child => ({ doc: id => makeRef(`${path}/${child}/${id}`) }) })
  const ref = makeRef('attachmentUploadJobs/job-123456789')
  const db = {
    collection: name => ({
      doc: id => makeRef(`${name}/${id}`),
      where: field => ({ limit: () => ({ get: async () => ({ docs: records.get(ref.path)[field] === (field === 'status' ? 'ready' : true) ? [{ id: 'job-123456789', ref, data: () => records.get(ref.path) }] : [] }) }) }),
    }),
    runTransaction: async callback => callback({
      get: async ref => ({ exists: records.has(ref.path), data: () => records.get(ref.path) }),
      update: (ref, patch) => records.set(ref.path, { ...records.get(ref.path), ...patch }),
    }),
  }
  await recoverReadyCalendarAttachments({ db, bucket: { file: path => ({ delete: async () => { assert.equal(records.get(ref.path).status, 'committed'); deleted.push(path) } }) }, fetchImpl: async () => assert.fail('留言恢復不可發送通知') })
  assert.equal(records.get('calendarEvents/event-1/comments/comment-1').attachments.length, 1)
  assert.deepEqual(deleted, [job.stagingPath])
  assert.equal(records.get(ref.path).autoCommitCalendarAttachment, false)
})


test('合併配達工作保存相同訂單快照與固定請求識別碼，重試不變更', async () => {
  const fulfillmentOrders = [
    { eventId: 'event-1', salesId: 'sale-1', expectedShippingMethod: '外送', expectedOrderStatus: '即將配送' },
    { eventId: 'event-2', salesId: 'sale-2', expectedShippingMethod: '外送', expectedOrderStatus: '即將配送' },
  ]
  const sent = []
  for (let index = 0; index < 2; index += 1) {
    await sendFulfillmentLineRequest({
      eventId: 'event-1', attachmentIds: ['photo-1'], fulfillmentOrders, fulfillmentRequestId: 'request-12345678',
      idToken: 'test', appCheckToken: 'test',
      fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return { json: async () => ({ ok: true }) } },
    })
  }
  assert.deepEqual(sent[0], sent[1])
  assert.deepEqual(sent[0].orders, fulfillmentOrders)
  assert.equal(sent[0].batchId, 'request-12345678')
  const jobs = [1, 2].map(index => ({
    status: 'committed', uploaderUid: 'user-1', attachment: { path: `photo-${index}` },
    target: { eventId: 'event-1', completionMode: 'fulfillment', uploadKind: 'event', fulfillmentBatchId: 'batch-12345678', fulfillmentBatchSize: 2, fulfillmentOrders, fulfillmentRequestId: 'request-12345678' },
  }))
  assert.equal(classifyFulfillmentBatchJobs(jobs, 'batch-12345678').state, 'ready')
  assert.deepEqual(classifyFulfillmentBatchJobs(jobs, 'batch-12345678').fulfillmentOrders, fulfillmentOrders)
  jobs[1].target = { ...jobs[1].target, fulfillmentRequestId: 'different-12345678' }
  assert.equal(classifyFulfillmentBatchJobs(jobs, 'batch-12345678').state, 'invalid')
})


test('關頁後建立的合併配達重試仍保留 lifecycle 快照與整批識別碼', async () => {
  const jobRef = { path: 'attachmentUploadJobs/job-batch' }
  const orders = [
    { eventId: 'event-1', salesId: 'sale-1', expectedShippingMethod: '外送', expectedOrderStatus: '即將配送' },
    { eventId: 'event-2', salesId: 'sale-2', expectedShippingMethod: '外送', expectedOrderStatus: '即將配送' },
  ]
  const records = new Map([
    [jobRef.path, { status: 'committed', uploaderUid: 'employee-1', attachment: { path: 'photo-1' }, target: {
      kind: 'calendar-event', uploadKind: 'event', completionMode: 'fulfillment', eventId: 'event-1',
      fulfillmentBatchId: 'photos-12345678', fulfillmentBatchSize: 1,
      fulfillmentRequestId: 'request-12345678', fulfillmentOrders: orders,
    } }],
    ['calendarEvents/event-1', { attachments: [] }],
  ])
  const db = {
    collection: name => ({ doc: id => ({ path: `${name}/${id}` }) }),
    runTransaction: async callback => callback({
      get: async ref => ({ exists: records.has(ref.path), data: () => records.get(ref.path) }),
      update: (ref, patch) => records.set(ref.path, { ...records.get(ref.path), ...patch }),
      set: (ref, patch) => records.set(ref.path, { ...records.get(ref.path), ...patch }),
    }),
  }
  await commitCalendarEventFulfillmentAttachment(db, jobRef, 'job-batch')
  const retry = records.get('calendarEvents/event-1').productionLineRetry
  assert.equal(retry.shippingMethod, '外送')
  assert.equal(retry.orderStatus, '即將配送')
  assert.equal(retry.fulfillmentRequestId, 'request-12345678')
  assert.equal(retry.fulfillmentSourceEventId, 'event-1')
  assert.deepEqual(retry.fulfillmentOrders, orders)
})
