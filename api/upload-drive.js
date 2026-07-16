import fs from 'node:fs'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import admin from 'firebase-admin'
import { google } from 'googleapis'
import formidable from 'formidable'
import sharp from 'sharp'

const DEFAULT_DRIVE_FOLDER_ID = '1aqx7A8VwTKBSltaEj0IFoOXQP4HUJWF4'
const DEFAULT_PUBLIC_BASE_URL = 'https://sch.city-painter.com'
const PROJECT_ID = 'city-painter-erp'

export const config = {
  api: {
    bodyParser: false
  }
}

function getServiceAccountCredentials() {
  const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  const base64Json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64
  const source = rawJson || (base64Json ? Buffer.from(base64Json, 'base64').toString('utf8') : '')
  if (source) return JSON.parse(source)

  const localCredentialsPath = path.join(os.homedir(), '.firebase', 'service-account.json')
  if (fs.existsSync(localCredentialsPath)) {
    return JSON.parse(fs.readFileSync(localCredentialsPath, 'utf8'))
  }

  throw new Error('Missing Google service account credentials')
}

function getAdminApp() {
  if (admin.apps.length > 0) return admin.app()
  return admin.initializeApp({
    credential: admin.credential.cert(getServiceAccountCredentials()),
    projectId: PROJECT_ID
  })
}

async function verifyRequest(req) {
  const authorization = String(req.headers.authorization || '')
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
  if (!token) return null
  try {
    getAdminApp()
    return await admin.auth().verifyIdToken(token)
  } catch {
    return null
  }
}

function requestError(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function stringList(value) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : []
}

async function verifyAppCheck(req) {
  const token = text(req.headers['x-firebase-appcheck'])
  if (!token) throw requestError('缺少網站安全驗證', 401)
  try {
    await admin.appCheck().verifyToken(token)
  } catch {
    throw requestError('網站安全驗證失敗', 401)
  }
}

async function authenticateEmployee(req) {
  getAdminApp()
  await verifyAppCheck(req)
  const decoded = await verifyRequest(req)
  if (!decoded?.uid) throw requestError('登入已失效，請重新登入', 401)

  const db = admin.firestore()
  const roleSnapshot = await db.collection('userRoles').doc(decoded.uid).get()
  const role = roleSnapshot.exists ? roleSnapshot.data() || {} : {}
  const employeeId = text(role.employeeId)
  if (!employeeId) throw requestError('此帳號不是有效員工帳號', 403)
  const employeeSnapshot = await db.collection('employees').doc(employeeId).get()
  const employee = employeeSnapshot.exists ? employeeSnapshot.data() || {} : null
  if (!employee || employee.status === 'inactive' || text(employee.resignDate)) {
    throw requestError('此員工帳號已停用', 403)
  }
  const erpAccessSnapshot = await db.collection('erp_access').doc(decoded.uid).get()
  const erpAccess = erpAccessSnapshot.exists ? erpAccessSnapshot.data() || {} : null
  if (
    !erpAccess
    || erpAccess.enabled !== true
    || text(erpAccess.uid) !== decoded.uid
    || text(erpAccess.employeeId) !== employeeId
    || text(erpAccess.employeeNo) !== text(employee.empNo)
    || Number(erpAccess.schemaVersion) < 2
  ) {
    throw requestError('ERP 存取權限已失效，請重新登入', 403)
  }
  return {
    uid: decoded.uid,
    decoded,
    role: text(role.role),
    employeeId,
    employee: { id: employeeId, ...employee },
    erpAccess,
  }
}

async function departmentName(db, departmentId) {
  const id = text(departmentId)
  if (!id) return ''
  const snapshot = await db.collection('departments').doc(id).get()
  return snapshot.exists ? text(snapshot.data()?.name) : ''
}

function eventDepartmentIds(event) {
  return Array.from(new Set([
    text(event?.departmentId),
    ...stringList(event?.calendarIds).map((id) => id.startsWith('department:') ? id.slice('department:'.length) : ''),
    text(event?.calendarId).startsWith('department:') ? text(event.calendarId).slice('department:'.length) : '',
  ].filter(Boolean)))
}

