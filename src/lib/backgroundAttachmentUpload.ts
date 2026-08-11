import { doc, getDoc, onSnapshot } from 'firebase/firestore'
import { ref, uploadBytesResumable } from 'firebase/storage'
import type { PhotoCaptureMetadata } from './photoMetadata'
import { auth, db, getAppCheckHeaders, storage } from './firebase'
import type { CalendarEvent } from '../types'
import { keepRemoteUploadResult, keepUploadFlowAfterLocalStateFailure } from './backgroundAttachmentUploadResult'

export type BackgroundAttachmentCompletionMode = 'fulfillment' | 'production' | 'none'
export type BackgroundAttachmentUploadKind = 'event' | 'comment'
export type BackgroundAttachmentProgress = 'uploading' | 'processing' | 'finalizing'
export type DurableBackgroundAttachmentStatus = 'queued' | BackgroundAttachmentProgress | 'failed'
export type DurableBackgroundAttachmentUpload = {
  id: string
  uploaderUid: string
  eventId: string
  uploadKind?: BackgroundAttachmentUploadKind
  commentId?: string
  completionMode: BackgroundAttachmentCompletionMode
  fulfillmentBatchId?: string
  fulfillmentBatchSize?: number
  blob: Blob
  name: string
  type: string
  size: number
  lastModified: number
  status: DurableBackgroundAttachmentStatus
  progress: number
  cloudSafe: boolean
  jobId?: string
  stagingPath?: string
  capture?: PhotoCaptureMetadata
  attachment?: EventAttachment
  error?: string
  createdAt: string
  updatedAt: string
}
export type BackgroundAttachmentRecovery = {
  jobId: string
  eventId: string
  completionMode: BackgroundAttachmentCompletionMode
  uploadKind?: BackgroundAttachmentUploadKind
  commentId?: string
}

type EventAttachment = NonNullable<CalendarEvent['attachments']>[number]
type JobApiResponse = {
  ok?: boolean
  jobId?: string
  stagingPath?: string
  attachment?: EventAttachment
  completionMode?: BackgroundAttachmentCompletionMode
  error?: string
}

const RECOVERY_STORAGE_KEY = 'cityPainterCalendarBackgroundAttachmentJobs'
const DURABLE_UPLOAD_DATABASE = 'cityPainterCalendarDurableUploads'
const DURABLE_UPLOAD_STORE = 'uploads'
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
}

function imageExtension(fileName: string) {
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex >= 0 ? fileName.slice(dotIndex + 1).trim().toLowerCase() : ''
}

export function backgroundImageContentType(file: Pick<File, 'name' | 'type'>) {
  const declaredType = file.type.trim().toLowerCase()
  if (declaredType.startsWith('image/') && declaredType !== 'image/svg+xml') return declaredType
  return IMAGE_MIME_BY_EXTENSION[imageExtension(file.name)] ?? ''
}

export function canUseBackgroundImageUpload(file: Pick<File, 'name' | 'type' | 'size'>) {
  return Boolean(backgroundImageContentType(file))
    && imageExtension(file.name) !== 'svg'
    && file.size > 0
    && file.size <= 50 * 1024 * 1024
}

let durableUploadDatabasePromise: Promise<IDBDatabase> | null = null

function openDurableUploadDatabase() {
  if (!durableUploadDatabasePromise) {
    durableUploadDatabasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (!('indexedDB' in globalThis)) {
        reject(new Error('此瀏覽器不支援離線照片佇列'))
        return
      }
      const request = indexedDB.open(DURABLE_UPLOAD_DATABASE, 1)
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains(DURABLE_UPLOAD_STORE)) {
          const store = database.createObjectStore(DURABLE_UPLOAD_STORE, { keyPath: 'id' })
          store.createIndex('uploaderUid', 'uploaderUid', { unique: false })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error || new Error('無法開啟離線照片佇列'))
      request.onblocked = () => reject(new Error('離線照片佇列正在更新，請關閉其他分頁後重試'))
    }).catch((error) => {
      durableUploadDatabasePromise = null
      throw error
    })
  }
  return durableUploadDatabasePromise
}

async function runDurableUploadTransaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore, resolveValue: (value: T) => void) => void,
) {
  const database = await openDurableUploadDatabase()
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(DURABLE_UPLOAD_STORE, mode)
    const store = transaction.objectStore(DURABLE_UPLOAD_STORE)
    let value: T
    operation(store, (nextValue) => { value = nextValue })
    transaction.oncomplete = () => resolve(value)
    transaction.onerror = (event) => reject(
      transaction.error
      || (event.target as IDBRequest | null)?.error
      || new Error('離線照片佇列操作失敗')
    )
    transaction.onabort = () => reject(transaction.error || new Error('離線照片佇列操作已取消'))
  })
}

