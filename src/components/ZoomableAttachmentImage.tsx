import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

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

const DEFAULT_TRANSFORM: ImageTransform = { scale: 1, x: 0, y: 0 }
const MAX_SCALE = 5

function distanceBetween(first: Point, second: Point) {
  return Math.hypot(second.x - first.x, second.y - first.y)
}

function centerBetween(first: Point, second: Point): Point {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  }
}

export default function ZoomableAttachmentImage({ src, alt }: { src: string; alt: string }) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const pointersRef = useRef(new Map<number, Point>())
  const gestureRef = useRef<Gesture | null>(null)
  const transformRef = useRef<ImageTransform>(DEFAULT_TRANSFORM)
  const [transform, setTransform] = useState<ImageTransform>(DEFAULT_TRANSFORM)

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

    if (points.length === 1 && gesture?.type === 'pan' && gesture.transform.scale > 1) {
      event.preventDefault()
      applyTransform({
        scale: gesture.transform.scale,
        x: gesture.transform.x + points[0].x - gesture.pointer.x,
        y: gesture.transform.y + points[0].y - gesture.pointer.y,
      })
    }
  }

  function finishPointer(event: ReactPointerEvent<HTMLDivElement>) {
    pointersRef.current.delete(event.pointerId)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    beginGesture()
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

  return (
    <div
      ref={viewportRef}
      className={`event-attachment-lightbox-body${transform.scale > 1 ? ' zoomed' : ''}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointer}
      onPointerCancel={finishPointer}
      onDoubleClick={toggleZoom}
    >
      <img
        ref={imageRef}
        src={src}
        alt={alt}
        draggable={false}
        referrerPolicy="no-referrer"
        style={{ transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})` }}
      />
      <span className="event-attachment-zoom-hint" aria-hidden="true">雙指縮放・放大後拖曳</span>
    </div>
  )
}
