function validDocumentId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !value.includes('/')
}

async function loadActiveIdentity(db, auth, uid) {
  if (!validDocumentId(uid)) return null
  const roleSnap = await db.collection('userRoles').doc(uid).get()
  const role = roleSnap.exists ? roleSnap.data() : null
  if (!role || !['admin', 'employee'].includes(role.role) || role.enabled === false || role.disabled === true || !validDocumentId(role.employeeId)) return null
  const [employeeSnap, account] = await Promise.all([
    db.collection('employees').doc(role.employeeId).get(),
    auth.getUser(uid).catch((error) => {
      if (error.code === 'auth/user-not-found') return null
      throw error
    }),
  ])
  const employee = employeeSnap.exists ? employeeSnap.data() : null
  if (!account || account.disabled || !employee || employee.status !== 'active' || employee.resignDate) return null
  return { uid, role: role.role, employeeId: role.employeeId, employee, email: account.email || '', displayName: employee.nickname || employee.name || account.displayName || '' }
}

function validPushSubscription(subscription) {
  try {
    const url = new URL(subscription?.endpoint)
    const hosts = ['fcm.googleapis.com', 'web.push.apple.com', 'updates.push.services.mozilla.com']
    const allowed = hosts.includes(url.hostname) || url.hostname.endsWith('.notify.windows.com')
    return allowed && url.protocol === 'https:' && !url.username && !url.password && !url.port
      && typeof subscription.keys?.p256dh === 'string' && /^[A-Za-z0-9_-]{80,100}={0,2}$/.test(subscription.keys.p256dh)
      && typeof subscription.keys?.auth === 'string' && /^[A-Za-z0-9_-]{20,30}={0,2}$/.test(subscription.keys.auth)
  } catch {
    return false
  }
}

async function trustedSubscriptions(db, auth, subscriptions) {
  const identities = new Map()
  const result = []
  for (const sub of subscriptions) {
    if (!validDocumentId(sub.uid) || !validPushSubscription(sub.subscription)) continue
    if (!identities.has(sub.uid)) identities.set(sub.uid, await loadActiveIdentity(db, auth, sub.uid))
    const identity = identities.get(sub.uid)
    // 舊訂閱也必須重新核對，避免過去可自填的員工編號繼續收取他人通知。
    if (!identity || identity.employeeId !== sub.employeeId) continue
    result.push({ ...sub, role: identity.role, employeeId: identity.employeeId, actor: identity })
  }
  return result
}

module.exports = { validDocumentId, loadActiveIdentity, validPushSubscription, trustedSubscriptions }
