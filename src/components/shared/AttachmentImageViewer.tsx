import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'

type Point = {
  x: number
  y: number
}

type ImageTransform = Point & {
  scale: number
}

type Gesture =
  | {
      type: 'pan'
      pointer: Point
      transform: ImageTransform
    }
  | {
      type: 'pinch'
      center: Point
      distance: number
      transform: ImageTransform
    }

export type AttachmentImageViewerProps = {
  src: string
  previewSrc?: string
  preloadSources?: string[]
  alt: string
  onClose: () => void
  onPrevious?: () => void
  onNext?: () => void
  canPrevious?: boolean
  canNext?: boolean
  viewportClassName?: string
  hintClassName?: string
  zoomedClassName?: string
  dismissingClassName?: string
  changingClassName?: string
  readyHint?: string
  loadingHint?: string
  failedHint?: string
  loadingLabel?: string
  imageInset?: number
  respectBottomSafeArea?: boolean
  showNavigationButtons?: boolean
  enableKeyboardNavigation?: boolean
}

const DEFAULT_TRANSFORM: ImageTransform = { scale: 1, x: 0, y: 0 }
const MAX_SCALE = 5
const SWIPE_CLOSE_DISTANCE = 96
const SWIPE_CHANGE_DISTANCE = 72
const preloadedImageSources = new Set<string>()
const preloadingImages = new Map<string, HTMLImageElement>()

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
  cancelIdleCallback?: (handle: number) => void
}

function preloadImage(source: string) {
  if (!source || preloadedImageSources.has(source) || preloadingImages.has(source)) return
  const image = new Image()
  preloadingImages.set(source, image)
  image.decoding = 'async'
  image.fetchPriority = 'low'
  image.onload = () => {
    preloadingImages.delete(source)
    preloadedImageSources.add(source)
  }
  image.onerror = () => {
    preloadingImages.delete(source)
  }
  image.src = source
}

function distanceBetween(first: Point, second: Point) {
  return Math.hypot(second.x - first.x, second.y - first.y)
}

function centerBetween(first: Point, second: Point): Point {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  }
}

