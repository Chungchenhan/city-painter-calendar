const path = require('node:path')
const crypto = require('node:crypto')
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
const FULFILLMENT_LEASE_MS = 2 * 60 * 1000
const MAX_FULFILLMENT_ATTEMPTS = 10
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder'
const WEBP_MIME_TYPE = 'image/webp'
const DEFAULT_CALENDAR_FOLDER_ID = '1aqx7A8VwTKBSltaEj0IFoOXQP4HUJWF4'
const DEFAULT_SALES_FOLDER_ID = '1MXBZgnLfaKm6Nk6yoxES4ppDh6R74diy'
const DEFAULT_STORAGE_BUCKET = 'city-painter-erp.firebasestorage.app'
const DEFAULT_CALENDAR_PUBLIC_BASE_URL = 'https://sch.city-painter.com'
const DEFAULT_ERP_LINE_API_URL = 'https://erp.city-painter.com/api/line'

const driveOAuthClientId = defineSecret('GOOGLE_DRIVE_OAUTH_CLIENT_ID')
const driveOAuthClientSecret = defineSecret('GOOGLE_DRIVE_OAUTH_CLIENT_SECRET')
const driveOAuthRefreshToken = defineSecret('GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN')
const lineImageSigningSecret = defineSecret('LINE_IMAGE_SIGNING_SECRET')
const firebaseWebApiKey = defineString('CALENDAR_FIREBASE_WEB_API_KEY')
const firebaseWebAppId = defineString('CALENDAR_FIREBASE_WEB_APP_ID')
const calendarPublicBaseUrl = defineString('CALENDAR_PUBLIC_BASE_URL', {
  default: DEFAULT_CALENDAR_PUBLIC_BASE_URL,
})
const erpLineApiUrl = defineString('ERP_LINE_API_URL', {
  default: DEFAULT_ERP_LINE_API_URL,
})
const calendarFolderId = defineString('GOOGLE_DRIVE_CALENDAR_FOLDER_ID', {
  default: DEFAULT_CALENDAR_FOLDER_ID,
})
const salesFolderId = defineString('GOOGLE_DRIVE_SALES_FOLDER_ID', {
  default: DEFAULT_SALES_FOLDER_ID,
})
const driveSecrets = [driveOAuthClientId, driveOAuthClientSecret, driveOAuthRefreshToken]
const attachmentWorkerSecrets = [...driveSecrets, lineImageSigningSecret]

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function permanentError(message) {
  return Object.assign(new Error(message), { code: 'PERMANENT_JOB_ERROR' })
}

function retryableError(message) {
  return Object.assign(new Error(message), { code: 'RETRYABLE_FULFILLMENT_ERROR' })
}

function fulfillmentBatchId(job) {
  const value = text(job?.target?.fulfillmentBatchId)
  return /^[A-Za-z0-9-]{8,120}$/.test(value) ? value : ''
}

function fulfillmentBatchSize(job) {
  const value = Number(job?.target?.fulfillmentBatchSize)
  return Number.isSafeInteger(value) && value >= 1 && value <= 20 ? value : 0
}

function fulfillmentBatchDocumentId(batchId) {
  return crypto.createHash('sha256').update(batchId).digest('hex')
}