async function actorDepartmentMatches(db, actor, departmentId) {
  const id = text(departmentId)
  if (!id) return false
  if (id === text(actor.employee.departmentId)) return true
  const actorDepartmentName = text(actor.employee.departmentName)
  return Boolean(actorDepartmentName && await departmentName(db, id) === actorDepartmentName)
}

async function eventTargetsActorDepartment(db, event, field, actor) {
  for (const departmentId of stringList(event?.[field])) {
    if (await actorDepartmentMatches(db, actor, departmentId)) return true
  }
  return false
}

async function isManagementEvent(db, event) {
  for (const departmentId of eventDepartmentIds(event)) {
    if (await departmentName(db, departmentId) === '管理部') return true
  }
  return false
}

async function canViewEvent(db, actor, event) {
  if (!event) return false
  if (actor.role === 'admin' || text(event.createdBy) === actor.uid) return true
  const explicitlyVisible = stringList(event.visibleAssigneeIds).includes(actor.employeeId)
    || await eventTargetsActorDepartment(db, event, 'visibleDepartmentIds', actor)
  if (explicitlyVisible) return true
  if (stringList(event.hiddenAssigneeIds).includes(actor.employeeId)) return false
  if (await eventTargetsActorDepartment(db, event, 'hiddenDepartmentIds', actor)) return false
  if (await isManagementEvent(db, event) && text(actor.employee.departmentName) !== '管理部') return false
  if (stringList(event.assigneeIds).includes(actor.employeeId)) return true
  for (const departmentId of eventDepartmentIds(event)) {
    if (await actorDepartmentMatches(db, actor, departmentId)) return true
  }
  return eventDepartmentIds(event).length === 0 && stringList(event.assigneeIds).length === 0
}

async function canManageEvent(db, actor, event, eventId) {
  if (!event || text(event.source) === 'hrLeaveRequest' || text(eventId).startsWith('hrLeaveRequest_')) return false
  if (actor.role === 'admin' || text(event.createdBy) === actor.uid || text(actor.employee.departmentName) === '管理部') return true
  if (!await canViewEvent(db, actor, event)) return false
  if (stringList(event.assigneeIds).includes(actor.employeeId)) return true
  for (const departmentId of eventDepartmentIds(event)) {
    if (await actorDepartmentMatches(db, actor, departmentId)) return true
  }
  return false
}

async function loadEvent(db, eventId) {
  const id = text(eventId)
  if (!id || id === 'draft-event') return null
  const snapshot = await db.collection('calendarEvents').doc(id).get()
  return snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null
}

function attachmentBelongsToEvent(event, fileId) {
  return Array.isArray(event?.attachments) && event.attachments.some((attachment) => text(attachment?.path) === fileId)
}

function canCompleteSalesOrder(actor) {
  if (actor.erpAccess?.enabled !== true) return false
  const matrix = actor.erpAccess.permissionMatrix
  if (!matrix || typeof matrix !== 'object') return false
  return ['sales-main', 'dashboard-sales-main'].some((featureKey) => (
    matrix[featureKey]?.update === true || matrix[featureKey]?.special === true
  ))
}

function lineImageSigningSecret() {
  return process.env.LINE_IMAGE_SIGNING_SECRET || getServiceAccountCredentials().private_key
}

function lineImageSignature(fileId, variant) {
  return createHmac('sha256', lineImageSigningSecret())
    .update(`${fileId}:${variant}`)
    .digest('hex')
}

function validLineImageSignature(fileId, variant, signature) {
  const expected = Buffer.from(lineImageSignature(fileId, variant), 'hex')
  let received
  try {
    received = Buffer.from(String(signature || ''), 'hex')
  } catch {
    return false
  }
  return expected.length === received.length && timingSafeEqual(expected, received)
}

function lineImageUrls(fileId) {
  const baseUrl = (process.env.CALENDAR_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL).replace(/\/$/, '')
  const url = (variant) => `${baseUrl}/api/upload-drive?fileId=${encodeURIComponent(fileId)}&variant=${variant}&signature=${lineImageSignature(fileId, variant)}`
  return {
    lineOriginalUrl: url('original'),
    linePreviewUrl: url('preview')
  }
}

