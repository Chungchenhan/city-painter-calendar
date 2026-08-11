const path = require('node:path')
const { Readable } = require('node:stream')
const admin = require('firebase-admin')
const { google } = require('googleapis')
const sharp = require('sharp')
const { defineSecret, defineString } = require('firebase-functions/params')
const { onSchedule } = require('firebase-functions/v2/scheduler')
const { onObjectFinalized } = require('firebase-functions/v2/storage')

const STAGING_PREFIX = 'attachment-staging/'
const MAX_SOURCE_BYTES = 50 * 1024 * 1024
const CLEANUP_AGE_MS = 7 * 24 * 60 * 60 * 1000
const PROCESSING_LEASE_MS = 10 * 60 * 1000
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder'
const WEBP_MIME_TYPE = 'image/webp'
const DEFAULT_CALENDAR_FOLDER_ID = '1aqx7A8VwTKBSltaEj0IFoOXQP4HUJWF4'
const DEFAULT_SALES_FOLDER_ID = '1MXBZgnLfaKm6Nk6yoxES4ppDh6R74diy'
const DEFAULT_STORAGE_BUCKET = 'city-painter-erp.firebasestorage.app'

const driveOAuthClientId = defineSecret('GOOGLE_DRIVE_OAUTH_CLIENT_ID')
const driveOAuthClientSecret = defineSecret('GOOGLE_DRIVE_OAUTH_CLIENT_SECRET')
const driveOAuthRefreshToken = defineSecret('GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN')
const calendarFolderId = defineString('GOOGLE_DRIVE_CALENDAR_FOLDER_ID', {
  default: DEFAULT_CALENDAR_FOLDER_ID,
})
const salesFolderId = defineString('GOOGLE_DRIVE_SALES_FOLDER_ID', {
  default: DEFAULT_SALES_FOLDER_ID,
})
const driveSecrets = [driveOAuthClientId, driveOAuthClientSecret, driveOAuthRefreshToken]

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function permanentError(message) {
  return Object.assign(new Error(message), { code: 'PERMANENT_JOB_ERROR' })
}

function parseStagingObjectPath(objectName) {
  const parts = text(objectName).split('/')
  if (parts.length !== 4 || parts[0] !== 'attachment-staging') return null
  const [, uid, jobId, fileName] = parts
  if (!uid || !jobId || !fileName) return null
  return { uid, jobId, fileName }
}

function safeWebpBaseName(originalName) {
  const parsed = path.posix.parse(path.posix.basename(text(originalName) || 'image'))
  const base = (parsed.name || 'image')
    .replace(/[\u0000-\u001f/\\]/g, '-')
    .slice(0, 160)
  return base || 'image'
}

function variantNames(originalName) {
  const base = safeWebpBaseName(originalName)
  return {
    image: `${base}.webp`,
    thumbnail: `${base}-thumbnail.webp`,
  }
}

