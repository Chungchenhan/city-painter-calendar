import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { google } from 'googleapis'
import formidable from 'formidable'
import sharp from 'sharp'

const DEFAULT_DRIVE_FOLDER_ID = '1aqx7A8VwTKBSltaEj0IFoOXQP4HUJWF4'

export const config = {
  api: {
    bodyParser: false
  }
}

function getServiceAccountCredentials() {
  const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  const base64Json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64
  const source = rawJson || (base64Json ? Buffer.from(base64Json, 'base64').toString('utf8') : '')
  if (!source) throw new Error('Missing Google service account credentials')
  return JSON.parse(source)
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const { files } = await parseUpload(req)
    const uploadFiles = normalizeFiles(files.files)
    if (!uploadFiles.length) {
      res.status(400).json({ error: 'No files uploaded' })
      return
    }

    const credentials = getServiceAccountCredentials()
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive']
    })
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
        optimized: prepared.optimized
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
