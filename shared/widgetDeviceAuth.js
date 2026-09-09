import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import identity from '../functions/calendarPushIdentity.js'
import { apiError, authenticateCalendar, readJson, responseHeaders } from './calendarApiSecurity.js'

const COLLECTION = 'calendarWidgetDevices'
const LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
const digest = value => createHash('sha256').update(value).digest('hex')

export function parseWidgetCredential(value) {
  if (typeof value !== 'string' || !/^wd1\.[a-f0-9]{64}\.[A-Za-z0-9_-]{43}$/.test(value)) return null
  const [, id, secret] = value.split('.')
  return { id, hash: digest(secret) }
}

async function credentialRecord(db, credential) {
  const parsed = parseWidgetCredential(credential)
  if (!parsed) throw apiError(401, '請開啟行事曆 App 登入以啟用小工具')
  const ref = db.collection(COLLECTION).doc(parsed.id)
  const snap = await ref.get()
  const data = snap.exists ? snap.data() : null
  if (!data || typeof data.secretHash !== 'string' || !/^[a-f0-9]{64}$/.test(data.secretHash)
    || !timingSafeEqual(Buffer.from(parsed.hash, 'hex'), Buffer.from(data.secretHash, 'hex'))
    || data.revokedAt || !(data.expiresAt > Date.now())) throw apiError(401, '小工具授權已失效，請重新開啟 App')
  return { ref, data }
}

export async function authenticateWidgetDevice(req, db, auth) {
  const { data } = await credentialRecord(db, req.headers['x-widget-token'])
  const [actor, account] = await Promise.all([
    identity.loadActiveIdentity(db, auth, data.uid),
    auth.getUser(data.uid).catch(() => null),
  ])
  const validAfter = account?.tokensValidAfterTime ? Date.parse(account.tokensValidAfterTime) : 0
  if (!actor || actor.employeeId !== data.employeeId || !account || account.disabled
    || !(data.authTime > 0) || (Number.isFinite(validAfter) && data.authTime * 1000 < validAfter)) {
    throw apiError(403, '此帳號的小工具授權已停用')
  }
  return actor
}

export async function handleWidgetDevice(req, res, services) {
  responseHeaders(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const body = await readJson(req)
  if (req.query.action === 'widget-device-revoke') {
    const parsed = parseWidgetCredential(req.headers['x-widget-token'])
    if (!parsed) throw apiError(401, 'Invalid device credential')
    const { ref } = await credentialRecord(services.db, req.headers['x-widget-token'])
    await ref.update({ revokedAt: Date.now() })
    return res.status(200).json({ ok: true })
  }
  const actor = await authenticateCalendar(req, services)
  if (typeof body.deviceId !== 'string' || !/^[a-f0-9-]{36}$/i.test(body.deviceId)) throw apiError(400, 'Invalid device id')
  if (!Number.isInteger(actor.decoded.auth_time) || actor.decoded.auth_time <= 0) throw apiError(401, '請重新登入')
  const id = digest(`${actor.uid}:${body.deviceId.toLowerCase()}`)
  const secret = randomBytes(32).toString('base64url')
  const expiresAt = Date.now() + LIFETIME_MS
  await services.db.collection(COLLECTION).doc(id).set({
    uid: actor.uid, employeeId: actor.employeeId, secretHash: digest(secret),
    authTime: actor.decoded.auth_time, issuedAt: Date.now(), expiresAt, revokedAt: null,
  })
  return res.status(200).json({ credential: `wd1.${id}.${secret}`, expiresAt, uid: actor.uid })
}
