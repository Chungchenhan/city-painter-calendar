import { useEffect, useRef, useState } from 'react'
import type { CalendarEvent } from '../types'
import type { DeliverySelectionStatus, DeliverySelectionResult } from '../lib/combinedDeliveryStatusCache'
import { combinedDeliveryOrders, combinedDeliveryUnavailable, type CombinedDeliveryOrder } from '../lib/combinedDelivery'

type Props = {
  events: CalendarEvent[]
  initialFiles: File[]
  initialStatuses: Record<string, DeliverySelectionStatus>
  loadStatuses: (events: CalendarEvent[]) => Promise<DeliverySelectionResult>
  preview: (orders: CombinedDeliveryOrder[]) => Promise<string[]>
  submit: (events: CalendarEvent[], files: File[], orders: CombinedDeliveryOrder[]) => Promise<void>
  close: () => void
}

export default function CombinedDeliveryDialog({ events, initialFiles, initialStatuses, loadStatuses, preview, submit, close }: Props) {
  const [selected, setSelected] = useState([events[0].id])
  const [files, setFiles] = useState(initialFiles)
  const [statuses, setStatuses] = useState<Record<string, DeliverySelectionStatus>>(initialStatuses)
  const [failures, setFailures] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [review, setReview] = useState<{ orders: CombinedDeliveryOrder[], notices: string[] } | null>(null)
  const [previews, setPreviews] = useState<string[]>([])
  const dialogRef = useRef<HTMLDivElement>(null)
  const loaders = useRef({ loadStatuses })
  loaders.current = { loadStatuses }
  const [reload, setReload] = useState(0)
  const selectedEvents = events.filter((event) => selected.includes(event.id))

  useEffect(() => {
    let active = true
    setFailures({})
    setStatuses(initialStatuses)
    void loaders.current.loadStatuses(events).then((result) => {
      if (!active) return
      setStatuses(result.statuses)
      setFailures(result.errors)
    }).catch((failure) => {
      if (active) setFailures(Object.fromEntries(events.map((event) => [event.id, failure instanceof Error ? failure.message : '訂單確認失敗'])))
    })
    return () => { active = false }
  }, [events, reload])

  useEffect(() => {
    const urls = files.map((file) => URL.createObjectURL(file))
    setPreviews(urls)
    return () => urls.forEach((url) => URL.revokeObjectURL(url))
  }, [files])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    return () => previous?.focus()
  }, [])

  async function checkSelection() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      if (!files.length || files.length > 20) throw new Error('請選擇 1～20 張配達照片')
      if (files.some((file) => !file.type.startsWith('image/') || file.type === 'image/svg+xml' || file.size === 0)) throw new Error('請使用有效的照片檔案')
      const orders = combinedDeliveryOrders(selectedEvents, statuses)
      setReview({ orders, notices: await preview(orders) })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '配達資料確認失敗')
    } finally {
      setBusy(false)
    }
  }

  async function confirm() {
    if (busy || !review) return
    setBusy(true)
    setError('')
    try {
      const notices = await preview(review.orders)
      if (JSON.stringify(notices) !== JSON.stringify(review.notices)) {
        setReview({ ...review, notices })
        setError('通知對象已變更，請核對後再次確認。')
        setBusy(false)
        return
      }
      await submit(selectedEvents, files, review.orders)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '無法建立配達回報')
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay combined-delivery-overlay" onMouseDown={(event) => event.stopPropagation()} onTouchStart={(event) => event.stopPropagation()}>
      <div className="combined-delivery-dialog" role="dialog" aria-modal="true" aria-labelledby="combined-delivery-title" tabIndex={-1} ref={dialogRef}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.stopPropagation(); if (!busy) close() }
          if (event.key === 'Tab') {
            const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') || [])
            const first = controls[0], last = controls.at(-1)
            if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus() }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
          }
        }}>
        <header><h2 id="combined-delivery-title">{review ? '確認配達回報' : '一起送達的訂單'}</h2><button type="button" aria-label="關閉配達回報" onClick={close} disabled={busy}>×</button></header>
        <div className="combined-delivery-content">
          <p>{review ? `本次回報 ${selected.length} 筆訂單，共用以下 ${files.length} 張配達照片。` : '勾選本次實際送達的訂單，照片只需上傳一次。'}</p>
          <div className="combined-delivery-orders">
            {(review ? selectedEvents : events).map((event) => {
              const unavailable = failures[event.id] || combinedDeliveryUnavailable(event, statuses[event.id])
              return <label className={`combined-delivery-order${unavailable ? ' unavailable' : ''}`} key={event.id}>
                {!review && <input type="checkbox" checked={selected.includes(event.id)} disabled={busy || Boolean(unavailable) || event.id === events[0].id} onChange={(change) => {
                  setError('')
                  setSelected((current) => change.target.checked ? [...current, event.id] : current.filter((id) => id !== event.id))
                }} />}
                <span><strong>{event.sourceSalesNo || event.title}</strong><small>{event.sourceCustomerName} · {event.location}</small><small>{unavailable || statuses[event.id]?.orderStatus}{event.id === events[0].id ? ' · 本筆訂單' : ''}</small></span>
              </label>
            })}
          </div>
          {!review && <label className="combined-delivery-file">選擇配達照片（最多 20 張）<input type="file" accept="image/*" multiple disabled={busy} onChange={(event) => { setFiles(Array.from(event.target.files || [])); setError('') }} /></label>}
          <div className="combined-delivery-photos">{previews.map((url, index) => <figure key={url}><img src={url} alt={`配達照片 ${index + 1}`} /><figcaption>{files[index]?.name}</figcaption></figure>)}</div>
          {review && <div className="combined-delivery-notifications"><strong>本次通知</strong>{review.notices.map((notice, index) => <p key={index}>{notice}</p>)}<p>每筆訂單分別保留配達紀錄；代收款仍逐單處理。</p></div>}
          {Object.keys(failures).length > 0 && <button type="button" onClick={() => setReload((value) => value + 1)} disabled={busy}>重試確認訂單</button>}
          {error && <p className="combined-delivery-error" role="alert">{error}</p>}
        </div>
        <footer>
          <button type="button" disabled={busy} onClick={() => review ? setReview(null) : close()}>{review ? '返回修改' : '取消'}</button>
          <button className="combined-delivery-primary" type="button" disabled={busy || !selected.length || !files.length || selectedEvents.some((event) => !statuses[event.id] || Boolean(failures[event.id]))} onClick={() => void (review ? confirm() : checkSelection())}>{busy ? '處理中…' : review ? '確認配達並通知' : `下一步（${selected.length} 筆訂單）`}</button>
        </footer>
      </div>
    </div>
  )
}
