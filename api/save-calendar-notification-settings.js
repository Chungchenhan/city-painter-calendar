import { calendarServices, authenticateCalendar, responseHeaders, readJson, respondError } from '../shared/calendarApiSecurity.js'

export function createHandler(getServices = calendarServices) {
  return async function handler(req, res) {
    responseHeaders(req, res)
    if (req.method === 'OPTIONS') return res.status(204).end()
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    try {
      const services = getServices()
      const actor = await authenticateCalendar(req, services)
      const body = await readJson(req)
      const settings = body.settings || {}
      const payload = {
        shiftStartEnabled: typeof settings.shiftStartEnabled === 'boolean' ? settings.shiftStartEnabled : true,
        shiftEndEnabled: typeof settings.shiftEndEnabled === 'boolean' ? settings.shiftEndEnabled : false,
        updatedAt: new Date().toISOString(),
      }
      const batch = services.db.batch()
      batch.set(services.db.collection('calendarNotificationSettings').doc(actor.uid), payload, { merge: true })
      batch.set(services.db.collection('calendarNotificationSettings').doc(actor.employeeId), payload, { merge: true })
      await batch.commit()
      return res.status(200).json({ ok: true, settings: payload })
    } catch (error) {
      return respondError(res, error)
    }
  }
}

export default createHandler()