function lineImageUrls(fileId, signingSecret, baseUrl = DEFAULT_CALENDAR_PUBLIC_BASE_URL) {
  const secret = String(signingSecret || '')
  if (!secret) throw new Error('LINE 圖片簽名金鑰尚未設定')
  const root = (text(baseUrl) || DEFAULT_CALENDAR_PUBLIC_BASE_URL).replace(/\/$/, '')
  const url = (variant) => {
    const signature = crypto.createHmac('sha256', secret)
      .update(`${fileId}:${variant}`)
      .digest('hex')
    return `${root}/api/upload-drive?fileId=${encodeURIComponent(fileId)}&variant=${variant}&signature=${signature}`
  }
  return {
    lineOriginalUrl: url('original'),
    linePreviewUrl: url('preview'),
  }
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
          ...(job.target?.kind === 'calendar-event' ? {
            calendarUploadKind: text(job.target?.uploadKind) || 'event',
            calendarUploaderUid: text(job.uploaderUid).slice(0, 120),
            calendarEventId: text(job.target?.eventId).slice(0, 200),
            ...(text(job.target?.commentId) ? { calendarCommentId: text(job.target.commentId).slice(0, 200) } : {}),
          } : {}),
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

function calendarAttachmentFromJobResult(jobId, job, result, options = {}) {
  const image = result?.image || result?.webp || {}
  const thumbnail = result?.thumbnail || result?.thumb || {}
  const fileId = text(image.path || image.id)
  if (!fileId) throw permanentError('附件轉檔結果不完整')
  const originalName = text(job.original?.name) || text(image.name) || '照片'
  return {
    name: text(image.name) || variantNames(originalName).image,
    url: text(image.url) || `https://drive.google.com/file/d/${fileId}/view`,
    path: fileId,
    type: text(image.type) || WEBP_MIME_TYPE,
    size: Number(image.size) || 0,
    provider: 'google-drive',
    originalName,
    originalSize: Number(job.original?.size) || 0,
    optimized: true,
    ...(text(thumbnail.path || thumbnail.id) ? { thumbnailPath: text(thumbnail.path || thumbnail.id) } : {}),
    ...(text(image.uploadedAt) ? { uploadedAt: text(image.uploadedAt) } : {}),
    ...(text(job.capture?.capturedAt) ? { capturedAt: text(job.capture.capturedAt) } : {}),
    ...(text(job.capture?.capturedAtSource) ? { capturedAtSource: text(job.capture.capturedAtSource) } : {}),
    ...(job.capture?.location && typeof job.capture.location === 'object' ? { location: job.capture.location } : {}),
    ...(options.lineImageSigningSecret ? lineImageUrls(
      fileId,
      options.lineImageSigningSecret,
      options.calendarPublicBaseUrl,
    ) : {}),
    uploadJobId: jobId,
  }
}

async function commitCalendarCommentAttachment(db, jobRef, jobId, job) {
  if (job.target?.kind !== 'calendar-event' || job.target?.uploadKind !== 'comment') return null
  const eventId = text(job.target?.eventId)
  const commentId = text(job.target?.commentId)
  if (!eventId || !commentId) throw permanentError('留言附件目標不完整')
  return db.runTransaction(async (transaction) => {
    const currentSnapshot = await transaction.get(jobRef)
    if (!currentSnapshot.exists) throw permanentError('找不到附件上傳工作')
    const currentJob = currentSnapshot.data()
    if (currentJob.status === 'committed') return currentJob.attachment || null
    if (currentJob.status !== 'ready') throw new Error('留言附件尚未完成轉檔')
    const commentRef = db.collection('calendarEvents').doc(eventId).collection('comments').doc(commentId)
    const commentSnapshot = await transaction.get(commentRef)
    if (!commentSnapshot.exists) throw permanentError('找不到附件對應的留言')
    const comment = commentSnapshot.data() || {}
    if (text(comment.authorUid) !== text(currentJob.uploaderUid)) throw permanentError('留言附件上傳者不一致')
    const attachment = calendarAttachmentFromJobResult(jobId, currentJob, currentJob.result)
    const existingAttachments = Array.isArray(comment.attachments) ? comment.attachments : []
    const alreadyAttached = existingAttachments.some((item) => text(item?.uploadJobId) === jobId)
    transaction.update(commentRef, {
      attachments: alreadyAttached ? existingAttachments : [...existingAttachments, attachment],
      pendingAttachmentCount: Math.max(0, (Number(comment.pendingAttachmentCount) || 0) - (alreadyAttached ? 0 : 1)),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    })
    transaction.update(jobRef, {
      status: 'committed',
      attachment,
      committedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    })
    return attachment
  })
}

async function commitCalendarEventFulfillmentAttachment(db, jobRef, jobId, options = {}) {
  return db.runTransaction(async (transaction) => {
    const jobSnapshot = await transaction.get(jobRef)
    if (!jobSnapshot.exists) throw permanentError('找不到附件上傳工作')
    const job = jobSnapshot.data() || {}
    const batchId = fulfillmentBatchId(job)
    const batchSize = fulfillmentBatchSize(job)
    if (
      job.target?.kind !== 'calendar-event'
      || job.target?.uploadKind !== 'event'
      || job.target?.completionMode !== 'fulfillment'
      || !batchId
      || !batchSize
    ) return null
    if (!['ready', 'committed'].includes(job.status)) throw new Error('完工附件尚未完成轉檔')

    const eventId = text(job.target.eventId)
    if (!eventId) throw permanentError('完工附件目標不完整')
    const eventRef = db.collection('calendarEvents').doc(eventId)
    const batchRef = db.collection('attachmentFulfillmentBatches').doc(fulfillmentBatchDocumentId(batchId))
    const [eventSnapshot, batchSnapshot] = await Promise.all([
      transaction.get(eventRef),
      transaction.get(batchRef),
    ])
    if (!eventSnapshot.exists) throw permanentError('找不到附件對應的行事曆事件')
    const currentBatch = batchSnapshot.exists ? batchSnapshot.data() || {} : {}
    if (batchSnapshot.exists && (
      text(currentBatch.batchId) !== batchId
      || text(currentBatch.eventId) !== eventId
      || text(currentBatch.uploaderUid) !== text(job.uploaderUid)
      || Number(currentBatch.expectedSize) !== batchSize
    )) throw permanentError('完工附件批次資料不一致')

    const attachment = job.status === 'committed' && job.attachment
      ? job.attachment
      : calendarAttachmentFromJobResult(jobId, job, job.result, options)
    const event = eventSnapshot.data() || {}
    const existingAttachments = Array.isArray(event.attachments) ? event.attachments : []
    const alreadyAttached = existingAttachments.some((item) => (
      text(item?.uploadJobId) === jobId || text(item?.path) === text(attachment.path)
    ))
    const previousRetry = event.productionLineRetry && typeof event.productionLineRetry === 'object'
      ? event.productionLineRetry
      : null
    const previousIds = previousRetry?.mode === 'fulfillment'
      && text(previousRetry.fulfillmentBatchId) === batchId
      && Array.isArray(previousRetry.attachmentIds)
      ? previousRetry.attachmentIds.map(text).filter(Boolean)
      : []
    const attachmentIds = Array.from(new Set([...previousIds, text(attachment.path)].filter(Boolean)))
    transaction.update(eventRef, {
      attachments: alreadyAttached ? existingAttachments : [...existingAttachments, attachment],
      productionLineRetry: {
        mode: 'fulfillment',
        fulfillmentBatchId: batchId,
        attachmentIds,
        status: 'processing',
        message: '照片已保留，系統正在背景完成訂單並傳送 LINE。',
        updatedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    })
    if (job.status !== 'committed') {
      transaction.update(jobRef, {
        status: 'committed',
        attachment,
        committedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      })
    }
    transaction.set(batchRef, {
      batchId,
      eventId,
      uploaderUid: text(job.uploaderUid),
      expectedSize: batchSize,
      jobIds: admin.firestore.FieldValue.arrayUnion(jobId),
      ...(!batchSnapshot.exists ? {
        status: 'waiting',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      } : {}),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true })
    return { attachment, batchId }
  })
}

async function exchangeCustomTokenForIdToken(customToken, apiKey, fetchImpl = fetch) {
  if (!text(apiKey)) throw new Error('Firebase Web API Key 尚未設定')
  const response = await fetchImpl(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    },
  )
  const payload = await response.json().catch(() => null)
  if (!response.ok || !text(payload?.idToken)) {
    throw retryableError(`Firebase 背景登入交換失敗（HTTP ${response.status}）`)
  }
  return payload.idToken
}

function fulfillmentRetryDelayMs(attemptCount) {
  return Math.min(60 * 60 * 1000, 60 * 1000 * (2 ** Math.max(0, attemptCount - 1)))
}

function classifyFulfillmentBatchJobs(jobs, requestedBatchId) {
  if (!Array.isArray(jobs) || jobs.length === 0) return { state: 'waiting' }
  const first = jobs[0]
  const expectedSize = fulfillmentBatchSize(first)
  const eventId = text(first.target?.eventId)
  const uploaderUid = text(first.uploaderUid)
  if (!expectedSize || !eventId || !uploaderUid) return { state: 'invalid' }
  const consistent = jobs.every((job) => (
    fulfillmentBatchId(job) === requestedBatchId
    && fulfillmentBatchSize(job) === expectedSize
    && text(job.target?.eventId) === eventId
    && text(job.target?.completionMode) === 'fulfillment'
    && text(job.target?.uploadKind) === 'event'
    && text(job.uploaderUid) === uploaderUid
  ))
  if (!consistent || jobs.length > expectedSize) return { state: 'invalid' }
  if (jobs.length < expectedSize || jobs.some((job) => job.status !== 'committed' || !text(job.attachment?.path))) {
    return { state: 'waiting' }
  }
  return {
    state: 'ready',
    expectedSize,
    eventId,
    uploaderUid,
    attachmentIds: jobs.map(job => text(job.attachment.path)),
  }
}

function fulfillmentBatchLeaseDecision(current, nowMs = Date.now()) {
  if (current?.status === 'completed' || current?.status === 'failed') return 'terminal'
  if (current?.status === 'processing' && timestampMillis(current.leaseUntil) > nowMs) return 'busy'
  if (current?.status === 'retry' && timestampMillis(current.nextAttemptAt) > nowMs) return 'busy'
  if ((Number(current?.attemptCount) || 0) >= MAX_FULFILLMENT_ATTEMPTS) return 'terminal'
  return 'acquire'
}

function fulfillmentLineResultDecision(result) {
  if (result?.sent === true) return 'completed'
  if (result?.skipped === true && text(result.lineWarning)) return 'manual'
  if (result?.skipped === true) return 'completed'
  return 'retry'
}

function fulfillmentFailureState(attemptCount, nowMs = Date.now()) {
  const exhausted = Number(attemptCount) >= MAX_FULFILLMENT_ATTEMPTS
  return {
    status: exhausted ? 'failed' : 'retry',
    exhausted,
    nextAttemptAtMs: exhausted ? 0 : nowMs + fulfillmentRetryDelayMs(attemptCount),
  }
}

async function sendFulfillmentLineRequest({
  eventId,
  attachmentIds,
  idToken,
  appCheckToken,
  lineApiUrl = DEFAULT_ERP_LINE_API_URL,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(text(lineApiUrl) || DEFAULT_ERP_LINE_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
      'X-Firebase-AppCheck': appCheckToken,
    },
    body: JSON.stringify({
      action: 'complete-order-fulfillment',
      eventId,
      attachmentIds,
    }),
  })
  return {
    response,
    payload: await response.json().catch(() => null),
  }
}

