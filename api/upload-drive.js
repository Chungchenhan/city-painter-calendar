import fs from 'node:fs'
import { google } from 'googleapis'
import formidable from 'formidable'

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
      const created = await drive.files.create({
        requestBody: {
          name: file.originalFilename || file.newFilename,
          mimeType: file.mimetype || 'application/octet-stream',
          parents: [folderId]
        },
        media: {
          mimeType: file.mimetype || 'application/octet-stream',
          body: fs.createReadStream(file.filepath)
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
        name: created.data.name || file.originalFilename || file.newFilename,
        url: created.data.webViewLink || `https://drive.google.com/file/d/${created.data.id}/view`,
        path: created.data.id || '',
        type: created.data.mimeType || file.mimetype || undefined,
        size: created.data.size ? Number(created.data.size) : file.size,
        provider: 'google-drive'
      })
    }

    res.status(200).json({ attachments })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Upload failed'
    res.status(500).json({ error: message })
  }
}
