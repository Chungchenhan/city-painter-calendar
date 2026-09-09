import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import admin from 'firebase-admin'
import identity from '../functions/calendarPushIdentity.js'

export function apiError(status, message) {
  return Object.assign(new Error(message), { status })
}

export function calendarServices() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_JSON
      || (process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 && Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64, 'base64').toString('utf8'))
      || fs.readFileSync(path.join(os.homedir(), '.firebase', 'service-account.json'), 'utf8')
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: 'city-painter-erp' })
  }
  return { db: admin.firestore(), auth: admin.auth(), appCheck: admin.appCheck(), fieldValue: admin.firestore.FieldValue }
}

export async function authenticateCalendar(req, services) {
  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ') || header.length > 10000) throw apiError(401, '請重新登入')
  let decoded
  try {
    decoded = await services.auth.verifyIdToken(header.slice(7), true)
  } catch {
    throw apiError(401, '登入已失效')
  }
  if (decoded.accountType === 'customer') throw apiError(403, '客戶帳號無法使用內部行事曆')
  const appCheckToken = req.headers['x-firebase-appcheck']
  if (typeof appCheckToken !== 'string' || !appCheckToken) throw apiError(401, '缺少網站安全驗證')
  try {
    await services.appCheck.verifyToken(appCheckToken)
  } catch {
    throw apiError(401, '網站安全驗證失敗')
  }
  const actor = await identity.loadActiveIdentity(services.db, services.auth, decoded.uid)
  if (!actor) throw apiError(403, '此員工帳號無法使用行事曆')
  return { ...actor, decoded }
}

export function responseHeaders(req, res) {
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Vary', 'Origin, Authorization, X-Firebase-AppCheck')
  const origin = req.headers.origin
  if (typeof origin === 'string' && ['https://sch.city-painter.com', 'https://macbook-air.tail7313ae.ts.net:5175', 'http://localhost:5175', 'http://127.0.0.1:5175'].includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Firebase-AppCheck')
}

export async function readJson(req) {
  try {
    let body = req.body
    if (body === undefined) {
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk)
        if (size > 16384) throw apiError(413, '請求內容過大')
        chunks.push(Buffer.from(chunk))
      }
      body = Buffer.concat(chunks).toString('utf8') || '{}'
    }
    if (typeof body === 'string' || Buffer.isBuffer(body)) body = JSON.parse(body.toString())
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid body')
    return body
  } catch (error) {
    if (error.status) throw error
    throw apiError(400, '請求格式不正確')
  }
}

export function respondError(res, error) {
  const status = Number(error?.status) || 500
  return res.status(status).json({ error: status < 500 ? error.message : '服務暫時無法使用，請稍後再試' })
}
