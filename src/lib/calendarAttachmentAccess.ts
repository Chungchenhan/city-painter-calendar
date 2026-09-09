import { useCallback, useEffect, useState } from 'react'
import { auth, getAppCheckHeaders, getFirebaseIdToken } from './firebase'

type Links = { lineOriginalUrl: string; linePreviewUrl: string; downloadUrl: string }
const pending = new Map<string, Promise<Links>>()

export function calendarDriveFileId(source: string): string {
  try {
    const url = new URL(source, window.location.origin)
    if (url.searchParams.get('scope') === 'sales-attachment') return ''
    if (url.pathname === '/api/upload-drive') return url.searchParams.get('fileId') || ''
    if (url.hostname === 'drive.google.com') return url.pathname.match(/\/file\/d\/([^/]+)/)?.[1] || url.searchParams.get('id') || ''
  } catch { return '' }
  return ''
}

export async function requestCalendarAttachmentLinks(eventId: string, fileId: string): Promise<Links> {
  const user = auth.currentUser
  if (!user) throw new Error('請先登入')
  const key = `${user.uid}:${eventId}:${fileId}`
  const existing = pending.get(key)
  if (existing) return existing
  const request = (async () => {
    const [token, headers] = await Promise.all([getFirebaseIdToken(user), getAppCheckHeaders(true)])
    const response = await fetch('/api/upload-drive', {
      method: 'POST',
      headers: { ...headers, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'calendar-attachment-links', eventId, fileIds: [fileId] }),
      signal: AbortSignal.timeout(20_000),
    })
    const result = await response.json()
    if (!response.ok || !result.links?.[0]) throw new Error(result.error || '附件授權失敗')
    return result.links[0] as Links
  })()
  pending.set(key, request)
  try { return await request } finally { pending.delete(key) }
}

export function useCalendarAttachmentAccess(eventId: string | undefined, fileId: string) {
  const [links, setLinks] = useState<Links | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const retry = useCallback(() => setRevision((value) => value + 1), [])
  useEffect(() => {
    setLinks(null)
    setError('')
    if (!eventId || !fileId) return
    let active = true
    const refresh = () => requestCalendarAttachmentLinks(eventId, fileId).then((value) => {
      if (active) { setLinks(value); setError('') }
    }).catch((reason) => { if (active) { setLinks(null); setError(reason instanceof Error ? reason.message : '附件授權失敗') } })
    void refresh()
    const interval = window.setInterval(() => { void refresh() }, 8 * 60_000)
    return () => { active = false; window.clearInterval(interval) }
  }, [eventId, fileId, revision])
  return { links, error, retry }
}
