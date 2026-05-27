import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import admin from 'firebase-admin'

const PROJECT_ID = 'city-painter-erp'

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || '*'
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

function serviceAccountJson() {
  const source = process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 && Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64, 'base64').toString('utf8')
  if (source) return JSON.parse(source)

  const localPath = path.join(os.homedir(), '.firebase', 'service-account.json')
  if (fs.existsSync(localPath)) return JSON.parse(fs.readFileSync(localPath, 'utf8'))
  throw new Error('Missing Firebase service account credentials')
}

function getAdminApp() {
  if (admin.apps.length > 0) return admin.app()

  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccountJson()),
    projectId: PROJECT_ID,
  })
}

async function verifyRequest(req) {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token) return null

  try {
    return await admin.auth().verifyIdToken(token)
  } catch {
    return null
  }
}

async function readBody(req) {
  if (req.body) return req.body
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function cleanBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

export default async function handler(req, res) {
  setCorsHeaders(req, res)

  if (req.method === 'OPTIONS') {
    return res.status(204).end()
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    getAdminApp()
    const decoded = await verifyRequest(req)
    if (!decoded?.uid) return res.status(401).json({ error: 'Unauthorized' })

    const body = await readBody(req)
    const settings = body?.settings || {}
    const roleSnap = await admin.firestore().collection('userRoles').doc(decoded.uid).get()
    const employeeId = roleSnap.exists ? roleSnap.data()?.employeeId : ''
    const payload = {
      shiftStartEnabled: cleanBoolean(settings.shiftStartEnabled, true),
      shiftEndEnabled: cleanBoolean(settings.shiftEndEnabled, false),
      updatedAt: new Date().toISOString(),
    }

    const db = admin.firestore()
    await db.collection('calendarNotificationSettings').doc(decoded.uid).set(payload, { merge: true })
    if (employeeId) {
      await db.collection('calendarNotificationSettings').doc(employeeId).set(payload, { merge: true })
    }
    return res.status(200).json({ ok: true, settings: payload })
  } catch (error) {
    console.error(error)
    return res.status(500).json({ error: 'Internal server error' })
  }
}