function getDriveAuth() {
  const clientId = process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID
  const clientSecret = process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET
  const refreshToken = process.env.GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN

  if (clientId && clientSecret && refreshToken) {
    const auth = new google.auth.OAuth2(clientId, clientSecret)
    auth.setCredentials({ refresh_token: refreshToken })
    return auth
  }

  const credentials = getServiceAccountCredentials()
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive']
  })
}

function parseUpload(req) {
  const form = formidable({
    multiples: true,
    keepExtensions: true,
    maxFileSize: 25 * 1024 * 1024
  })

  return new Promise((resolve, reject) => {
    form.parse(req, (error, fields, files) => {
      if (error) {
        reject(error)
        return
      }
      resolve({ fields, files })
    })
  })
}

async function parseJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  const body = Buffer.concat(chunks).toString('utf8')
  return body ? JSON.parse(body) : {}
}

function normalizeFiles(fileField) {
  if (!fileField) return []
  return Array.isArray(fileField) ? fileField : [fileField]
}

function fieldText(value) {
  const normalized = Array.isArray(value) ? value[0] : value
  return typeof normalized === 'string' ? normalized.trim() : ''
}

function isImage(file) {
  return Boolean(file.mimetype?.startsWith('image/')) && file.mimetype !== 'image/svg+xml'
}

function webpName(filename) {
  const parsed = path.parse(filename || 'image')
  return `${parsed.name || 'image'}.webp`
}

async function prepareUploadFile(file, metadata = {}) {
  const originalName = fieldText(metadata.originalName) || file.originalFilename || file.newFilename
  const parsedOriginalSize = Number(fieldText(metadata.originalSize))
  const originalSize = Number.isFinite(parsedOriginalSize) && parsedOriginalSize > 0 ? parsedOriginalSize : file.size
  if (!isImage(file)) {
    return {
      filepath: file.filepath,
      name: file.originalFilename || file.newFilename,
      mimeType: file.mimetype || 'application/octet-stream',
      size: file.size,
      originalName,
      originalSize,
      optimized: false
    }
  }

  const outputPath = path.join(os.tmpdir(), `${randomUUID()}.webp`)
  await sharp(file.filepath)
    .rotate()
    .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 78, effort: 4 })
    .toFile(outputPath)

  const stat = await fs.promises.stat(outputPath)
  return {
    filepath: outputPath,
    name: webpName(originalName),
    mimeType: 'image/webp',
    size: stat.size,
    originalName,
    originalSize,
    optimized: true
  }
}

async function createLineJpeg(input, variant) {
  const variants = variant === 'preview'
    ? [
        { size: 720, quality: 72 },
        { size: 560, quality: 66 },
        { size: 420, quality: 60 }
      ]
    : [
        { size: 1920, quality: 82 },
        { size: 1600, quality: 76 },
        { size: 1280, quality: 72 },
        { size: 1024, quality: 68 }
      ]
  const maxBytes = variant === 'preview' ? 900 * 1024 : 4 * 1024 * 1024
  let output = null

  for (const option of variants) {
    output = await sharp(input)
      .rotate()
      .resize({ width: option.size, height: option.size, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: option.quality, mozjpeg: true })
      .toBuffer()
    if (output.length <= maxBytes) return output
  }

  return output
}

async function renderLineImage(req, res) {
  const requestUrl = new URL(req.url || '/', 'http://localhost')
  const fileId = typeof req.query?.fileId === 'string' ? req.query.fileId.trim() : String(requestUrl.searchParams.get('fileId') || '').trim()
  const requestedVariant = typeof req.query?.variant === 'string' ? req.query.variant : requestUrl.searchParams.get('variant')
  const variant = requestedVariant === 'preview' ? 'preview' : 'original'
  const signature = typeof req.query?.signature === 'string' ? req.query.signature : requestUrl.searchParams.get('signature') || ''
  if (!fileId || !validLineImageSignature(fileId, variant, signature)) {
    res.status(403).json({ error: 'Invalid image signature' })
    return
  }

  const drive = google.drive({ version: 'v3', auth: getDriveAuth() })
  const metadata = await drive.files.get({ fileId, fields: 'mimeType', supportsAllDrives: true })
  if (!metadata.data.mimeType?.startsWith('image/')) {
    res.status(415).json({ error: 'Unsupported image type' })
    return
  }
  const source = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' })
  const input = Buffer.from(source.data)
  const output = await createLineJpeg(input, variant)

  res.setHeader('Content-Type', 'image/jpeg')
  res.setHeader('Content-Length', String(output.length))
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.status(200).end(output)
}