export async function persistDurableBackgroundAttachmentUpload(options: {
  id: string
  uploaderUid: string
  eventId: string
  completionMode: BackgroundAttachmentCompletionMode
  fulfillmentBatchId?: string
  fulfillmentBatchSize?: number
  uploadKind?: BackgroundAttachmentUploadKind
  commentId?: string
  file: File
}) {
  const now = new Date().toISOString()
  const row: DurableBackgroundAttachmentUpload = {
    id: options.id,
    uploaderUid: options.uploaderUid,
    eventId: options.eventId,
    completionMode: options.completionMode,
    ...(options.fulfillmentBatchId ? { fulfillmentBatchId: options.fulfillmentBatchId } : {}),
    ...(options.fulfillmentBatchSize ? { fulfillmentBatchSize: options.fulfillmentBatchSize } : {}),
    uploadKind: options.uploadKind ?? 'event',
    ...(options.commentId ? { commentId: options.commentId } : {}),
    blob: options.file,
    name: options.file.name,
    type: backgroundImageContentType(options.file),
    size: options.file.size,
    lastModified: options.file.lastModified,
    status: 'queued',
    progress: 0,
    cloudSafe: false,
    createdAt: now,
    updatedAt: now,
  }
  await runDurableUploadTransaction<void>('readwrite', (store, setValue) => {
    store.put(row)
    setValue(undefined)
  })
  return row
}

export async function updateDurableBackgroundAttachmentUpload(
  uploadId: string,
  patch: Partial<Omit<DurableBackgroundAttachmentUpload, 'id' | 'blob' | 'createdAt'>>,
) {
  return runDurableUploadTransaction<DurableBackgroundAttachmentUpload>('readwrite', (store, setValue) => {
    const request = store.get(uploadId)
    request.onsuccess = () => {
      const current = request.result as DurableBackgroundAttachmentUpload | undefined
      if (!current) {
        store.transaction.abort()
        return
      }
      const next = { ...current, ...patch, updatedAt: new Date().toISOString() }
      store.put(next)
      setValue(next)
    }
  })
}

export async function loadDurableBackgroundAttachmentUploads(uploaderUid: string) {
  return runDurableUploadTransaction<DurableBackgroundAttachmentUpload[]>('readonly', (store, setValue) => {
    const request = store.index('uploaderUid').getAll(uploaderUid)
    request.onsuccess = () => {
      const rows = (request.result as DurableBackgroundAttachmentUpload[]).filter((row) => (
        row
        && typeof row.id === 'string'
        && typeof row.eventId === 'string'
        && row.blob instanceof Blob
        && ['fulfillment', 'production', 'none'].includes(row.completionMode)
        && (!row.uploadKind || ['event', 'comment'].includes(row.uploadKind))
        && (row.uploadKind !== 'comment' || typeof row.commentId === 'string')
      ))
      setValue(rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
    }
  })
}

export async function removeDurableBackgroundAttachmentUpload(uploadId: string) {
  await runDurableUploadTransaction<void>('readwrite', (store, setValue) => {
    store.delete(uploadId)
    setValue(undefined)
  })
}

export function durableBackgroundAttachmentFile(upload: DurableBackgroundAttachmentUpload) {
  return new File([upload.blob], upload.name, {
    type: upload.type,
    lastModified: upload.lastModified,
  })
}

export function blocksBackgroundAttachmentUnload(upload: Pick<DurableBackgroundAttachmentUpload, 'status' | 'cloudSafe'>) {
  return !upload.cloudSafe && (upload.status === 'queued' || upload.status === 'uploading')
}

async function callJobApi(body: Record<string, unknown>) {
  const user = auth.currentUser
  if (!user) throw new Error('登入已失效，請重新登入')
  const [token, appCheckHeaders] = await Promise.all([user.getIdToken(), getAppCheckHeaders()])
  const response = await fetch('/api/upload-drive', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...appCheckHeaders,
    },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({})) as JobApiResponse
  if (!response.ok || payload.ok !== true) {
    throw new Error(payload.error || `照片背景處理失敗（HTTP ${response.status}）`)
  }
  return payload
}

export function loadBackgroundAttachmentRecoveries(): BackgroundAttachmentRecovery[] {
  try {
    const rows = JSON.parse(localStorage.getItem(RECOVERY_STORAGE_KEY) || '[]')
    if (!Array.isArray(rows)) return []
    return rows.filter((row): row is BackgroundAttachmentRecovery => (
      typeof row?.jobId === 'string'
      && typeof row?.eventId === 'string'
      && ['fulfillment', 'production', 'none'].includes(row?.completionMode)
      && (!row?.uploadKind || ['event', 'comment'].includes(row.uploadKind))
      && (row?.uploadKind !== 'comment' || typeof row?.commentId === 'string')
    ))
  } catch {
    return []
  }
}

