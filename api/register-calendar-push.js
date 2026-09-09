import { createHash } from 'node:crypto'
import identity from '../functions/calendarPushIdentity.js'
import { apiError, calendarServices, authenticateCalendar, responseHeaders, readJson, respondError } from '../shared/calendarApiSecurity.js'

export function createHandler(getServices = calendarServices) {
  return async function handler(req, res) {
    responseHeaders(req, res)
    if (req.method === 'OPTIONS') return res.status(204).end()
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    try {
      const services = getServices()
      const actor = await authenticateCalendar(req, services)
      const body = await readJson(req)
      if (!identity.validPushSubscription(body.subscription)) throw apiError(400, '推播訂閱格式不正確')
      const { endpoint, keys } = body.subscription
      const subscription = { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }
      const id = createHash('sha256').update(endpoint).digest('hex')
      await services.db.collection('calendarNotificationSubscriptions').doc(id).set({
        uid: actor.uid,
        email: actor.email,
        displayName: actor.displayName,
        role: actor.role,
        employeeId: actor.employeeId,
        endpoint,
        subscription,
        enabled: true,
        updatedAt: services.fieldValue.serverTimestamp(),
      })
      return res.status(200).json({ ok: true, id })
    } catch (error) {
      return respondError(res, error)
    }
  }
}

export default createHandler()