function escapeDriveQuery(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function timestampMillis(value) {
  if (!value) return 0
  if (typeof value.toMillis === 'function') return value.toMillis()
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}

function resultFileIds(result) {
  const candidates = [
    result?.image?.path,
    result?.image?.id,
    result?.webp?.path,
    result?.webp?.id,
    result?.thumbnail?.path,
    result?.thumbnail?.id,
    result?.thumb?.path,
    result?.thumb?.id,
  ]
  return Array.from(new Set(candidates.map(text).filter(Boolean)))
}

function cleanupReferenceTime(job) {
  if (job.status === 'ready') return timestampMillis(job.processedAt) || timestampMillis(job.updatedAt) || timestampMillis(job.createdAt)
  if (job.status === 'failed') return timestampMillis(job.failedAt) || timestampMillis(job.updatedAt) || timestampMillis(job.createdAt)
  if (job.status === 'processing') return timestampMillis(job.processingStartedAt) || timestampMillis(job.updatedAt) || timestampMillis(job.createdAt)
  return timestampMillis(job.createdAt) || timestampMillis(job.updatedAt)
}

function shouldCleanupJob(job, nowMs = Date.now()) {
  if (!['created', 'failed', 'processing', 'ready'].includes(job?.status)) return false
  if (job.status === 'processing' && timestampMillis(job.processingLeaseUntil) > nowMs) return false
  const referenceTime = cleanupReferenceTime(job)
  return referenceTime > 0 && nowMs - referenceTime >= CLEANUP_AGE_MS
}

function createDriveClient() {
  const clientId = driveOAuthClientId.value()
  const clientSecret = driveOAuthClientSecret.value()
  const refreshToken = driveOAuthRefreshToken.value()
  if (!clientId || !clientSecret || !refreshToken) throw new Error('Google Drive OAuth 尚未設定')
  const auth = new google.auth.OAuth2(clientId, clientSecret)
  auth.setCredentials({ refresh_token: refreshToken })
  return google.drive({ version: 'v3', auth })
}

async function makeDriveFilePublic(drive, fileId) {
  try {
    await drive.permissions.create({
      fileId,
      requestBody: { type: 'anyone', role: 'reader' },
      supportsAllDrives: true,
    })
    return true
  } catch {
    // 部分共用雲端硬碟禁止公開連結，附件仍可由既有簽名代理安全讀取。
    return false
  }
}

async function findOrCreateSalesFolder(drive, rootFolderId, folderName) {
  const list = await drive.files.list({
    q: [
      `'${escapeDriveQuery(rootFolderId)}' in parents`,
      `mimeType='${FOLDER_MIME_TYPE}'`,
      `name='${escapeDriveQuery(folderName)}'`,
      'trashed=false',
    ].join(' and '),
    fields: 'files(id,name,webViewLink)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })
  const existing = list.data.files?.[0]
  if (existing?.id) {
    return {
      id: existing.id,
      url: existing.webViewLink || `https://drive.google.com/drive/folders/${existing.id}`,
    }
  }

  const created = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: FOLDER_MIME_TYPE,
      parents: [rootFolderId],
    },
    fields: 'id,webViewLink',
    supportsAllDrives: true,
  })
  if (!created.data.id) throw new Error('Google Drive 未回傳資料夾 ID')
  return {
    id: created.data.id,
    url: created.data.webViewLink || `https://drive.google.com/drive/folders/${created.data.id}`,
  }
}

async function resolveDriveFolder(drive, target, configuredFolders) {
  if (target.kind === 'calendar-event') {
    const id = text(configuredFolders.calendar)
    if (!id) throw new Error('行事曆附件資料夾尚未設定')
    return { id, url: `https://drive.google.com/drive/folders/${id}` }
  }
  if (target.kind !== 'sales') throw permanentError('不支援的附件目標')

  const requestedFolderId = text(target.driveFolderId)
  if (requestedFolderId) {
    return {
      id: requestedFolderId,
      url: `https://drive.google.com/drive/folders/${requestedFolderId}`,
    }
  }
  const salesNo = text(target.salesNo)
  if (!salesNo) throw permanentError('銷貨附件缺少銷貨單號')
  return findOrCreateSalesFolder(drive, configuredFolders.sales, salesNo.slice(0, 200))
}

async function transformVariants(input) {
  return Promise.all([
    sharp(input, { limitInputPixels: 120_000_000 })
      .rotate()
      .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 })
      .toBuffer(),
    sharp(input, { limitInputPixels: 120_000_000 })
      .rotate()
      .resize({ width: 360, height: 360, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 72, effort: 4 })
      .toBuffer(),
  ])
}

async function assertDecodedImage(input) {
  try {
    const metadata = await sharp(input, { limitInputPixels: 120_000_000 }).metadata()
    if (!metadata.format || !metadata.width || !metadata.height || metadata.format === 'svg') {
      throw new Error('invalid image')
    }
  } catch {
    throw permanentError('附件內容不是有效圖片')
  }
}

async function deleteDriveFile(drive, fileId) {
  try {
    await drive.files.delete({ fileId, supportsAllDrives: true })
  } catch (error) {
    if (Number(error?.code) === 404 || Number(error?.response?.status) === 404) return
    throw error
  }
}

