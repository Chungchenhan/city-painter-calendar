import AttachmentImageViewer from './shared/AttachmentImageViewer'

export default function ZoomableAttachmentImage({
  src,
  previewSrc,
  preloadSources,
  alt,
  onClose,
  onPrevious,
  onNext,
  canPrevious = false,
  canNext = false,
}: {
  src: string
  previewSrc?: string
  preloadSources?: string[]
  alt: string
  onClose: () => void
  onPrevious?: () => void
  onNext?: () => void
  canPrevious?: boolean
  canNext?: boolean
}) {
  return (
    <AttachmentImageViewer
      src={src}
      previewSrc={previewSrc}
      preloadSources={preloadSources}
      alt={alt}
      onClose={onClose}
      onPrevious={onPrevious}
      onNext={onNext}
      canPrevious={canPrevious}
      canNext={canNext}
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
