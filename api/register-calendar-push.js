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

async function subscriptionId(endpoint) {
  const data = new TextEncoder().encode(endpoint)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuffer)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
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
    const subscription = body?.subscription
    const endpoint = subscription?.endpoint
    if (!endpoint || typeof endpoint !== 'string') {
      return res.status(400).json({ error: 'Missing push subscription' })
    }

    const db = admin.firestore()
    const id = await subscriptionId(endpoint)
    await db.collection('calendarNotificationSubscriptions').doc(id).set({
      uid: decoded.uid,
      email: decoded.email || '',
      displayName: body.displayName || decoded.name || decoded.email || '',
      role: body.role || 'unknown',
      employeeId: body.employeeId || null,
      endpoint,
      subscription,
      enabled: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true })

    return res.status(200).json({ ok: true, id })
  } catch (error) {
    console.error(error)
    return res.status(500).json({ error: 'Internal server error' })
  }
}