export default function AttachmentImageViewer({
  src,
  previewSrc,
  preloadSources = [],
  alt,
  onClose,
  onPrevious,
  onNext,
  canPrevious = false,
  canNext = false,
  viewportClassName = '',
  hintClassName = '',
  zoomedClassName = 'is-zoomed',
  dismissingClassName = 'is-dismissing',
  changingClassName = 'is-changing',
  readyHint = '滑鼠滾輪／雙指縮放・放大後拖曳・下滑關閉',
  loadingHint = '照片已顯示・清晰版本載入中',
  failedHint = '預覽已顯示・清晰版本載入失敗',
  loadingLabel = '照片載入中',
  imageInset = 0,
  respectBottomSafeArea = false,
  showNavigationButtons = true,
  enableKeyboardNavigation = true,
}: AttachmentImageViewerProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const pointersRef = useRef(new Map<number, Point>())
  const gestureRef = useRef<Gesture | null>(null)
  const dismissGestureRef = useRef<{
    pointerId: number
    start: Point
    axis: 'pending' | 'vertical' | 'horizontal' | 'blocked'
  } | null>(null)
  const dismissOffsetRef = useRef(0)
  const transformRef = useRef<ImageTransform>(DEFAULT_TRANSFORM)
  const [transform, setTransform] = useState<ImageTransform>(DEFAULT_TRANSFORM)
  const [dismissOffset, setDismissOffset] = useState(0)
  const [changeOffset, setChangeOffset] = useState(0)
  const [displaySrc, setDisplaySrc] = useState(previewSrc || src)
  const [fullImageReady, setFullImageReady] = useState(false)
  const [fullImageFailed, setFullImageFailed] = useState(false)
  const preloadSourceKey = preloadSources
    .filter((source) => source && source !== src)
    .slice(0, 2)
    .join('\n')

  function applyTransform(nextTransform: ImageTransform) {
    const viewport = viewportRef.current
    const image = imageRef.current
    const scale = Math.min(MAX_SCALE, Math.max(1, nextTransform.scale))
    if (!viewport || !image || scale === 1) {
      transformRef.current = DEFAULT_TRANSFORM
      setTransform(DEFAULT_TRANSFORM)
      return
    }

    const maxX = Math.max(0, (image.clientWidth * scale - viewport.clientWidth) / 2)
    const maxY = Math.max(0, (image.clientHeight * scale - viewport.clientHeight) / 2)
    const constrained = {
      scale,
      x: Math.min(maxX, Math.max(-maxX, nextTransform.x)),
      y: Math.min(maxY, Math.max(-maxY, nextTransform.y)),
    }
    transformRef.current = constrained
    setTransform(constrained)
  }

  useEffect(() => {
    let active = true
    const initialSrc = previewSrc || src
    setDisplaySrc(initialSrc)
    setFullImageReady(false)
    setFullImageFailed(false)
    setDismissOffset(0)
    setChangeOffset(0)
    applyTransform(DEFAULT_TRANSFORM)
    if (!src) {
      setFullImageFailed(true)
      return () => { active = false }
    }
    if (initialSrc === src) return () => { active = false }

    const fullImage = new Image()
    fullImage.decoding = 'async'
    fullImage.onload = () => {
      const showFullImage = () => {
        if (!active) return
        setDisplaySrc(src)
        setFullImageReady(true)
      }
      void fullImage.decode().then(showFullImage, showFullImage)
    }
    fullImage.onerror = () => {
      if (active) setFullImageFailed(true)
    }
    fullImage.src = src
    return () => {
      active = false
      fullImage.onload = null
      fullImage.onerror = null
    }
  }, [previewSrc, src])

  useEffect(() => {
    if ((!fullImageReady && !fullImageFailed) || !preloadSourceKey) return
    const sources = preloadSourceKey.split('\n').filter(Boolean)
    const idleWindow = window as IdleWindow
    const startPreloading = () => {
      sources.forEach(preloadImage)
    }
    if (idleWindow.requestIdleCallback) {
      const idleHandle = idleWindow.requestIdleCallback(startPreloading, { timeout: 1_500 })
      return () => idleWindow.cancelIdleCallback?.(idleHandle)
    }
    const timeoutHandle = window.setTimeout(startPreloading, 300)
    return () => window.clearTimeout(timeoutHandle)
  }, [fullImageFailed, fullImageReady, preloadSourceKey])

  useEffect(() => {
    if (!enableKeyboardNavigation) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'ArrowLeft' && canPrevious) {
        event.preventDefault()
        onPrevious?.()
      } else if (event.key === 'ArrowRight' && canNext) {
        event.preventDefault()
        onNext?.()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [canNext, canPrevious, enableKeyboardNavigation, onNext, onPrevious])

  useEffect(() => {
    function handleResize() {
      applyTransform(transformRef.current)
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    function handleWheel(event: WheelEvent) {
      event.preventDefault()
      if (event.deltaY === 0 || !(event.target instanceof Node) || !viewport?.contains(event.target)) return
      const viewportRect = viewport?.getBoundingClientRect()
      if (!viewportRect) return
      const currentTransform = transformRef.current
      const nextScale = Math.min(MAX_SCALE, Math.max(1, currentTransform.scale * Math.exp(-event.deltaY * 0.002)))
      const scaleRatio = nextScale / currentTransform.scale
      applyTransform({
        scale: nextScale,
        x: currentTransform.x + (event.clientX - viewportRect.left - viewportRect.width / 2) * (1 - scaleRatio),
        y: currentTransform.y + (event.clientY - viewportRect.top - viewportRect.height / 2) * (1 - scaleRatio),
      })
    }

    window.addEventListener('wheel', handleWheel, { capture: true, passive: false })
    return () => window.removeEventListener('wheel', handleWheel, true)
  }, [])

  function updateDismissOffset(offset: number) {
    dismissOffsetRef.current = offset
    setDismissOffset(offset)
  }

  function beginGesture() {
    const points = Array.from(pointersRef.current.values())
    if (points.length >= 2) {
      gestureRef.current = {
        type: 'pinch',
        center: centerBetween(points[0], points[1]),
        distance: Math.max(1, distanceBetween(points[0], points[1])),
        transform: transformRef.current,
      }
      return
    }
    if (points.length === 1) {
      gestureRef.current = {
        type: 'pan',
        pointer: points[0],
        transform: transformRef.current,
      }
      return
    }
    gestureRef.current = null
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (event.pointerType !== 'mouse' && pointersRef.current.size === 0 && transformRef.current.scale === 1) {
      dismissGestureRef.current = {
        pointerId: event.pointerId,
        start: { x: event.clientX, y: event.clientY },
        axis: 'pending',
      }
    } else {
      dismissGestureRef.current = null
      updateDismissOffset(0)
      setChangeOffset(0)
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    beginGesture()
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!pointersRef.current.has(event.pointerId)) return
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const points = Array.from(pointersRef.current.values())
    const gesture = gestureRef.current

    if (points.length >= 2 && gesture?.type === 'pinch') {
      dismissGestureRef.current = null
      updateDismissOffset(0)
      setChangeOffset(0)
      event.preventDefault()
      const center = centerBetween(points[0], points[1])
      const scale = gesture.transform.scale * distanceBetween(points[0], points[1]) / gesture.distance
      const viewportRect = viewportRef.current?.getBoundingClientRect()
      const viewportCenter = viewportRect
        ? { x: viewportRect.left + viewportRect.width / 2, y: viewportRect.top + viewportRect.height / 2 }
        : gesture.center
      const scaleRatio = scale / gesture.transform.scale
      applyTransform({
        scale,
        x: gesture.transform.x
          + center.x - gesture.center.x
          + (gesture.center.x - viewportCenter.x) * (1 - scaleRatio),
        y: gesture.transform.y
          + center.y - gesture.center.y
          + (gesture.center.y - viewportCenter.y) * (1 - scaleRatio),
      })
      return
    }

    const dismissGesture = dismissGestureRef.current
    if (points.length === 1 && gesture?.type === 'pan' && gesture.transform.scale === 1 && dismissGesture?.pointerId === event.pointerId) {
      const deltaX = event.clientX - dismissGesture.start.x
      const deltaY = event.clientY - dismissGesture.start.y
      if (dismissGesture.axis === 'pending' && Math.hypot(deltaX, deltaY) >= 8) {
        if (Math.abs(deltaX) > Math.abs(deltaY) * 1.15) {
          dismissGesture.axis = 'horizontal'
        } else if (deltaY > 0 && Math.abs(deltaY) > Math.abs(deltaX) * 1.15) {
          dismissGesture.axis = 'vertical'
        } else {
          dismissGesture.axis = 'blocked'
        }
      }
      if (dismissGesture.axis === 'vertical') {
        event.preventDefault()
        setChangeOffset(0)
        updateDismissOffset(Math.min(Math.max(0, deltaY * 0.82), 240))
        return
      }
      if (dismissGesture.axis === 'horizontal') {
        event.preventDefault()
        updateDismissOffset(0)
        const canChange = deltaX > 0 ? canPrevious : canNext
        const resistance = canChange ? 0.82 : 0.2
        setChangeOffset(Math.min(240, Math.max(-240, deltaX * resistance)))
        return
      }
    }

    if (points.length === 1 && gesture?.type === 'pan' && gesture.transform.scale > 1) {
      event.preventDefault()
      applyTransform({
        scale: gesture.transform.scale,
        x: gesture.transform.x + points[0].x - gesture.pointer.x,
        y: gesture.transform.y + points[0].y - gesture.pointer.y,
      })
    }
  }

  function finishPointer(event: ReactPointerEvent<HTMLDivElement>, cancelled = false) {
    const dismissGesture = dismissGestureRef.current
    const horizontalDelta = dismissGesture ? event.clientX - dismissGesture.start.x : 0
    const shouldClose = !cancelled
      && dismissGesture?.pointerId === event.pointerId
      && dismissGesture.axis === 'vertical'
      && (dismissOffsetRef.current >= SWIPE_CLOSE_DISTANCE || event.clientY - dismissGesture.start.y >= SWIPE_CLOSE_DISTANCE)
    const shouldShowPrevious = !cancelled
      && dismissGesture?.pointerId === event.pointerId
      && dismissGesture.axis === 'horizontal'
      && horizontalDelta >= SWIPE_CHANGE_DISTANCE
      && canPrevious
    const shouldShowNext = !cancelled
      && dismissGesture?.pointerId === event.pointerId
      && dismissGesture.axis === 'horizontal'
      && horizontalDelta <= -SWIPE_CHANGE_DISTANCE
      && canNext
    dismissGestureRef.current = null
    updateDismissOffset(0)
    setChangeOffset(0)
    pointersRef.current.delete(event.pointerId)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    beginGesture()
    if (shouldClose) onClose()
    else if (shouldShowPrevious) onPrevious?.()
    else if (shouldShowNext) onNext?.()
  }

  function toggleZoom(event: ReactPointerEvent<HTMLDivElement>) {
    if (transformRef.current.scale > 1) {
      applyTransform(DEFAULT_TRANSFORM)
      return
    }
    const viewportRect = viewportRef.current?.getBoundingClientRect()
    if (!viewportRect) return
    applyTransform({
      scale: 2,
      x: viewportRect.left + viewportRect.width / 2 - event.clientX,
      y: viewportRect.top + viewportRect.height / 2 - event.clientY,
    })
  }

  if (!displaySrc) return null

  const fullImageLoading = !fullImageReady && !fullImageFailed
  const imageHeightOffset = imageInset * 2
  const imageHeight = respectBottomSafeArea
    ? `calc(100% - ${imageHeightOffset}px - env(safe-area-inset-bottom))`
    : imageHeightOffset > 0
      ? `calc(100% - ${imageHeightOffset}px)`
      : '100%'
  const stateClasses = [
    transform.scale > 1 ? zoomedClassName : '',
    dismissOffset > 0 ? dismissingClassName : '',
    changeOffset !== 0 ? changingClassName : '',
  ].filter(Boolean).join(' ')

  return (
    <>
      {fullImageLoading && (
        <div
          className="standard-attachment-loading-toast"
          role="status"
          aria-live="polite"
          aria-label={loadingLabel}
          style={{
            position: 'fixed',
            top: 'max(74px, calc(env(safe-area-inset-top) + 12px))',
            left: '50%',
            zIndex: 200000,
            minHeight: 44,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '9px 15px 9px 12px',
            border: '1px solid #e5e5e5',
            borderRadius: 8,
            background: '#fff',
            color: '#333',
            boxShadow: '0 5px 18px rgba(0,0,0,0.16)',
            fontSize: 15,
            whiteSpace: 'nowrap',
            transform: 'translateX(-50%)',
            pointerEvents: 'none',
          }}
        >
          <style>{'@keyframes standard-attachment-loading-spin { to { transform: rotate(360deg); } }'}</style>
          <span
            aria-hidden="true"
            style={{
              width: 20,
              height: 20,
              flex: '0 0 auto',
              boxSizing: 'border-box',
              border: '2px solid #d9d9d9',
              borderTopColor: '#52c95c',
              borderRadius: '50%',
              animation: 'standard-attachment-loading-spin 0.75s linear infinite',
            }}
          />
          <span>{loadingLabel}</span>
        </div>
      )}
      <div
        ref={viewportRef}
        className={`${viewportClassName} ${stateClasses}`.trim()}
        aria-busy={fullImageLoading}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={(event) => finishPointer(event, true)}
        onDoubleClick={toggleZoom}
      >
        <img
          ref={imageRef}
          src={displaySrc}
          alt={alt}
          draggable={false}
          referrerPolicy="no-referrer"
          onLoad={() => {
            if (displaySrc === src) setFullImageReady(true)
          }}
          onError={() => {
            if (displaySrc === src) setFullImageFailed(true)
          }}
          style={{
            position: 'absolute',
            top: imageInset,
            left: imageInset,
            display: 'block',
            width: imageInset > 0 ? `calc(100% - ${imageInset * 2}px)` : '100%',
            height: imageHeight,
            maxWidth: 'none',
            maxHeight: 'none',
            objectFit: 'contain',
            opacity: Math.max(0.48, 1 - dismissOffset / 360),
            transform: `translate3d(${transform.x + changeOffset}px, ${transform.y + dismissOffset}px, 0) scale(${transform.scale})`,
            transformOrigin: 'center',
            transition: transform.scale > 1 || dismissOffset > 0 || changeOffset !== 0
              ? 'none'
              : 'transform 180ms ease-out, opacity 180ms ease-out',
            willChange: 'transform',
          }}
        />
        {showNavigationButtons && (canPrevious || canNext) && (
          <>
            <button
              type="button"
              className="standard-attachment-viewer-nav is-previous"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onPrevious}
              disabled={!canPrevious}
              aria-label="上一張照片"
              style={{
                position: 'absolute',
                top: '50%',
                left: 8,
                zIndex: 2,
                width: 48,
                minWidth: 48,
                height: 56,
                minHeight: 56,
                border: 0,
                borderRadius: 8,
                background: 'rgba(0,0,0,0.42)',
                color: '#fff',
                fontSize: 42,
                lineHeight: 1,
                opacity: canPrevious ? 1 : 0.28,
                transform: 'translateY(-50%)',
                cursor: canPrevious ? 'pointer' : 'default',
              }}
            >
              ‹
            </button>
            <button
              type="button"
              className="standard-attachment-viewer-nav is-next"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onNext}
              disabled={!canNext}
              aria-label="下一張照片"
              style={{
                position: 'absolute',
                top: '50%',
                right: 8,
                zIndex: 2,
                width: 48,
                minWidth: 48,
                height: 56,
                minHeight: 56,
                border: 0,
                borderRadius: 8,
                background: 'rgba(0,0,0,0.42)',
                color: '#fff',
                fontSize: 42,
                lineHeight: 1,
                opacity: canNext ? 1 : 0.28,
                transform: 'translateY(-50%)',
                cursor: canNext ? 'pointer' : 'default',
              }}
            >
              ›
            </button>
          </>
        )}
        {hintClassName && (
          <span className={hintClassName} aria-hidden="true">
            {fullImageReady ? readyHint : fullImageFailed ? failedHint : loadingHint}
          </span>
        )}
      </div>
    </>
  )
}
