export type CalendarAttachmentLinks = { lineOriginalUrl: string; linePreviewUrl: string; downloadUrl: string }
type BatchResult = { expiresAt: number; links: (CalendarAttachmentLinks & { fileId: string })[] }
type Entry = { links: CalendarAttachmentLinks; expiresAt: number }
type Pending = { resolve: (value: CalendarAttachmentLinks) => void; reject: (error: unknown) => void; promise: Promise<CalendarAttachmentLinks> }

export function createCalendarAttachmentLinkCache(options: {
  load: (uid: string, eventId: string, fileIds: string[]) => Promise<BatchResult>
  now?: () => number
  capacity?: number
}) {
  const now = options.now ?? Date.now
  const capacity = options.capacity ?? 512
  const cache = new Map<string, Entry>()
  const pending = new Map<string, Pending>()
  const queued = new Map<string, Set<string>>()
  let uid = ''
  let generation = 0
  let scheduled = false
  const key = (eventId: string, fileId: string) => JSON.stringify([eventId, fileId])
  function setIdentity(next: string) {
    if (uid === next) return
    uid = next
    generation += 1
    cache.clear()
    queued.clear()
    for (const item of pending.values()) item.reject(new Error('登入帳號已變更'))
    pending.clear()
  }
  function peek(eventId: string, fileId: string): Entry | undefined {
    for (const [id, entry] of cache) if (entry.expiresAt <= now()) cache.delete(id)
    const id = key(eventId, fileId)
    const entry = cache.get(id)
    if (entry) { cache.delete(id); cache.set(id, entry) }
    return entry
  }
  async function batch(eventId: string, ids: string[], owner: string, version: number) {
    try {
      const response = await options.load(owner, eventId, ids)
      if (version !== generation || owner !== uid) return
      const expiresAt = Math.min(response.expiresAt - 30_000, now() + 8 * 60_000)
      for (const fileId of ids) {
        const id = key(eventId, fileId)
        const item = pending.get(id)
        const links = response.links.find((link) => link.fileId === fileId)
        if (!links || !Number.isFinite(expiresAt) || expiresAt <= now()) {
          item?.reject(new Error('附件授權失敗'))
        } else {
          cache.set(id, { links, expiresAt })
          while (cache.size > capacity) cache.delete(cache.keys().next().value!)
          item?.resolve(links)
        }
        pending.delete(id)
      }
    } catch (error) {
      if (version !== generation) return
      // 單一已移除的附件不能連帶阻止同事件其他照片載入。
      if (ids.length > 1 && (error as { status?: number })?.status === 403) {
        for (const fileId of ids) await batch(eventId, [fileId], owner, version)
        return
      }
      for (const fileId of ids) { const id = key(eventId, fileId); pending.get(id)?.reject(error); pending.delete(id) }
    }
  }
  async function flush() {
    const owner = uid
    const version = generation
    const tasks: Array<{ eventId: string; ids: string[] }> = []
    for (const [eventId, files] of queued) {
      const ids = [...files]
      for (let offset = 0; offset < ids.length; offset += 20) tasks.push({ eventId, ids: ids.slice(offset, offset + 20) })
    }
    queued.clear()
    // 批次背景工作限流，避免大量附件搶佔主要操作的連線。
    await Promise.all(Array.from({ length: Math.min(2, tasks.length) }, async () => {
      while (tasks.length && version === generation) {
        const task = tasks.shift()!
        await batch(task.eventId, task.ids, owner, version)
      }
    }))
    scheduled = false
    if (queued.size) { scheduled = true; queueMicrotask(() => { void flush() }) }
  }
  function request(eventId: string, fileId: string): Promise<CalendarAttachmentLinks> {
    if (!uid) return Promise.reject(new Error('請先登入'))
    const existing = peek(eventId, fileId)
    if (existing) return Promise.resolve(existing.links)
    const id = key(eventId, fileId)
    if (pending.has(id)) return pending.get(id)!.promise
    if (pending.size >= capacity) return Promise.reject(new Error('附件載入繁忙，請稍後重試'))
    let resolve!: Pending['resolve']
    let reject!: Pending['reject']
    const promise = new Promise<CalendarAttachmentLinks>((done, fail) => { resolve = done; reject = fail })
    pending.set(id, { promise, resolve, reject })
    if (!queued.has(eventId)) queued.set(eventId, new Set())
    queued.get(eventId)!.add(fileId)
    if (!scheduled) { scheduled = true; queueMicrotask(() => { void flush() }) }
    return promise
  }
  return { setIdentity, peek, request }
}
