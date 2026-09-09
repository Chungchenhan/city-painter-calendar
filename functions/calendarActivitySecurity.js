const { loadActiveIdentity, validDocumentId } = require('./calendarPushIdentity')
const { canReadCalendarEvent, canNotifyCalendarEvent } = require('./calendarEventAccess')

async function trustedActivityEvent(db, auth, log) {
  if (log?.serverVerified !== true || !validDocumentId(log.eventId) || !validDocumentId(log.actorUid)) return null
  const actor = await loadActiveIdentity(db, auth, log.actorUid)
  if (!actor) return null
  const snapshot = await db.collection('calendarEvents').doc(log.eventId).get()
  const event = snapshot.exists ? { ...snapshot.data(), id: log.eventId }
    : log.action === 'delete' && log.eventSnapshot && typeof log.eventSnapshot === 'object'
      ? { ...log.eventSnapshot, id: log.eventId } : null
  if (!event || !await canNotifyCalendarEvent(db, actor, event)) return null
  return { event, actor }
}

async function canSendEventToSubscription(db, sub, event) {
  return Boolean(sub.actor && await canReadCalendarEvent(db, sub.actor, event))
}
module.exports = { trustedActivityEvent, canSendEventToSubscription }
