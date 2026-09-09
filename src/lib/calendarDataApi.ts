import { auth, getAppCheckHeaders } from './firebase'

const DATA_URL = '/api/widget-calendar'
export async function fetchCalendarData<T>(kind: string, params: Record<string, string> = {}, maxRows = Infinity, signal?: AbortSignal): Promise<T[]> {
  const user = auth.currentUser
  if (!user) throw new Error('請先登入')
  const rows: T[] = []
  let cursor: string | null = null
  do {
    const query: URLSearchParams = new URLSearchParams({ action: 'data', kind, ...params, ...(cursor ? { cursor } : {}) })
    const response: Response = await fetchWithTimeout(`${DATA_URL}?${query}`, {
      headers: { Authorization: `Bearer ${await user.getIdToken()}`, ...await getAppCheckHeaders(true) }, cache: 'no-store', signal,
    })
    const result: { ok?: boolean; rows?: T[]; cursor?: string | null; error?: string } = await response.json()
    if (!response.ok || !result.ok || !Array.isArray(result.rows)) throw new Error(result.error || '行事曆讀取失敗')
    if (auth.currentUser?.uid !== user.uid) throw new Error('登入帳號已變更')
    rows.push(...result.rows)
    cursor = result.cursor || null
  } while (cursor && rows.length < maxRows)
  return rows.slice(0, maxRows)
}
export async function createCalendarActivity(body: Record<string, unknown>, kind = 'activity', params: Record<string, string> = {}) {
  const user = auth.currentUser
  if (!user) throw new Error('請先登入')
  const response: Response = await fetchWithTimeout(`${DATA_URL}?${new URLSearchParams({ action: 'data', kind, ...params })}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await user.getIdToken()}`, ...await getAppCheckHeaders(true) },
    body: JSON.stringify(body),
  })
  const result = await response.json()
  if (!response.ok || !result.ok) throw new Error(result.error || '活動紀錄儲存失敗')
}

export async function getCalendarEventSnapshot(id: string) {
  const rows = await fetchCalendarData<import('../types').CalendarEvent>('event', { eventId: id })
  return { id, exists: () => rows.length > 0, data: (): Partial<Omit<import('../types').CalendarEvent, 'id'>> => { if (!rows[0]) return {}; const { id: _id, ...data } = rows[0]; return data } }
}

async function fetchWithTimeout(url: string, options: RequestInit) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (options.signal?.aborted) controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 20000)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    const body = await response.arrayBuffer()
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}
