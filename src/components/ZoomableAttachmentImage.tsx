import { calendarDriveFileId, useCalendarAttachmentAccess } from '../lib/calendarAttachmentAccess'
import AttachmentImageViewer, { type AttachmentImageViewerHeader } from './shared/AttachmentImageViewer'

export default function ZoomableAttachmentImage({
  eventId,
  src,
  previewSrc,
  preloadSources,
  alt,
  onClose,
  onPrevious,
  onNext,
  canPrevious = false,
  canNext = false,
  header,
}: {
  eventId?: string
  src: string
  previewSrc?: string
  preloadSources?: string[]
  alt: string
  onClose: () => void
  onPrevious?: () => void
  onNext?: () => void
  canPrevious?: boolean
  canNext?: boolean
  header?: AttachmentImageViewerHeader
}) {
  const fileId = eventId ? calendarDriveFileId(src) : ''
  const { links } = useCalendarAttachmentAccess(eventId, fileId)
  const adjacentSources = [...new Set(preloadSources || [])].filter(source => source && source !== src).slice(0, 2)
  const firstAdjacentFileId = eventId ? calendarDriveFileId(adjacentSources[0] || '') : ''
  const secondAdjacentFileId = eventId ? calendarDriveFileId(adjacentSources[1] || '') : ''
  const { links: firstAdjacentLinks } = useCalendarAttachmentAccess(eventId, firstAdjacentFileId)
  const { links: secondAdjacentLinks } = useCalendarAttachmentAccess(eventId, secondAdjacentFileId)
  // 相鄰照片沿用同帳號與事件的短效授權，不預載資料中殘留的舊 Drive 網址。
  const authorizedPreloadSources = [
    firstAdjacentFileId ? firstAdjacentLinks?.lineOriginalUrl : adjacentSources[0],
    secondAdjacentFileId ? secondAdjacentLinks?.lineOriginalUrl : adjacentSources[1],
  ].filter((source): source is string => Boolean(source))
  return (
    <AttachmentImageViewer
      src={fileId ? links?.lineOriginalUrl || '' : src}
      previewSrc={fileId ? links?.linePreviewUrl || '' : previewSrc}
      preloadSources={authorizedPreloadSources}
      alt={alt}
      onClose={onClose}
      onPrevious={onPrevious}
      onNext={onNext}
      canPrevious={canPrevious}
      canNext={canNext}
      header={header}
      viewportClassName="event-attachment-lightbox-body"
      hintClassName="event-attachment-zoom-hint"
      zoomedClassName="zoomed"
      dismissingClassName="is-dismissing"
      changingClassName="is-changing"
      readyHint="滑鼠滾輪／雙指縮放・左右滑動切換・下滑關閉"
      imageInset={8}
      respectBottomSafeArea
    />
  )
}
