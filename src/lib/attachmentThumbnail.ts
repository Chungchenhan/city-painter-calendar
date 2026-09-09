export type AttachmentThumbnailSource = {
  name: string
  url: string
  path?: string
  type?: string
  provider?: 'google-drive' | 'firebase-storage'
  lineOriginalUrl?: string
  linePreviewUrl?: string
}

export function isImageAttachment(attachment: AttachmentThumbnailSource) {
  if (attachment.type?.startsWith('image/')) return true
  return /\.(png|jpe?g|webp|gif)$/i.test(attachment.name)
}

export function attachmentThumbnailSources(attachment: AttachmentThumbnailSource) {
  if (!isImageAttachment(attachment)) return []

  const candidates = [
    attachment.linePreviewUrl,
    attachment.lineOriginalUrl,
    attachment.provider === 'google-drive' && attachment.path
      ? `https://drive.google.com/thumbnail?id=${encodeURIComponent(attachment.path)}&sz=w1000`
      : '',
    attachment.url,
  ]
  const seen = new Set<string>()
  return candidates.filter((candidate): candidate is string => {
    const url = candidate?.trim() || ''
    if (!url || seen.has(url)) return false
    seen.add(url)
    return true
  })
}

export function attachmentThumbnailAttemptSourceIndex(attemptIndex: number, sourceCount: number) {
  if (sourceCount <= 0 || attemptIndex < 0) return -1
  if (attemptIndex <= 1) return 0
  const sourceIndex = attemptIndex - 1
  return sourceIndex < sourceCount ? sourceIndex : -1
}

export function attachmentThumbnailAttemptCount(sourceCount: number) {
  return sourceCount > 0 ? sourceCount + 1 : 0
}

export function cacheBustedAttachmentThumbnailUrl(url: string, token: string) {
  const hashIndex = url.indexOf('#')
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : ''
  const separator = base.includes('?') ? '&' : '?'
  return `${base}${separator}cpThumbnailRetry=${encodeURIComponent(token)}${hash}`
}

export function calendarAttachmentThumbnailAccess(attachment: AttachmentThumbnailSource) {
  const sourceUrls = [attachment.linePreviewUrl, attachment.lineOriginalUrl, attachment.url]
    .filter((value): value is string => Boolean(value))
  const urls = sourceUrls.map((value) => {
      try { return new URL(value, 'https://sch.city-painter.com') } catch { return null }
    })
  const salesUrls = urls.filter((url) => url?.pathname === '/api/upload-drive' && url.searchParams.get('scope') === 'sales-attachment')
  if (salesUrls.length) return { fileId: '', requiresAuthorization: false, sources: sourceUrls.filter((_value, index) => salesUrls.includes(urls[index])) }
  const driveUrls = urls.filter((url) => url && (url.hostname === 'drive.google.com' || url.pathname === '/api/upload-drive'))
  const requiresAuthorization = attachment.provider === 'google-drive' || driveUrls.length > 0
  const path = attachment.provider === 'google-drive' ? attachment.path || '' : ''
  const candidates = [path, ...driveUrls.map((url) => url!.searchParams.get('fileId') || url!.pathname.match(/\/file\/d\/([^/]+)/)?.[1] || url!.searchParams.get('id') || '')]
  const fileId = candidates.find((value) => /^[A-Za-z0-9_-]{10,200}$/.test(value)) || ''
  return { fileId, requiresAuthorization, sources: requiresAuthorization ? [] : attachmentThumbnailSources(attachment) }
}
