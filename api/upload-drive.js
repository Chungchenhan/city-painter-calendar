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

function isImage(file) {
  return Boolean(file.mimetype?.startsWith('image/')) && file.mimetype !== 'image/svg+xml'
}

function webpName(filename) {
  const parsed = path.parse(filename || 'image')
  return `${parsed.name || 'image'}.webp`
}

async function prepareUploadFile(file) {
  if (!isImage(file)) {
    return {
      filepath: file.filepath,
      name: file.originalFilename || file.newFilename,
      mimeType: file.mimetype || 'application/octet-stream',
      size: file.size,
      originalName: file.originalFilename || file.newFilename,
      originalSize: file.size,
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
    name: webpName(file.originalFilename || file.newFilename),
    mimeType: 'image/webp',
    size: stat.size,
    originalName: file.originalFilename || file.newFilename,
    originalSize: file.size,
    optimized: true
  }
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
  let output = await sharp(input)
    .rotate()
    .resize({ width: variant === 'preview' ? 720 : 1920, height: variant === 'preview' ? 720 : 1920, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: variant === 'preview' ? 72 : 84, mozjpeg: true })
    .toBuffer()

  if (variant === 'preview' && output.length > 1024 * 1024) {
    output = await sharp(input)
      .rotate()
      .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 62, mozjpeg: true })
      .toBuffer()
  }

  res.setHeader('Content-Type', 'image/jpeg')
  res.setHeader('Content-Length', String(output.length))
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.status(200).end(output)
}

async function forwardLineAction(req, body) {
  const action = body.action === 'production-photo-status' ? 'production-photo-status' : 'send-production-photos'
  const response = await fetch(process.env.ERP_LINE_API_URL || 'https://erp.city-painter.com/api/line', {
    method: 'POST',
    headers: {
      Authorization: String(req.headers.authorization || ''),
      'Content-Type': 'application/json'
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
    body: result || { ok: false, error: { message: `LINE 服務回應錯誤（HTTP ${response.status}）` } }
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
    const decoded = await verifyRequest(req)
    if (!decoded?.uid) {
      res.status(401).json({ error: '登入已失效，請重新登入' })
      return
    }

    if (req.method === 'DELETE') {
      const { fileId } = await parseJsonBody(req)
      if (!fileId || typeof fileId !== 'string') {
        res.status(400).json({ error: 'Missing fileId' })
        return
      }

      const auth = getDriveAuth()
      const drive = google.drive({ version: 'v3', auth })
      try {
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
      if (!['production-photo-status', 'send-production-photos'].includes(body.action)) {
        res.status(400).json({ error: 'Unsupported action' })
        return
      }
      const forwarded = await forwardLineAction(req, body)
      res.status(forwarded.status).json(forwarded.body)
      return
    }

    const { files } = await parseUpload(req)
    const uploadFiles = normalizeFiles(files.files)
    if (!uploadFiles.length) {
      res.status(400).json({ error: 'No files uploaded' })
      return
    }

    const auth = getDriveAuth()
    const drive = google.drive({ version: 'v3', auth })
    const folderId = process.env.GOOGLE_DRIVE_CALENDAR_FOLDER_ID || DEFAULT_DRIVE_FOLDER_ID

    const attachments = []
    for (const file of uploadFiles) {
      const prepared = await prepareUploadFile(file)
      const created = await drive.files.create({
        requestBody: {
          name: prepared.name,
          mimeType: prepared.mimeType,
          parents: [folderId]
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
    const message = error instanceof Error ? error.message : 'Upload failed'
    res.status(500).json({ error: message })
  }
}