async function markFulfillmentBatchResult({
  db,
  batchRef,
  batch,
  result,
  error,
  manualFailure = false,
  now = new Date(),
}) {
  const eventRef = db.collection('calendarEvents').doc(batch.eventId)
  const terminal = Boolean(result) && !manualFailure
  await db.runTransaction(async (transaction) => {
    const [batchSnapshot, eventSnapshot] = await Promise.all([
      transaction.get(batchRef),
      transaction.get(eventRef),
    ])
    if (!batchSnapshot.exists) return
    const current = batchSnapshot.data() || {}
    if (text(current.leaseId) !== text(batch.leaseId)) return
    const attemptCount = Number(current.attemptCount) || Number(batch.attemptCount) || 1
    const failureState = fulfillmentFailureState(attemptCount, now.getTime())
    const exhausted = manualFailure || (!terminal && failureState.exhausted)
    transaction.set(batchRef, terminal ? {
      status: 'completed',
      lineResult: result,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      leaseUntil: admin.firestore.FieldValue.delete(),
      leaseId: admin.firestore.FieldValue.delete(),
      lastError: admin.firestore.FieldValue.delete(),
      nextAttemptAt: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    } : {
      status: exhausted ? 'failed' : 'retry',
      ...(manualFailure ? { lineResult: result } : {}),
      lastError: text(error?.message || result?.lineWarning || result?.message).slice(0, 500) || '背景完成訂單暫時失敗',
      failedAt: admin.firestore.FieldValue.serverTimestamp(),
      leaseUntil: admin.firestore.FieldValue.delete(),
      leaseId: admin.firestore.FieldValue.delete(),
      ...(exhausted ? {
        nextAttemptAt: admin.firestore.FieldValue.delete(),
      } : {
        nextAttemptAt: admin.firestore.Timestamp.fromMillis(failureState.nextAttemptAtMs),
      }),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true })
    if (!eventSnapshot.exists) return
    const event = eventSnapshot.data() || {}
    if (text(event.productionLineRetry?.fulfillmentBatchId) !== text(batch.batchId)) return
    transaction.update(eventRef, {
      productionLineRetry: terminal
        ? admin.firestore.FieldValue.delete()
        : {
          ...event.productionLineRetry,
          status: exhausted ? 'failed' : 'processing',
          message: manualFailure
            ? text(result?.lineWarning || result?.message) || '訂單已完成，但 LINE 通知需要人工重新發送。'
            : exhausted
              ? '照片已保留，但背景完成訂單多次失敗，請人工重新發送。'
              : '照片已保留，背景完成訂單暫時失敗，系統將自動重試。',
          updatedAt: now.toISOString(),
        },
      updatedAt: now.toISOString(),
    })
  })
}

