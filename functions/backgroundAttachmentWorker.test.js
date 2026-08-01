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
  cleanupExpiredJobs,
  parseStagingObjectPath,
  resultFileIds,
  shouldCleanupJob,
  transformVariants,
  variantNames,
} = require('./backgroundAttachmentWorker')

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