async function uploadVariant(drive, {
  buffer,
  fileName,
  folderId,
  job,
  jobId,
  variant,
  makePublic,
  now,
}) {
  let createdId = ''
  try {
    const created = await drive.files.create({
      requestBody: {
        name: fileName,
        mimeType: WEBP_MIME_TYPE,
        parents: [folderId],
        appProperties: {
          attachmentUploadJobId: jobId,
          attachmentUploadVariant: variant,
          attachmentUploaderUid: text(job.uploaderUid).slice(0, 120),
          attachmentTargetKind: text(job.target?.kind).slice(0, 40),
        },
      },
      media: {
        mimeType: WEBP_MIME_TYPE,
        body: Readable.from(buffer),
      },
      fields: 'id,name,mimeType,size,createdTime,webViewLink',
      supportsAllDrives: true,
    })
    createdId = text(created.data.id)
    if (!createdId) throw new Error('Google Drive 未回傳檔案 ID')
    if (makePublic) await makeDriveFilePublic(drive, createdId)
    const url = text(created.data.webViewLink) || `https://drive.google.com/file/d/${createdId}/view`
    const uploadedAt = text(created.data.createdTime) || now.toISOString()
    return {
      path: createdId,
      id: createdId,
      url,
      webViewUrl: url,
      name: text(created.data.name) || fileName,
      size: Number(created.data.size) || buffer.length,
      type: WEBP_MIME_TYPE,
      uploadedAt,
    }
  } catch (error) {
    if (createdId) await deleteDriveFile(drive, createdId).catch(() => {})
    throw error
  }
}

function validateJob(job, parsedPath, objectData) {
  if (!job) throw permanentError('找不到附件上傳工作')
  if (text(job.uploaderUid) !== parsedPath.uid) throw permanentError('附件上傳者不一致')
  if (text(job.stagingPath) !== text(objectData.name)) throw permanentError('附件暫存路徑不一致')
  if (text(objectData.metadata?.jobId) !== parsedPath.jobId) throw permanentError('附件工作識別碼不一致')
  if (!['sales', 'calendar-event'].includes(job.target?.kind)) throw permanentError('附件目標不正確')
  const contentType = text(objectData.contentType)
  const size = Number(objectData.size)
  if (!contentType.startsWith('image/') || contentType === 'image/svg+xml') throw permanentError('附件格式不支援')
  if (!Number.isFinite(size) || size <= 0 || size > MAX_SOURCE_BYTES) throw permanentError('附件大小不符合限制')
}

async function acquireJob(db, jobRef, parsedPath, objectData, eventId, now) {
  let acquiredJob = null
  let terminalStatus = ''
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(jobRef)
    if (!snapshot.exists) throw permanentError('找不到附件上傳工作')
    const job = snapshot.data()
    validateJob(job, parsedPath, objectData)
    if (['ready', 'committed'].includes(job.status)) {
      terminalStatus = job.status
      return
    }
    if (!['created', 'failed', 'processing'].includes(job.status)) throw permanentError('附件上傳工作狀態不正確')
    if (job.status === 'processing' && timestampMillis(job.processingLeaseUntil) > now.getTime()) {
      const busyError = new Error('附件上傳工作正在處理')
      busyError.code = 'JOB_BUSY'
      throw busyError
    }
    acquiredJob = job
    transaction.set(jobRef, {
      status: 'processing',
      processingEventId: text(eventId),
      processingStartedAt: admin.firestore.FieldValue.serverTimestamp(),
      processingLeaseUntil: admin.firestore.Timestamp.fromMillis(now.getTime() + PROCESSING_LEASE_MS),
      attemptCount: admin.firestore.FieldValue.increment(1),
      error: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true })
  })
  return { job: acquiredJob, terminalStatus }
}

function publicErrorMessage(error) {
  const known = [
    '找不到附件上傳工作',
    '附件上傳者不一致',
    '附件暫存路徑不一致',
    '附件工作識別碼不一致',
    '附件目標不正確',
    '附件格式不支援',
    '附件大小不符合限制',
    '附件內容不是有效圖片',
    '附件上傳工作狀態不正確',
    '銷貨附件缺少銷貨單號',
    '不支援的附件目標',
  ]
  return known.includes(error?.message) ? error.message : '附件背景處理失敗，系統將自動重試'
}