async function processFulfillmentBatch({
  db,
  batchId,
  auth = admin.auth(),
  appCheck = admin.appCheck(),
  apiKey,
  appId,
  lineApiUrl = DEFAULT_ERP_LINE_API_URL,
  fetchImpl = fetch,
  now = new Date(),
}) {
  if (!/^[A-Za-z0-9-]{8,120}$/.test(text(batchId))) return { ignored: true }
  const jobsSnapshot = await db.collection('attachmentUploadJobs')
    .where('target.fulfillmentBatchId', '==', batchId)
    .limit(21)
    .get()
  const jobs = jobsSnapshot.docs.map((document) => ({ id: document.id, ref: document.ref, ...document.data() }))
  const classification = classifyFulfillmentBatchJobs(jobs, batchId)
  if (classification.state === 'waiting') return { waiting: true }
  if (classification.state === 'invalid') throw permanentError('完工附件批次資料不一致')
  const { expectedSize, eventId, uploaderUid, attachmentIds } = classification

  const batchRef = db.collection('attachmentFulfillmentBatches').doc(fulfillmentBatchDocumentId(batchId))
  const leaseId = crypto.randomUUID()
  let acquired = null
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(batchRef)
    const current = snapshot.exists ? snapshot.data() || {} : {}
    if (fulfillmentBatchLeaseDecision(current, now.getTime()) !== 'acquire') return
    if (snapshot.exists && (
      text(current.batchId) !== batchId
      || text(current.eventId) !== eventId
      || text(current.uploaderUid) !== uploaderUid
      || Number(current.expectedSize) !== expectedSize
    )) throw permanentError('完工附件批次資料不一致')
    const attemptCount = (Number(current.attemptCount) || 0) + 1
    if (attemptCount > MAX_FULFILLMENT_ATTEMPTS) return
    acquired = {
      batchId,
      eventId,
      uploaderUid,
      expectedSize,
      attachmentIds,
      leaseId,
      attemptCount,
    }
    transaction.set(batchRef, {
      ...acquired,
      status: 'processing',
      attemptCount,
      leaseUntil: admin.firestore.Timestamp.fromMillis(now.getTime() + FULFILLMENT_LEASE_MS),
      nextAttemptAt: admin.firestore.FieldValue.delete(),
      lastError: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true })
  })
  if (!acquired) return { busy: true }

  try {
    const customToken = await auth.createCustomToken(uploaderUid, {
      backgroundFulfillment: true,
      fulfillmentBatchId: batchId,
    })
    const [idToken, appCheckResult] = await Promise.all([
      exchangeCustomTokenForIdToken(customToken, apiKey, fetchImpl),
      appCheck.createToken(text(appId), { ttlMillis: 30 * 60 * 1000, limitedUse: true }),
    ])
    const { response, payload } = await sendFulfillmentLineRequest({
      eventId,
      attachmentIds: acquired.attachmentIds,
      idToken,
      appCheckToken: appCheckResult.token,
      lineApiUrl,
      fetchImpl,
    })
    if (!response.ok || payload?.ok !== true || !payload?.result?.orderStatus) {
      throw retryableError(`ERP LINE 完工處理失敗（HTTP ${response.status}）`)
    }
    const result = payload.result
    const resultDecision = fulfillmentLineResultDecision(result)
    if (resultDecision === 'manual') {
      await markFulfillmentBatchResult({
        db,
        batchRef,
        batch: acquired,
        result,
        manualFailure: true,
        now,
      })
      return { completed: false, manual: true, result }
    }
    if (resultDecision === 'retry') {
      throw retryableError(text(result.lineWarning || result.message) || 'LINE 完工通知尚未送達')
    }
    await markFulfillmentBatchResult({ db, batchRef, batch: acquired, result, now })
    return { completed: true, result }
  } catch (error) {
    await markFulfillmentBatchResult({ db, batchRef, batch: acquired, error, now }).catch(() => {})
    console.error('背景完成訂單與 LINE 通知失敗', {
      batchId,
      eventId,
      attemptCount: acquired.attemptCount,
      message: text(error?.message),
    })
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
      acquiredJob = job
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
    '留言附件目標不完整',
    '找不到附件對應的留言',
    '留言附件上傳者不一致',
    '銷貨附件缺少銷貨單號',
    '不支援的附件目標',
  ]
  return known.includes(error?.message) ? error.message : '附件背景處理失敗，系統將自動重試'
}