async function forwardLineAction(req, body, actor) {
  const action = String(body.action || '')
  const appCheckToken = String(req.headers['x-firebase-appcheck'] || '')
  const response = await fetch(process.env.ERP_LINE_API_URL || 'https://erp.city-painter.com/api/line', {
    method: 'POST',
    headers: {
      Authorization: String(req.headers.authorization || ''),
      'Content-Type': 'application/json',
      ...(appCheckToken ? { 'X-Firebase-AppCheck': appCheckToken } : {})
    },
    body: JSON.stringify({
      action,
      eventId: body.eventId,
      attachmentIds: body.attachmentIds
    })
  })
  const result = await response.json().catch(() => null)
  return {
    status: response.status,
    body: result
      ? {
          ...result,
          ...(action === 'production-photo-status' ? { canCompleteOrder: canCompleteSalesOrder(actor) } : {})
        }
      : { ok: false, error: { message: `LINE 服務回應錯誤（HTTP ${response.status}）` } }
  }
}

async function authorizeUpload(db, actor, fields) {
  const eventId = fieldText(fields.eventId)
  const uploadKind = fieldText(fields.uploadKind)
  const commentId = fieldText(fields.commentId)
  if (!eventId || eventId.includes('/') || eventId.length > 200) {
    throw requestError('附件事件識別碼不正確', 400)
  }
  if (eventId === 'draft-event') {
    if (uploadKind === 'comment') throw requestError('留言事件不存在', 404)
    return { eventId, uploadKind: 'draft', commentId: '' }
  }

  const event = await loadEvent(db, eventId)
  if (!event) throw requestError('找不到附件對應的行事曆事件', 404)
  if (uploadKind === 'comment') {
    if (!commentId || commentId.includes('/') || commentId.length > 200) throw requestError('留言識別碼不正確', 400)
    if (!await canViewEvent(db, actor, event)) throw requestError('沒有此事件的附件上傳權限', 403)
    return { eventId, uploadKind: 'comment', commentId }
  }
  if (!await canManageEvent(db, actor, event, eventId)) throw requestError('沒有此事件的附件上傳權限', 403)
  return { eventId, uploadKind: 'event', commentId: '' }
}

async function authorizeDelete(db, actor, fileId, requestedEventId, appProperties) {
  if (actor.role === 'admin') return
  const uploadKind = text(appProperties.calendarUploadKind)
  const uploaderUid = text(appProperties.calendarUploaderUid)
  const storedEventId = text(appProperties.calendarEventId)
  if (uploadKind === 'comment' || uploadKind === 'draft') {
    if (uploaderUid === actor.uid) return
    throw requestError('沒有此附件的刪除權限', 403)
  }
  if (uploadKind === 'event' && storedEventId) {
    const event = await loadEvent(db, storedEventId)
    if (event && await canManageEvent(db, actor, event, storedEventId)) return
    throw requestError('沒有此附件的刪除權限', 403)
  }

  const eventId = text(requestedEventId)
  const event = await loadEvent(db, eventId)
  if (
    event
    && attachmentBelongsToEvent(event, fileId)
    && await canManageEvent(db, actor, event, eventId)
  ) return
  throw requestError('舊附件缺少所有權資料，僅管理員可刪除', 403)
}

