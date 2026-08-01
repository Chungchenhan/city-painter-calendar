export type AttachmentUploadSortFields = {
  uploadedAt?: string
  createdAt?: string | number
  createdAtText?: string
}

function attachmentUploadTime(attachment: AttachmentUploadSortFields) {
  const candidates = [attachment.uploadedAt, attachment.createdAt, attachment.createdAtText]
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
    const value = typeof candidate === 'string' ? candidate.trim() : ''
    if (!value) continue
    const normalized = value.includes('/')
      ? value.replaceAll('/', '-').replace(' ', 'T')
      : value
    const timestamp = Date.parse(normalized)
    if (Number.isFinite(timestamp)) return timestamp
  }
  return null
}

export function sortAttachmentsNewestFirst<T extends AttachmentUploadSortFields>(attachments: readonly T[]) {
  return attachments
    .map((attachment, index) => ({ attachment, index, timestamp: attachmentUploadTime(attachment) }))
    .sort((left, right) => {
      if (left.timestamp !== null && right.timestamp !== null && left.timestamp !== right.timestamp) {
        return right.timestamp - left.timestamp
      }
      if (left.timestamp !== null && right.timestamp === null) return -1
      if (left.timestamp === null && right.timestamp !== null) return 1
      return right.index - left.index
    })
    .map(({ attachment }) => attachment)
}
