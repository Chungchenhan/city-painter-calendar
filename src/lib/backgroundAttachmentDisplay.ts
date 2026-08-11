export type CompletedBackgroundAttachment = {
  uploadJobId?: string
  path?: string
}

export type PendingBackgroundAttachment = {
  jobId?: string
  attachmentPath?: string
}

export type BackgroundAttachmentDisplayState = {
  status: 'queued' | 'uploading' | 'processing' | 'finalizing' | 'failed'
  progress: number
  cloudSafe: boolean
  error?: string
}

export function backgroundAttachmentDisplayLabel(upload: BackgroundAttachmentDisplayState) {
  if (upload.status === 'failed') {
    return upload.cloudSafe
      ? `處理失敗：${upload.error || '稍後會自動重試'}`
      : `上傳失敗：${upload.error || '重新開啟後會自動重試'}`
  }
  if (upload.status === 'queued') return '等待上傳'
  if (upload.status === 'uploading') return `上傳中 ${Math.round(upload.progress * 100)}%`
  return '已完成'
}

export function hideCompletedBackgroundUploadPreviews<T extends PendingBackgroundAttachment>(
  uploads: readonly T[],
  attachments: readonly CompletedBackgroundAttachment[],
) {
  return uploads.filter((upload) => !attachments.some((attachment) => (
    backgroundUploadMatchesAttachment(upload, attachment)
  )))
}

export function backgroundUploadMatchesAttachment(
  upload: PendingBackgroundAttachment,
  attachment: CompletedBackgroundAttachment,
) {
  const jobId = upload.jobId?.trim()
  const uploadJobId = attachment.uploadJobId?.trim()
  if (jobId && uploadJobId && jobId === uploadJobId) return true
  const attachmentPath = upload.attachmentPath?.trim()
  const remotePath = attachment.path?.trim()
  return Boolean(attachmentPath && remotePath && attachmentPath === remotePath)
}

export function hideRemoteAttachmentsUsingLocalPreviews<T extends CompletedBackgroundAttachment>(
  attachments: readonly T[],
  uploads: readonly PendingBackgroundAttachment[],
) {
  return attachments.filter((attachment) => !uploads.some((upload) => (
    backgroundUploadMatchesAttachment(upload, attachment)
  )))
}