async function processAttachmentUpload({ db, bucket, drive, objectData, eventId, configuredFolders, now = new Date() }) {
  const parsedPath = parseStagingObjectPath(objectData?.name)
  if (!parsedPath) return { ignored: true }
  const jobRef = db.collection('attachmentUploadJobs').doc(parsedPath.jobId)
  let job = null
  let readyWritten = false
  let partialResultWritten = false
  let newlyUploadedIds = []
  try {
    const acquired = await acquireJob(db, jobRef, parsedPath, objectData, eventId, now)
    if (acquired.terminalStatus) {
      await bucket.file(objectData.name).delete({ ignoreNotFound: true })
      return { terminalStatus: acquired.terminalStatus }
    }
    job = acquired.job
    const [input] = await bucket.file(objectData.name).download()
    await assertDecodedImage(input)
    const [imageBuffer, thumbnailBuffer] = await transformVariants(input)
    const folder = await resolveDriveFolder(drive, job.target, configuredFolders)
    const names = variantNames(job.original?.name || objectData.name)
    const currentResult = job.result && typeof job.result === 'object' ? job.result : {}
    const currentImage = currentResult.image || currentResult.webp || null
    const currentThumbnail = currentResult.thumbnail || currentResult.thumb || null
    const uploads = []
    if (!text(currentImage?.path || currentImage?.id)) {
      uploads.push({
        key: 'image',
        promise: uploadVariant(drive, {
          buffer: imageBuffer,
          fileName: names.image,
          folderId: folder.id,
          job,
          jobId: parsedPath.jobId,
          variant: 'image',
          makePublic: job.target.kind === 'calendar-event',
          now,
        }),
      })
    }
    if (!text(currentThumbnail?.path || currentThumbnail?.id)) {
      uploads.push({
        key: 'thumbnail',
        promise: uploadVariant(drive, {
          buffer: thumbnailBuffer,
          fileName: names.thumbnail,
          folderId: folder.id,
          job,
          jobId: parsedPath.jobId,
          variant: 'thumbnail',
          makePublic: job.target.kind === 'calendar-event',
          now,
        }),
      })
    }

    const settled = await Promise.allSettled(uploads.map(item => item.promise))
    const nextResult = {
      ...currentResult,
      driveFolderId: folder.id,
      driveFolderUrl: folder.url,
      ...(currentImage ? { image: currentImage } : {}),
      ...(currentThumbnail ? { thumbnail: currentThumbnail } : {}),
    }
    settled.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') nextResult[uploads[index].key] = outcome.value
    })
    if (nextResult.image) nextResult.webp = nextResult.image
    newlyUploadedIds = settled
      .filter(outcome => outcome.status === 'fulfilled')
      .map(outcome => outcome.value.path)
    await jobRef.set({ result: nextResult, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true })
    partialResultWritten = true

    const rejected = settled.find(outcome => outcome.status === 'rejected')
    if (rejected) throw rejected.reason
    if (!nextResult.image || !nextResult.thumbnail) throw new Error('附件轉檔結果不完整')

    await jobRef.set({
      status: 'ready',
      result: nextResult,
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      processingLeaseUntil: admin.firestore.FieldValue.delete(),
      processingEventId: admin.firestore.FieldValue.delete(),
      retrying: admin.firestore.FieldValue.delete(),
      error: admin.firestore.FieldValue.delete(),
    }, { merge: true })
    readyWritten = true
    await bucket.file(objectData.name).delete({ ignoreNotFound: true })
    return { status: 'ready', result: nextResult }
  } catch (error) {
    if (error?.code === 'JOB_BUSY') throw error
    if (readyWritten) throw error
    if (!partialResultWritten && newlyUploadedIds.length > 0) {
      await Promise.allSettled(newlyUploadedIds.map(fileId => deleteDriveFile(drive, fileId)))
    }
    if (job && error?.code === 'PERMANENT_JOB_ERROR') {
      await jobRef.set({
        status: 'failed',
        error: publicErrorMessage(error),
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        processingLeaseUntil: admin.firestore.FieldValue.delete(),
        processingEventId: admin.firestore.FieldValue.delete(),
        retrying: admin.firestore.FieldValue.delete(),
      }, { merge: true }).catch(() => {})
    } else if (job) {
      await jobRef.set({
        status: 'processing',
        retrying: true,
        error: '附件背景處理暫時中斷，系統正在重試',
        processingLeaseUntil: admin.firestore.Timestamp.fromMillis(Date.now() + 60 * 1000),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true }).catch(() => {})
    }
    console.error('附件背景處理失敗', {
      jobId: parsedPath.jobId,
      code: text(error?.code),
      message: publicErrorMessage(error),
    })
    if (error?.code === 'PERMANENT_JOB_ERROR') return { status: 'failed' }
    throw error
  }
}