async function processAttachmentUpload({
  db,
  bucket,
  drive,
  objectData,
  eventId,
  configuredFolders,
  fulfillmentOptions,
  now = new Date(),
}) {
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
      if (acquired.terminalStatus === 'ready' && acquired.job?.target?.uploadKind === 'comment') {
        await commitCalendarCommentAttachment(db, jobRef, parsedPath.jobId, acquired.job)
      }
      if (acquired.terminalStatus === 'ready' && fulfillmentBatchId(acquired.job)) {
        const committed = await commitCalendarEventFulfillmentAttachment(
          db,
          jobRef,
          parsedPath.jobId,
          fulfillmentOptions,
        )
        if (committed) {
          await processFulfillmentBatch({
            db,
            batchId: committed.batchId,
            ...fulfillmentOptions,
          }).catch(() => undefined)
        }
      }
      await bucket.file(objectData.name).delete({ ignoreNotFound: true })
      return { terminalStatus: acquired.job?.target?.uploadKind === 'comment' ? 'committed' : acquired.terminalStatus }
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
    if (job.target?.uploadKind === 'comment') {
      await commitCalendarCommentAttachment(db, jobRef, parsedPath.jobId, job)
    }
    if (fulfillmentBatchId(job)) {
      const committed = await commitCalendarEventFulfillmentAttachment(
        db,
        jobRef,
        parsedPath.jobId,
        fulfillmentOptions,
      )
      if (committed) {
        await processFulfillmentBatch({
          db,
          batchId: committed.batchId,
          ...fulfillmentOptions,
        }).catch(() => undefined)
      }
    }
    await bucket.file(objectData.name).delete({ ignoreNotFound: true })
    return { status: job.target?.uploadKind === 'comment' ? 'committed' : 'ready', result: nextResult }
  } catch (error) {
    if (error?.code === 'JOB_BUSY') throw error
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
    } else if (readyWritten) {
      throw error
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

function runtimeFulfillmentOptions() {
  return {
    lineImageSigningSecret: lineImageSigningSecret.value(),
    calendarPublicBaseUrl: calendarPublicBaseUrl.value(),
    apiKey: firebaseWebApiKey.value(),
    appId: firebaseWebAppId.value(),
    lineApiUrl: erpLineApiUrl.value(),
  }
}

const processStagedAttachment = onObjectFinalized({
  bucket: DEFAULT_STORAGE_BUCKET,
  region: 'us-east1',
  memory: '1GiB',
  timeoutSeconds: 540,
  retry: true,
  secrets: attachmentWorkerSecrets,
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
    fulfillmentOptions: runtimeFulfillmentOptions(),
  })
})

