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
  exchangeCustomTokenForIdToken,
  fulfillmentBatchDocumentId,
  fulfillmentBatchId,
  fulfillmentBatchLeaseDecision,
  fulfillmentBatchSize,
  fulfillmentFailureState,
  fulfillmentLineResultDecision,
  fulfillmentRetryDelayMs,
  lineImageUrls,
  makeDriveFilePublic,
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

test('LINE 圖片簽名保留金鑰尾端換行並相容既有固定向量', () => {
  const urls = lineImageUrls('drive-file-1', 'test-secret\n', 'https://sch.city-painter.com/')
  assert.equal(
    urls.lineOriginalUrl,
    'https://sch.city-painter.com/api/upload-drive?fileId=drive-file-1&variant=original&signature=19371d0305dc83e2989b1e16dbff51a015cef19b924751d06a4c5938e4aea45f',
  )
  assert.equal(
    urls.linePreviewUrl,
    'https://sch.city-painter.com/api/upload-drive?fileId=drive-file-1&variant=preview&signature=7e09206244a46f2632439f45a2f24589dbd6643c3c84392575b5d62f860413f6',
  )
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
    original: { name: '留言照片.jpg', size: 4096 },
    capture: { capturedAtSource: 'unknown' },
  }, {
    image: { path: 'image-1', name: '留言照片.webp', size: 2048, type: 'image/webp' },
    thumbnail: { path: 'thumb-1' },
  })
  assert.equal(attachment.path, 'image-1')
  assert.equal(attachment.thumbnailPath, 'thumb-1')
  assert.equal(attachment.uploadJobId, 'job-1')
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

test('雲端硬碟禁止公開連結時仍保留已上傳檔案', async () => {
  const result = await makeDriveFilePublic({
    permissions: {
      create: async () => { throw new Error('公開權限遭政策拒絕') },
    },
  }, 'image-1')
  assert.equal(result, false)
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
