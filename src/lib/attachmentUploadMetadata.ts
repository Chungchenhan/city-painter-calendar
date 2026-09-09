import dayjs from 'dayjs'

export type AttachmentUploadMetadata = {
  uploadedByName?: string
  uploadedByEmployeeNo?: string
  uploadedAt?: string
  createdAtText?: string
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

export function attachmentUploadLabel(attachment: AttachmentUploadMetadata) {
  const uploadedBy = text(attachment.uploadedByName)
    || text(attachment.uploadedByEmployeeNo)
    || '未提供'
  const uploadedAtSource = text(attachment.uploadedAt) || text(attachment.createdAtText)
  const uploadedAtValue = dayjs(uploadedAtSource)
  const uploadedAt = uploadedAtValue.isValid()
    ? uploadedAtValue.format('YYYY/MM/DD HH:mm:ss')
    : uploadedAtSource || '未提供'
  return `${uploadedBy} ${uploadedAt} 上傳`
}