function writeRecoveries(rows: BackgroundAttachmentRecovery[]) {
  localStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(rows.slice(-30)))
}

export function rememberBackgroundAttachmentRecovery(row: BackgroundAttachmentRecovery) {
  const rows = loadBackgroundAttachmentRecoveries().filter((item) => item.jobId !== row.jobId)
  writeRecoveries([...rows, row])
}

export function forgetBackgroundAttachmentRecovery(jobId: string) {
  writeRecoveries(loadBackgroundAttachmentRecoveries().filter((item) => item.jobId !== jobId))
}

export async function createBackgroundAttachmentJob(
  eventId: string,
  file: File,
  completionMode: BackgroundAttachmentCompletionMode,
  capture?: PhotoCaptureMetadata,
  clientUploadId?: string,
  context: {
    uploadKind?: BackgroundAttachmentUploadKind
    commentId?: string
    fulfillmentBatchId?: string
    fulfillmentBatchSize?: number
  } = {},
) {
  const contentType = backgroundImageContentType(file)
  const payload = await callJobApi({
    action: 'create-attachment-upload-job',
    eventId,
    originalName: file.name,
    originalSize: file.size,
    contentType,
    completionMode,
    uploadKind: context.uploadKind ?? 'event',
    ...(context.commentId ? { commentId: context.commentId } : {}),
    ...(context.fulfillmentBatchId ? { fulfillmentBatchId: context.fulfillmentBatchId } : {}),
    ...(context.fulfillmentBatchSize ? { fulfillmentBatchSize: context.fulfillmentBatchSize } : {}),
    ...(clientUploadId ? { clientUploadId } : {}),
    ...(capture ? { capture } : {}),
  })
  if (!payload.jobId || !payload.stagingPath) throw new Error('無法建立照片背景工作')
  return { jobId: payload.jobId, stagingPath: payload.stagingPath }
}

export function uploadBackgroundAttachment(
  stagingPath: string,
  jobId: string,
  file: File,
  onProgress?: (ratio: number) => void,
) {
  const contentType = backgroundImageContentType(file)
  return new Promise<void>((resolve, reject) => {
    const task = uploadBytesResumable(ref(storage, stagingPath), file, {
      contentType,
      customMetadata: { jobId },
    })
    task.on('state_changed', (snapshot) => {
      onProgress?.(snapshot.totalBytes > 0 ? snapshot.bytesTransferred / snapshot.totalBytes : 0)
    }, reject, () => resolve())
  })
}

export function waitForBackgroundAttachmentJob(
  jobId: string,
  timeoutMs = 15 * 60 * 1000,
  committedOnly = false,
) {
  return new Promise<'ready' | 'committed'>((resolve, reject) => {
    let unsubscribe: () => void = () => undefined
    const timeout = window.setTimeout(() => {
      unsubscribe()
      reject(new Error('照片仍在背景處理，稍後會自動繼續'))
    }, timeoutMs)
    const finish = (callback: () => void) => {
      window.clearTimeout(timeout)
      unsubscribe()
      callback()
    }
    unsubscribe = onSnapshot(doc(db, 'attachmentUploadJobs', jobId), (snapshot) => {
      if (!snapshot.exists()) return
      const data = snapshot.data()
      const status = typeof data.status === 'string' ? data.status : ''
      if (status === 'committed' || (!committedOnly && status === 'ready')) finish(() => resolve(status))
      if (status === 'failed' || status === 'error') {
        const message = typeof data.error === 'string'
          ? data.error
          : data.error && typeof data.error === 'object' && typeof data.error.message === 'string'
            ? data.error.message
            : '照片背景轉檔失敗'
        finish(() => reject(new Error(message)))
      }
    }, (error) => finish(() => reject(error)))
  })
}

export async function finalizeBackgroundAttachmentJob(jobId: string) {
  const payload = await callJobApi({ action: 'finalize-attachment-upload-job', jobId })
  if (!payload.attachment) throw new Error('照片背景處理結果不完整')
  return {
    attachment: payload.attachment,
    completionMode: payload.completionMode || 'none',
  }
}

