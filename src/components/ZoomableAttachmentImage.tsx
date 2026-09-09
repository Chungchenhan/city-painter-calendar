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
  return (
    <AttachmentImageViewer
      src={fileId ? links?.lineOriginalUrl || '' : src}
      previewSrc={fileId ? links?.linePreviewUrl || '' : previewSrc}
      preloadSources={fileId ? [] : preloadSources}
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
