const text = (value) => typeof value === 'string' ? value.trim() : ''
const list = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []

async function canReadCalendarEvent(db, actor, event) {
  if (!actor || !event) return false
  if (actor.role === 'admin') return true
  const cache = actor.calendarAccessCache || (actor.calendarAccessCache = new Map())
  const read = (collection, id) => {
    const key = `${collection}/${id}`
    if (!cache.has(key)) cache.set(key, db.collection(collection).doc(id).get())
    return cache.get(key)
  }
  const departmentMatches = async (id) => {
    if (!id || id.includes('/')) return false
    if (id === actor.employee.departmentId) return true
    const snap = await read('departments', id)
    return Boolean(actor.employee.departmentName && snap.exists && snap.data().name === actor.employee.departmentName)
  }
  const matchesAny = async (ids) => {
    for (const id of list(ids)) if (await departmentMatches(id)) return true
    return false
  }
  if (list(event.visibleAssigneeIds).includes(actor.employeeId) || await matchesAny(event.visibleDepartmentIds)) return true
  if (list(event.hiddenAssigneeIds).includes(actor.employeeId) || await matchesAny(event.hiddenDepartmentIds)) return false
  const calendarIds = list(event.calendarIds).length ? list(event.calendarIds) : [text(event.calendarId)].filter(Boolean)
  const departments = [...new Set([text(event.departmentId), ...calendarIds.filter((id) => id.startsWith('department:')).map((id) => id.slice(11))].filter(Boolean))]
  for (const id of departments) {
    if (id.includes('/')) return false
    const snap = await read('departments', id)
    if (snap.exists && snap.data().name === '管理部' && actor.employee.departmentName !== '管理部') return false
  }
  // 非管理部工作原本跨部門共享；只將現有可見限制落在伺服器，不縮減共享範圍。
  if (departments.length > 0) return true
  for (const id of calendarIds.filter((id) => !id.startsWith('department:'))) {
    if (id.includes('/')) continue
    const snap = await read('calendarCalendars', id)
    if (!snap.exists) continue
    const calendar = snap.data()
    if (calendar.name === '管理部' && actor.employee.departmentName !== '管理部') continue
    if (calendar.isCompanyWide === true || list(calendar.employeeIds).includes(actor.employeeId) || await matchesAny(calendar.departmentIds)) return true
  }
  return calendarIds.length === 0 && departments.length === 0
    && (list(event.assigneeIds).length === 0 || list(event.assigneeIds).includes(actor.employeeId))
}

async function canNotifyCalendarEvent(db, actor, event) {
  if (!await canReadCalendarEvent(db, actor, event)) return false
  return actor.role === 'admin' || actor.employee.departmentName === '管理部'
    || event.createdBy === actor.uid || list(event.assigneeIds).includes(actor.employeeId)
    || (Boolean(actor.employee.departmentId) && event.departmentId === actor.employee.departmentId)
}

module.exports = { canReadCalendarEvent, canNotifyCalendarEvent }
