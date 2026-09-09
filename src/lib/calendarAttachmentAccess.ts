import { useCallback, useEffect, useState } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import { auth, getAppCheckHeaders, getFirebaseIdToken } from './firebase'
import { createCalendarAttachmentLinkCache } from './calendarAttachmentLinkCache'

const cache = createCalendarAttachmentLinkCache({
  async load(uid, eventId, fileIds) {
    const user = auth.currentUser
    if (!user || user.uid !== uid) throw new Error('請先登入')
    const [token, headers] = await Promise.all([getFirebaseIdToken(user), getAppCheckHeaders(true)])
    if (auth.currentUser?.uid !== uid) throw new Error('登入帳號已變更')
    const response = await fetch('/api/upload-drive', {
      method: 'POST',
      headers: { ...headers, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'calendar-attachment-links', eventId, fileIds }),
      signal: AbortSignal.timeout(20_000),
    })
    const result = await response.json()
    if (!response.ok) throw Object.assign(new Error(result.error || '附件授權失敗'), { status: response.status })
    return result
  },
})
const identityListeners = new Set<() => void>()
onAuthStateChanged(auth, (user) => {
  cache.setIdentity(user?.uid || '')
  for (const listener of identityListeners) listener()
})
function syncIdentity() { cache.setIdentity(auth.currentUser?.uid || '') }

export function calendarDriveFileId(source: string): string {
  try {
    const url = new URL(source, window.location.origin)
    if (url.searchParams.get('scope') === 'sales-attachment') return ''
    if (url.pathname === '/api/upload-drive') return url.searchParams.get('fileId') || ''
    if (url.hostname === 'drive.google.com') return url.pathname.match(/\/file\/d\/([^/]+)/)?.[1] || url.searchParams.get('id') || ''
  } catch { return '' }
  return ''
}

export function getCachedCalendarAttachmentLinks(eventId: string, fileId: string) {
  syncIdentity()
  return cache.peek(eventId, fileId)?.links ?? null
}

export function requestCalendarAttachmentLinks(eventId: string, fileId: string) {
  syncIdentity()
  return cache.request(eventId, fileId)
}

export async function prefetchCalendarAttachmentLinks(eventId: string, fileIds: string[]) {
  const results = await Promise.allSettled([...new Set(fileIds)].filter(Boolean).map((fileId) => requestCalendarAttachmentLinks(eventId, fileId)))
  return results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
}

export function useCalendarAttachmentAccess(eventId: string | undefined, fileId: string) {
  const [, render] = useState(0)
  const uid = auth.currentUser?.uid || ''
  const scope = JSON.stringify([uid, eventId, fileId])
  const [failure, setFailure] = useState({ scope: '', message: '' })
  const [revision, setRevision] = useState(0)
  const retry = useCallback(() => setRevision((value) => value + 1), [])
  const links = eventId && fileId ? getCachedCalendarAttachmentLinks(eventId, fileId) : null
  useEffect(() => {
    const listener = () => render((value) => value + 1)
    identityListeners.add(listener)
    return () => { identityListeners.delete(listener) }
  }, [])
  useEffect(() => {
    if (!uid || !eventId || !fileId) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      setFailure({ scope, message: '' })
      render((value) => value + 1)
      try {
        await requestCalendarAttachmentLinks(eventId, fileId)
        if (!active || auth.currentUser?.uid !== uid) return
        render((value) => value + 1)
        const entry = cache.peek(eventId, fileId)
        timer = setTimeout(() => { void refresh() }, Math.max(1000, (entry?.expiresAt ?? Date.now()) - Date.now()))
      } catch (reason) {
        if (active && auth.currentUser?.uid === uid) {
          setFailure({ scope, message: reason instanceof Error ? reason.message : '附件授權失敗' })
        }
      }
    }
    void refresh()
    return () => { active = false; clearTimeout(timer) }
  }, [uid, eventId, fileId, revision, scope])
  return { links, error: failure.scope === scope ? failure.message : '', retry }
}
