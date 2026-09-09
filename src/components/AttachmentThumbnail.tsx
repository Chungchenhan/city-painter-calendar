import { useCalendarAttachmentAccess } from '../lib/calendarAttachmentAccess'
import { useEffect, useMemo, useState } from 'react'
import {
  attachmentThumbnailAttemptCount,
  attachmentThumbnailAttemptSourceIndex,
  attachmentThumbnailSources,
  cacheBustedAttachmentThumbnailUrl,
  type AttachmentThumbnailSource,
} from '../lib/attachmentThumbnail'

type AttachmentThumbnailProps = {
  eventId?: string
  attachment: AttachmentThumbnailSource
  className: string
  loading?: 'eager' | 'lazy'
  fetchPriority?: 'high' | 'low' | 'auto'
  onOpen: () => void
  onReload?: () => void
}

export default function AttachmentThumbnail({
  attachment,
  eventId,
  className,
  loading = 'lazy',
  fetchPriority = 'auto',
  onOpen,
  onReload,
}: AttachmentThumbnailProps) {
  const { links, error, retry } = useCalendarAttachmentAccess(eventId, eventId ? attachment.path || '' : '')
  const sources = useMemo(() => eventId ? (links ? [links.linePreviewUrl, links.lineOriginalUrl] : []) : attachmentThumbnailSources(attachment), [
    eventId,
    links,
    attachment.lineOriginalUrl,
    attachment.linePreviewUrl,
    attachment.name,
    attachment.path,
    attachment.provider,
    attachment.type,
    attachment.url,
  ])
  const sourceKey = sources.join('\n')
  const attemptCount = attachmentThumbnailAttemptCount(sources.length)
  const [attemptIndex, setAttemptIndex] = useState(0)
  const [reloadVersion, setReloadVersion] = useState(0)

  useEffect(() => {
    setAttemptIndex(0)
    setReloadVersion(0)
  }, [sourceKey])

  const sourceIndex = attachmentThumbnailAttemptSourceIndex(attemptIndex, sources.length)
  const failed = sourceIndex < 0 || attemptIndex >= attemptCount
  const source = failed ? '' : sources[sourceIndex]
  const requestUrl = source && (attemptIndex > 0 || reloadVersion > 0)
    ? cacheBustedAttachmentThumbnailUrl(source, `${reloadVersion}-${attemptIndex}`)
    : source
  const attachmentName = attachment.name || '圖片'

  function handleClick() {
    if (!failed) {
      onOpen()
      return
    }
    if (eventId) retry()
    onReload?.()
    setReloadVersion((value) => value + 1)
    setAttemptIndex(0)
  }

  return (
    <button
      type="button"
      className={`${className} attachment-thumbnail-button${failed ? ' failed' : ''}`}
      onClick={handleClick}
      aria-label={failed ? `重新載入圖片：${attachmentName}` : `全螢幕開啟圖片：${attachmentName}`}
      title={failed ? `${attachmentName}（點擊重新載入）` : attachmentName}
    >
      {!failed && (
        <img
          key={requestUrl}
          className="attachment-thumbnail-image"
          src={requestUrl}
          alt={attachmentName}
          loading={loading}
          fetchPriority={fetchPriority}
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setAttemptIndex((current) => current === attemptIndex ? current + 1 : current)}
        />
      )}
      {failed && (
        <span className="attachment-thumbnail-reload-state" role="status">
          <b>{eventId && !links && !error ? '圖片授權中' : '圖片載入失敗'}</b>
          <span>重新載入</span>
        </span>
      )}
    </button>
  )
}