export async function startBackgroundAttachmentUpload(options: {
  eventId: string
  file: File
  completionMode: BackgroundAttachmentCompletionMode
  uploadKind?: BackgroundAttachmentUploadKind
  commentId?: string
  durableUpload?: DurableBackgroundAttachmentUpload
  capture?: PhotoCaptureMetadata
  localFallback?: (file: File, clientUploadId: string) => Promise<EventAttachment>
  onJobCreated?: (jobId: string) => void
  onCloudSafe?: () => void
  onProgress?: (status: BackgroundAttachmentProgress, ratio?: number) => void
}) {
  const durableUpload = options.durableUpload
  if (!durableUpload) throw new Error('照片尚未存入離線佇列')
  const persistedCapture = options.capture ?? durableUpload.capture
  const persistLocalState = (
    phase: string,
    patch: Partial<Omit<DurableBackgroundAttachmentUpload, 'id' | 'blob' | 'createdAt'>>,
  ) => keepUploadFlowAfterLocalStateFailure(
    () => updateDurableBackgroundAttachmentUpload(durableUpload.id, patch),
    (error) => console.warn('[calendar] 照片雲端流程繼續，本機佇列狀態更新失敗', {
      phase,
      uploadId: durableUpload.id,
      name: durableUpload.name,
      size: durableUpload.size,
      error,
    }),
  )
  if (durableUpload.attachment) {
    options.onCloudSafe?.()
    options.onProgress?.('finalizing', 1)
    return { attachment: durableUpload.attachment, completionMode: durableUpload.completionMode }
  }
  if (options.localFallback) {
    options.onProgress?.('uploading', 0)
    const attachment = await options.localFallback(options.file, durableUpload.id)
    options.onCloudSafe?.()
    options.onProgress?.('finalizing', 1)
    await persistLocalState('local-fallback-completed', {
      status: 'finalizing',
      progress: 1,
      cloudSafe: true,
      attachment,
      error: undefined,
    })
    return { attachment, completionMode: options.completionMode }
  }
  let jobId = durableUpload.jobId
  let stagingPath = durableUpload.stagingPath
  if (!jobId || !stagingPath) {
    const created = await createBackgroundAttachmentJob(
      options.eventId,
      options.file,
      options.completionMode,
      persistedCapture,
      durableUpload.id,
      {
        uploadKind: options.uploadKind ?? durableUpload.uploadKind ?? 'event',
        commentId: options.commentId ?? durableUpload.commentId,
        fulfillmentBatchId: durableUpload.fulfillmentBatchId,
        fulfillmentBatchSize: durableUpload.fulfillmentBatchSize,
      },
    )
    jobId = created.jobId
    stagingPath = created.stagingPath
  }
  options.onJobCreated?.(jobId)
  const snapshot = await getDoc(doc(db, 'attachmentUploadJobs', jobId))
  const jobStatus = snapshot.exists() && typeof snapshot.data().status === 'string'
    ? snapshot.data().status
    : ''
  if (jobStatus === 'failed' || jobStatus === 'error') {
    const data = snapshot.data()
    const message = typeof data?.error === 'string'
      ? data.error
      : data?.error && typeof data.error === 'object' && typeof data.error.message === 'string'
        ? data.error.message
        : '照片背景轉檔失敗'
    throw new Error(message)
  }
  if (jobStatus === 'processing' || jobStatus === 'ready' || jobStatus === 'committed') {
    options.onCloudSafe?.()
    options.onProgress?.('processing', 1)
    await persistLocalState('cloud-safe-resume', {
      status: 'processing',
      progress: 1,
      cloudSafe: true,
      jobId,
      stagingPath,
      error: undefined,
    })
  } else {
    options.onProgress?.('uploading', 0)
    await uploadBackgroundAttachment(stagingPath, jobId, options.file, (ratio) => {
      options.onProgress?.('uploading', ratio)
    })
    options.onCloudSafe?.()
    options.onProgress?.('processing', 1)
    await persistLocalState('cloud-safe-upload', {
      status: 'processing',
      progress: 1,
      cloudSafe: true,
      jobId,
      stagingPath,
      ...(persistedCapture && !durableUpload.capture ? { capture: persistedCapture } : {}),
      error: undefined,
    })
  }
  await waitForBackgroundAttachmentJob(
    jobId,
    15 * 60 * 1000,
    options.completionMode === 'fulfillment' && Boolean(durableUpload.fulfillmentBatchId),
  )
  options.onProgress?.('finalizing')
  const result = await finalizeBackgroundAttachmentJob(jobId)
  return keepRemoteUploadResult(
    result,
    () => updateDurableBackgroundAttachmentUpload(durableUpload.id, {
      status: 'finalizing',
      progress: 1,
      cloudSafe: true,
      attachment: result.attachment,
      error: undefined,
    }),
    (error) => console.warn('[calendar] 照片已完成雲端上傳，但本機佇列狀態更新失敗', error),
  )
}

export async function resumeBackgroundAttachmentUpload(recovery: BackgroundAttachmentRecovery) {
  await waitForBackgroundAttachmentJob(recovery.jobId)
  const result = await finalizeBackgroundAttachmentJob(recovery.jobId)
  forgetBackgroundAttachmentRecovery(recovery.jobId)
  return result
}

export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
) {
  let cursor = 0
  const runners = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor]
      cursor += 1
      await worker(item)
    }
  })
  await Promise.all(runners)
}