async function authorizeLineAction(db, actor, body) {
  const eventId = text(body.eventId)
  const event = await loadEvent(db, eventId)
  if (!event || text(event.source) !== 'erpSalesDelivery') throw requestError('找不到對應的銷貨單事件', 404)
  if (body.action === 'production-photo-status') {
    if (!await canViewEvent(db, actor, event)) throw requestError('沒有查看此銷貨單事件的權限', 403)
    return
  }
  if (!await canManageEvent(db, actor, event, eventId)) throw requestError('沒有操作此銷貨單事件的權限', 403)
  if (body.action === 'complete-order-fulfillment' && !canCompleteSalesOrder(actor)) {
    throw requestError('沒有完成銷貨單的修改或特殊操作權限', 403)
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      await renderLineImage(req, res)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Image conversion failed'
      res.status(500).json({ error: message })
    }
    return
  }

  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }

  if (!['POST', 'DELETE'].includes(req.method || '')) {
    res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS')
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const actor = await authenticateEmployee(req)
    const db = admin.firestore()

    if (req.method === 'DELETE') {
      const { fileId, eventId } = await parseJsonBody(req)
      if (!fileId || typeof fileId !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) {
        res.status(400).json({ error: 'Missing fileId' })
        return
      }

      const auth = getDriveAuth()
      const drive = google.drive({ version: 'v3', auth })
      try {
        const metadata = await drive.files.get({
          fileId,
          fields: 'id,appProperties',
          supportsAllDrives: true
        })
        const appProperties = metadata.data.appProperties || {}
        await authorizeDelete(db, actor, fileId, eventId, appProperties)
        await drive.files.delete({ fileId })
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 404) {
          res.status(200).json({ ok: true })
          return
        }
        throw error
      }

      res.status(200).json({ ok: true })
      return
    }

    if (req.headers['content-type']?.includes('application/json')) {
      const body = await parseJsonBody(req)
      if (!['production-photo-status', 'send-production-photos', 'complete-order-fulfillment'].includes(body.action)) {
        res.status(400).json({ error: 'Unsupported action' })
        return
      }
      await authorizeLineAction(db, actor, body)
      const forwarded = await forwardLineAction(req, body, actor)
      res.status(forwarded.status).json(forwarded.body)
      return
    }

    const { fields, files } = await parseUpload(req)
    const uploadFiles = normalizeFiles(files.files)
    if (!uploadFiles.length) {
      res.status(400).json({ error: 'No files uploaded' })
      return
    }

    const auth = getDriveAuth()
    const drive = google.drive({ version: 'v3', auth })
    const folderId = process.env.GOOGLE_DRIVE_CALENDAR_FOLDER_ID || DEFAULT_DRIVE_FOLDER_ID
    const uploadContext = await authorizeUpload(db, actor, fields)

    const attachments = []
    for (const file of uploadFiles) {
      const prepared = await prepareUploadFile(file, {
        originalName: fields.originalName,
        originalSize: fields.originalSize
      })
      const created = await drive.files.create({
        requestBody: {
          name: prepared.name,
          mimeType: prepared.mimeType,
          parents: [folderId],
          appProperties: {
            calendarUploadKind: uploadContext.uploadKind,
            calendarUploaderUid: actor.uid,
            calendarEventId: uploadContext.eventId,
            ...(uploadContext.commentId ? { calendarCommentId: uploadContext.commentId } : {})
          }
        },
        media: {
          mimeType: prepared.mimeType,
          body: fs.createReadStream(prepared.filepath)
        },
        fields: 'id,name,mimeType,size,webViewLink,webContentLink'
      })

      try {
        await drive.permissions.create({
          fileId: created.data.id,
          requestBody: {
            type: 'anyone',
            role: 'reader'
          }
        })
      } catch {
        // 若雲端硬碟政策不允許公開連結，仍保留檔案的 Drive 連結。
      }

      attachments.push({
        name: created.data.name || prepared.name,
        url: created.data.webViewLink || `https://drive.google.com/file/d/${created.data.id}/view`,
        path: created.data.id || '',
        type: created.data.mimeType || prepared.mimeType,
        size: created.data.size ? Number(created.data.size) : prepared.size,
        provider: 'google-drive',
        originalName: prepared.originalName,
        originalSize: prepared.originalSize,
        optimized: prepared.optimized,
        ...(prepared.optimized && created.data.id ? lineImageUrls(created.data.id) : {})
      })

      if (prepared.optimized) {
        await fs.promises.unlink(prepared.filepath).catch(() => {})
      }
    }

    res.status(200).json({ attachments })
  } catch (error) {
    const status = Number(error?.status) || 500
    if (status >= 500) console.error('Calendar attachment API failed', error)
    const message = status >= 500 ? '附件服務處理失敗，請稍後再試' : error instanceof Error ? error.message : '附件服務處理失敗'
    res.status(status).json({ error: message })
  }
}