const processPendingAttachments = onSchedule({
  schedule: 'every 1 minutes',
  timeZone: 'Asia/Taipei',
  region: 'us-east1',
  memory: '1GiB',
  timeoutSeconds: 540,
  secrets: attachmentWorkerSecrets,
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
        fulfillmentOptions: runtimeFulfillmentOptions(),
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

const recoverPendingAttachmentFulfillments = onSchedule({
  schedule: 'every 1 minutes',
  timeZone: 'Asia/Taipei',
  region: 'asia-east1',
  timeoutSeconds: 540,
  secrets: [lineImageSigningSecret],
}, async () => {
  const db = admin.firestore()
  const options = runtimeFulfillmentOptions()
  const readySnapshot = await db.collection('attachmentUploadJobs')
    .where('status', '==', 'ready')
    .limit(100)
    .get()
  for (const document of readySnapshot.docs) {
    const job = document.data() || {}
    if (!fulfillmentBatchId(job)) continue
    try {
      await commitCalendarEventFulfillmentAttachment(db, document.ref, document.id, options)
    } catch (error) {
      console.error('排程提交完工附件失敗', {
        jobId: document.id,
        message: publicErrorMessage(error),
      })
    }
  }
  const now = new Date()
  const batchSnapshot = await db.collection('attachmentFulfillmentBatches')
    .where('status', 'in', ['waiting', 'retry', 'processing'])
    .limit(100)
    .get()
  for (const document of batchSnapshot.docs) {
    const batch = document.data() || {}
    if (batch.status === 'processing' && timestampMillis(batch.leaseUntil) > now.getTime()) continue
    if (batch.status === 'retry' && timestampMillis(batch.nextAttemptAt) > now.getTime()) continue
    try {
      await processFulfillmentBatch({
        db,
        batchId: text(batch.batchId),
        ...options,
        now,
      })
    } catch (error) {
      console.error('排程背景完成訂單失敗', {
        batchId: text(batch.batchId),
        message: text(error?.message),
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
  commitCalendarCommentAttachment,
  calendarAttachmentFromJobResult,
  classifyFulfillmentBatchJobs,
  makeDriveFilePublic,
  cleanupStagedAttachments,
  parseStagingObjectPath,
  processPendingAttachments,
  recoverPendingAttachmentFulfillments,
  processAttachmentUpload,
  processStagedAttachment,
  resultFileIds,
  shouldCleanupJob,
  transformVariants,
  variantNames,
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
  processFulfillmentBatch,
  sendFulfillmentLineRequest,
}