async function cleanupExpiredJobs({ db, bucket, drive, now = new Date() }) {
  const snapshot = await db.collection('attachmentUploadJobs')
    .where('status', 'in', ['created', 'failed', 'processing', 'ready'])
    .limit(500)
    .get()
  let cleaned = 0
  for (const document of snapshot.docs) {
    const listedJob = document.data()
    if (!shouldCleanupJob(listedJob, now.getTime())) continue
    let job = null
    let previousStatus = ''
    try {
      await db.runTransaction(async (transaction) => {
        const current = await transaction.get(document.ref)
        if (!current.exists || !shouldCleanupJob(current.data(), now.getTime())) return
        job = current.data()
        previousStatus = job.status
        transaction.set(document.ref, {
          status: 'expiring',
          cleanupStartedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true })
      })
      if (!job) continue
      const stagingPath = text(job.stagingPath)
      if (stagingPath.startsWith(`${STAGING_PREFIX}${text(job.uploaderUid)}/${document.id}/`)) {
        await bucket.file(stagingPath).delete({ ignoreNotFound: true })
      }
      for (const fileId of resultFileIds(job.result)) await deleteDriveFile(drive, fileId)
      await document.ref.set({
        status: 'expired',
        expiredAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        cleanupError: admin.firestore.FieldValue.delete(),
      }, { merge: true })
      cleaned += 1
    } catch {
      await document.ref.set({
        ...(previousStatus ? { status: previousStatus } : {}),
        cleanupError: '附件逾期清理失敗，系統將自動重試',
        cleanupAttemptedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true }).catch(() => {})
    }
  }
  return { scanned: snapshot.size, cleaned }
}

const processStagedAttachment = onObjectFinalized({
  bucket: DEFAULT_STORAGE_BUCKET,
  region: 'us-east1',
  memory: '1GiB',
  timeoutSeconds: 540,
  retry: true,
  secrets: driveSecrets,
}, async (event) => {
  const objectData = event.data
  if (!parseStagingObjectPath(objectData?.name)) return
  await processAttachmentUpload({
    db: admin.firestore(),
    bucket: admin.storage().bucket(objectData.bucket || DEFAULT_STORAGE_BUCKET),
    drive: createDriveClient(),
    objectData,
    eventId: event.id,
    configuredFolders: {
      calendar: calendarFolderId.value(),
      sales: salesFolderId.value(),
    },
  })
})

const processPendingAttachments = onSchedule({
  schedule: 'every 1 minutes',
  timeZone: 'Asia/Taipei',
  region: 'us-east1',
  memory: '1GiB',
  timeoutSeconds: 540,
  secrets: driveSecrets,
}, async () => {
  const db = admin.firestore()
  const bucket = admin.storage().bucket(DEFAULT_STORAGE_BUCKET)
  const snapshot = await db.collection('attachmentUploadJobs')
    .where('status', 'in', ['created', 'processing'])
    .limit(10)
    .get()
  const drive = createDriveClient()
  const now = new Date()
  for (const document of snapshot.docs) {
    const job = document.data()
    if (job.status === 'processing' && timestampMillis(job.processingLeaseUntil) > now.getTime()) continue
    const stagingPath = text(job.stagingPath)
    if (!stagingPath) continue
    try {
      const [metadata] = await bucket.file(stagingPath).getMetadata()
      await processAttachmentUpload({
        db,
        bucket,
        drive,
        objectData: {
          name: text(metadata.name) || stagingPath,
          bucket: text(metadata.bucket) || DEFAULT_STORAGE_BUCKET,
          contentType: text(metadata.contentType),
          size: metadata.size,
          metadata: metadata.metadata || {},
        },
        eventId: `schedule-${Date.now()}-${document.id}`,
        configuredFolders: {
          calendar: calendarFolderId.value(),
          sales: salesFolderId.value(),
        },
      })
    } catch (error) {
      if (Number(error?.code) === 404) continue
      console.error('排程附件背景處理失敗', {
        jobId: document.id,
        code: text(error?.code),
        message: publicErrorMessage(error),
      })
    }
  }
})

const cleanupStagedAttachments = onSchedule({
  schedule: 'every day 03:30',
  timeZone: 'Asia/Taipei',
  region: 'asia-east1',
  timeoutSeconds: 540,
  secrets: driveSecrets,
}, async () => {
  await cleanupExpiredJobs({
    db: admin.firestore(),
    bucket: admin.storage().bucket(DEFAULT_STORAGE_BUCKET),
    drive: createDriveClient(),
  })
})

module.exports = {
  CLEANUP_AGE_MS,
  assertDecodedImage,
  cleanupExpiredJobs,
  makeDriveFilePublic,
  cleanupStagedAttachments,
  parseStagingObjectPath,
  processPendingAttachments,
  processAttachmentUpload,
  processStagedAttachment,
  resultFileIds,
  shouldCleanupJob,
  transformVariants,
  variantNames,
}
