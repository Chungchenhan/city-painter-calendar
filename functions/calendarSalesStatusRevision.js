const REVISION_DOCUMENT_PATH = 'calendarSalesStatusRevisions/global'

function buildCalendarSalesStatusRevisionUpdate({
  line,
  payment,
  fieldValue,
}) {
  const update = {
    version: 1,
    updatedAt: fieldValue.serverTimestamp(),
  }
  if (line) {
    update.lineVersion = fieldValue.increment(1)
    update.lineUpdatedAt = fieldValue.serverTimestamp()
  }
  if (payment) {
    update.paymentVersion = fieldValue.increment(1)
    update.paymentUpdatedAt = fieldValue.serverTimestamp()
  }
  return update
}

async function bumpCalendarSalesStatusRevision({
  db,
  fieldValue,
  line = false,
  payment = false,
}) {
  if (!line && !payment) return
  await db.doc(REVISION_DOCUMENT_PATH).set(buildCalendarSalesStatusRevisionUpdate({
    line,
    payment,
    fieldValue,
  }), { merge: true })
}

module.exports = {
  REVISION_DOCUMENT_PATH,
  buildCalendarSalesStatusRevisionUpdate,
  bumpCalendarSalesStatusRevision,
}
