import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import { auth, getAppCheckHeaders, getFirebaseIdToken } from '../lib/firebase'

type ScannerPhase = 'idle' | 'processing' | 'success' | 'warning' | 'error'
type ScannerControls = { stop: () => void }
type ScanInputMode = 'camera' | 'photo'
type QrPayloadType = 'raw-id' | 'url'

type ScanContext = {
  clientAttemptId: string
  scanSessionId: string
  inputMode: ScanInputMode
  qrPayloadType: QrPayloadType
}

type OrderSummary = {
  id: string
  salesNo: string
  customer: string
  shippingMethod: string
  orderStatus: string
}

type RelatedFulfillmentOrder = {
  id: string
  salesId: string
  salesNo: string
  customerCode: string
  customer: string
  shippingMethod: string
  orderStatus: string
  deliveryDate: string
  deliveryTime: string
  deliveryStartTime: string
  deliveryEndTime: string
  recipientName: string
  recipientAddress: string
  sameAddress: boolean
}

type OutsourcedFileMoveStatus = {
  jobId: string
  status: string
  terminal: boolean
  outcome: 'processing' | 'success' | 'not_found' | 'error'
  message: string
}

type OutsourcedFileMoveQueue = {
  status: string
  reason: string
  jobId: string
  message: string
}

class ErpLineApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ErpLineApiError'
    this.status = status
  }
}

const ERP_LINE_API_URL = 'https://erp.city-painter.com/api/line'
const ERP_SCAN_PATH = '/sales/order-scan'
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '100.77.87.95', 'macbook-air.tail7313ae.ts.net'])

let qrReaderModulePromise: ReturnType<typeof importQrReader> | null = null

function importQrReader() {
  return import('@zxing/browser')
}

function loadQrReader() {
  qrReaderModulePromise ??= importQrReader()
  return qrReaderModulePromise
}

export function preloadErpOrderScanner() {
  return loadQrReader().then(() => undefined)
}

function supportsLiveCamera(): boolean {
  return window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function'
}

function erpLineApiUrl() {
  const { hostname, port, protocol } = window.location
  if (import.meta.env.DEV && port === '5175' && LOCAL_HOSTS.has(hostname)) {
    return `${protocol}//${hostname}:5173/api/line`
  }
  return ERP_LINE_API_URL
}

function stopVideoTracks(video: HTMLVideoElement | null) {
  const stream = video?.srcObject
  if (stream && 'getTracks' in stream) stream.getTracks().forEach((track) => track.stop())
  if (video) video.srcObject = null
}

function cameraErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return '相機權限遭拒，請允許相機權限後再試，或改用拍照辨識。'
    if (error.name === 'NotFoundError') return '找不到可使用的相機，請改用拍照辨識。'
    if (error.name === 'NotReadableError') return '相機目前被其他 App 使用，請關閉其他相機程式後再試。'
  }
  return error instanceof Error ? `無法啟用相機：${error.message}` : '無法啟用相機，請檢查瀏覽器權限。'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readText(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function apiErrorMessage(payload: Record<string, unknown>): string {
  const direct = readText(payload, ['message'])
  if (direct) return direct
  return isRecord(payload.error) ? readText(payload.error, ['message', 'error']) : readText(payload, ['error'])
}

function outsourcedFileMoveQueue(payload: Record<string, unknown>): OutsourcedFileMoveQueue | null {
  if (!isRecord(payload.outsourcedFileMove)) return null
  return {
    status: readText(payload.outsourcedFileMove, ['status']),
    reason: readText(payload.outsourcedFileMove, ['reason']),
    jobId: readText(payload.outsourcedFileMove, ['jobId']),
    message: readText(payload.outsourcedFileMove, ['message'])
  }
}

function orderStatusMessage(payload: Record<string, unknown>, fallback: string): string {
  const combinedMessage = readText(payload, ['message']) || fallback
  if (!isRecord(payload.outsourcedFileMove)) return combinedMessage
  const moveMessage = readText(payload.outsourcedFileMove, ['message'])
  if (!moveMessage || !combinedMessage.endsWith(moveMessage)) return combinedMessage
  return combinedMessage.slice(0, -moveMessage.length).trim() || fallback
}

function outsourcedFileMoveStatus(payload: Record<string, unknown>, jobId: string): OutsourcedFileMoveStatus {
  const outcome = readText(payload, ['outcome'])
  return {
    jobId: readText(payload, ['jobId']) || jobId,
    status: readText(payload, ['status']) || 'pending',
    terminal: payload.terminal === true,
    outcome: outcome === 'success' || outcome === 'not_found' || outcome === 'error' ? outcome : 'processing',
    message: readText(payload, ['message']) || '油性噴畫檔案仍在背景歸檔。'
  }
}

function responseOrder(payload: Record<string, unknown>, salesId: string): OrderSummary {
  const nested = [payload.order, payload.sale, payload.sales, payload.record].find(isRecord)
  const source = nested ?? payload
  return {
    id: readText(source, ['id', 'salesId']) || salesId,
    salesNo: readText(source, ['salesNo', 'orderNo']) || readText(payload, ['salesNo', 'orderNo']),
    customer: readText(source, ['customer', 'customerName']) || readText(payload, ['customer', 'customerName']),
    shippingMethod: readText(source, ['shippingMethod', 'deliveryMethod', 'pickupMethod']) || readText(payload, ['shippingMethod']),
    orderStatus: readText(source, ['orderStatus', 'currentStatus']) || readText(payload, ['orderStatus', 'currentStatus']) || '未設定'
  }
}

function relatedFulfillmentOrders(payload: Record<string, unknown>, processedSalesIds: Set<string>): RelatedFulfillmentOrder[] {
  if (!Array.isArray(payload.relatedFulfillmentOrders)) return []

  return payload.relatedFulfillmentOrders
    .filter(isRecord)
    .map((record) => ({
      id: readText(record, ['id']),
      salesId: readText(record, ['salesId', 'id']),
      salesNo: readText(record, ['salesNo']),
      customerCode: readText(record, ['customerCode']),
      customer: readText(record, ['customer', 'customerName']),
      shippingMethod: readText(record, ['shippingMethod']),
      orderStatus: readText(record, ['orderStatus']) || '未設定',
      deliveryDate: readText(record, ['deliveryDate']),
      deliveryTime: readText(record, ['deliveryTime']),
      deliveryStartTime: readText(record, ['deliveryStartTime']),
      deliveryEndTime: readText(record, ['deliveryEndTime']),
      recipientName: readText(record, ['recipientName']),
      recipientAddress: readText(record, ['recipientAddress']),
      sameAddress: record.sameAddress === true
    }))
    .filter((order) => {
      if (!order.salesId && !order.id) return false
      return !processedSalesIds.has(order.salesId) && !processedSalesIds.has(order.id)
    })
    .sort((a, b) => Number(b.sameAddress) - Number(a.sameAddress))
}

function fulfillmentSchedule(order: RelatedFulfillmentOrder): string {
  const timeRange = order.deliveryStartTime && order.deliveryEndTime
    ? `${order.deliveryStartTime}–${order.deliveryEndTime}`
    : order.deliveryTime || order.deliveryStartTime || order.deliveryEndTime
  return [order.deliveryDate, timeRange].filter(Boolean).join(' ') || '未設定'
}

function createScanIdentifier(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()

  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function qrPayloadType(rawValue: string): QrPayloadType {
  try {
    new URL(rawValue.trim())
    return 'url'
  } catch {
    return 'raw-id'
  }
}

function parseSalesId(rawValue: string): string {
  const raw = rawValue.trim()
  if (!raw) throw new Error('QR Code 沒有包含銷貨單資料。')

  let salesId = raw
  try {
    const url = new URL(raw)
    const localErpHost = `${window.location.hostname}:5173`
    const allowedHosts = new Set(['erp.city-painter.com', localErpHost, 'localhost:5173', '127.0.0.1:5173'])
    if (!allowedHosts.has(url.host) || url.pathname.replace(/\/+$/, '') !== ERP_SCAN_PATH) {
      throw new Error('這不是都市彩繪 ERP 的銷貨單 QR Code。')
    }
    salesId = url.searchParams.get('salesId')?.trim() ?? ''
  } catch (error) {
    if (error instanceof Error && error.message.includes('都市彩繪 ERP')) throw error
  }

  if (!/^[A-Za-z0-9_-]{1,200}$/.test(salesId)) throw new Error('QR Code 的銷貨單識別碼格式不正確。')
  return salesId
}

async function callErpLineApi(body: Record<string, unknown>, timeoutMs = 30_000, externalSignal?: AbortSignal) {
  const currentUser = auth.currentUser
  if (!currentUser) throw new Error('登入已失效，請重新登入。')

  const [token, appCheckHeaders] = await Promise.all([
    getFirebaseIdToken(currentUser),
    getAppCheckHeaders()
  ])
  const controller = new AbortController()
  const abortFromExternal = () => controller.abort()
  externalSignal?.addEventListener('abort', abortFromExternal, { once: true })
  if (externalSignal?.aborted) controller.abort()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(erpLineApiUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...appCheckHeaders
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    const payload: unknown = await response.json().catch(() => null)
    const record = isRecord(payload) ? payload : {}
    if (!response.ok || record.ok === false) {
      throw new ErpLineApiError(
        apiErrorMessage(record) || (response.status === 403 ? '您沒有執行此操作的權限。' : 'ERP 操作失敗，請稍後再試。'),
        response.status
      )
    }
    return record
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('ERP 操作逾時，請確認網路後再試。')
    throw error
  } finally {
    window.clearTimeout(timeout)
    externalSignal?.removeEventListener('abort', abortFromExternal)
  }
}

async function scanOrder(salesId: string, context: ScanContext, signal: AbortSignal) {
  return callErpLineApi({
    action: 'scan-order-status',
    salesId,
    clientAttemptId: context.clientAttemptId,
    scanSessionId: context.scanSessionId,
    inputMode: context.inputMode,
    qrPayloadType: context.qrPayloadType
  }, 30_000, signal)
}

function waitForNextMoveStatusPoll(delayMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', cancel)
      resolve()
    }, delayMs)
    const cancel = () => {
      window.clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', cancel, { once: true })
  })
}

async function waitForOutsourcedFileMove(
  salesId: string,
  jobId: string,
  signal: AbortSignal
): Promise<OutsourcedFileMoveStatus | null> {
  const deadline = Date.now() + 45_000
  while (!signal.aborted && Date.now() < deadline) {
    try {
      const remainingMs = deadline - Date.now()
      const payload = await callErpLineApi(
        { action: 'outsourced-file-move-status', salesId, jobId },
        Math.max(1, Math.min(15_000, remainingMs)),
        signal
      )
      const status = outsourcedFileMoveStatus(payload, jobId)
      if (status.terminal) return status
    } catch (error) {
      if (signal.aborted) return null
      if (error instanceof ErpLineApiError && [400, 401, 403, 404].includes(error.status)) throw error
      if (Date.now() >= deadline) return null
    }
    await waitForNextMoveStatusPoll(Math.min(2_000, Math.max(0, deadline - Date.now())), signal)
  }
  return null
}

async function decodeQrImage(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file)
  try {
    const { BrowserQRCodeReader } = await loadQrReader()
    const result = await new BrowserQRCodeReader().decodeFromImageUrl(objectUrl)
    return result.getText()
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export default function ErpOrderScanner({ onClose }: { onClose: () => void }) {
  const [scanSessionId] = useState(createScanIdentifier)
  const [phase, setPhase] = useState<ScannerPhase>('idle')
  const [message, setMessage] = useState('請開啟相機，掃描銷貨單右上角的 QR Code。')
  const [order, setOrder] = useState<OrderSummary | null>(null)
  const [cameraActive, setCameraActive] = useState(false)
  const [cameraStarting, setCameraStarting] = useState(false)
  const [reminderOrders, setReminderOrders] = useState<RelatedFulfillmentOrder[]>([])
  const [reminderOpen, setReminderOpen] = useState(false)
  const [reminderTruncated, setReminderTruncated] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const cameraCaptureInputRef = useRef<HTMLInputElement | null>(null)
  const controlsRef = useRef<ScannerControls | null>(null)
  const cameraAttemptRef = useRef(0)
  const imageAttemptRef = useRef(0)
  const moveStatusAttemptRef = useRef(0)
  const activeOperationAbortRef = useRef<AbortController | null>(null)
  const processingRef = useRef(false)
  const processedRef = useRef(new Set<string>())
  const lastLiveScanRef = useRef('')
  const reminderOpenRef = useRef(false)
  const liveCameraSupported = supportsLiveCamera()

  const stopCamera = useCallback(() => {
    cameraAttemptRef.current += 1
    try {
      controlsRef.current?.stop()
    } catch (error) {
      console.error('停止 QR Code 相機失敗', error)
    }
    controlsRef.current = null
    stopVideoTracks(videoRef.current)
    setCameraActive(false)
    setCameraStarting(false)
  }, [])

  const closeScanner = useCallback(() => {
    moveStatusAttemptRef.current += 1
    activeOperationAbortRef.current?.abort()
    activeOperationAbortRef.current = null
    stopCamera()
    onClose()
  }, [onClose, stopCamera])

  const closeReminder = useCallback(() => {
    reminderOpenRef.current = false
    setReminderOpen(false)
  }, [])

  const processSalesId = useCallback(async (rawValue: string, inputMode: ScanInputMode) => {
    if (processingRef.current || reminderOpenRef.current) return
    const continuousCamera = inputMode === 'camera'
    const context: ScanContext = {
      clientAttemptId: createScanIdentifier(),
      scanSessionId,
      inputMode,
      qrPayloadType: qrPayloadType(rawValue)
    }
    let salesId = ''
    let operationAttempt: number | null = null
    let operationController: AbortController | null = null
    try {
      salesId = parseSalesId(rawValue)
      if (processedRef.current.has(salesId)) return
      processingRef.current = true
      processedRef.current.add(salesId)
      operationAttempt = ++moveStatusAttemptRef.current
      activeOperationAbortRef.current?.abort()
      operationController = new AbortController()
      activeOperationAbortRef.current = operationController
      setOrder(null)
      setPhase('processing')
      setMessage('正在更新銷貨單狀態...')

      const payload = await scanOrder(salesId, context, operationController.signal)
      if (operationAttempt !== moveStatusAttemptRef.current || operationController.signal.aborted) return
      const updatedOrder = responseOrder(payload, salesId)
      setOrder(updatedOrder)
      const relatedOrders = relatedFulfillmentOrders(payload, processedRef.current)
      if (relatedOrders.length > 0) {
        reminderOpenRef.current = true
        setReminderOrders(relatedOrders)
        setReminderTruncated(payload.relatedFulfillmentOrdersTruncated === true)
        setReminderOpen(true)
      }
      const moveQueue = outsourcedFileMoveQueue(payload)
      const resultMessage = moveQueue?.jobId
        ? orderStatusMessage(payload, `訂單狀態已更新為「${updatedOrder.orderStatus}」。`)
        : readText(payload, ['message']) || `訂單狀態已更新為「${updatedOrder.orderStatus}」。`
      let finalPhase: ScannerPhase = 'success'
      let finalMessage = resultMessage
      if (moveQueue?.jobId) {
        setMessage(`${resultMessage}\n正在等待油性噴畫檔案歸檔結果…`)
        try {
          const moveStatus = await waitForOutsourcedFileMove(
            salesId,
            moveQueue.jobId,
            operationController.signal
          )
          if (operationAttempt !== moveStatusAttemptRef.current || operationController.signal.aborted) return
          if (moveStatus) {
            finalPhase = moveStatus.outcome === 'success' ? 'success' : 'error'
            finalMessage = `${resultMessage}\n${moveStatus.message}`
          } else {
            finalPhase = 'warning'
            finalMessage = `${resultMessage}\n油性噴畫檔案仍在背景歸檔；若發生異常，LINE 助手會通知承辦人。`
          }
        } catch (moveStatusError) {
          if (operationAttempt !== moveStatusAttemptRef.current || operationController.signal.aborted) return
          console.error('查詢油性噴畫歸檔狀態失敗', moveStatusError)
          finalPhase = 'warning'
          finalMessage = `${resultMessage}\n暫時無法確認油性噴畫歸檔結果；若發生異常，LINE 助手會通知承辦人。`
        }
      } else if (moveQueue?.status === 'failed') {
        finalPhase = 'error'
      } else if (moveQueue?.status === 'skipped') {
        finalPhase = 'warning'
      }
      setPhase(finalPhase)
      setMessage(continuousCamera ? `${finalMessage}\n相機保持開啟，請繼續掃描下一張。` : finalMessage)
    } catch (error) {
      if (operationAttempt !== null && (
        operationAttempt !== moveStatusAttemptRef.current
        || operationController?.signal.aborted
      )) return
      if (salesId) processedRef.current.delete(salesId)
      setPhase('error')
      const errorMessage = error instanceof Error ? error.message : '掃描失敗，請稍後再試。'
      setMessage(continuousCamera ? `${errorMessage} 相機保持開啟，可繼續掃描。` : errorMessage)
    } finally {
      if (activeOperationAbortRef.current === operationController) activeOperationAbortRef.current = null
      processingRef.current = false
    }
  }, [scanSessionId])

  useEffect(() => {
    void preloadErpOrderScanner().catch(() => undefined)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (reminderOpenRef.current) closeReminder()
      else closeScanner()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      cameraAttemptRef.current += 1
      imageAttemptRef.current += 1
      moveStatusAttemptRef.current += 1
      activeOperationAbortRef.current?.abort()
      activeOperationAbortRef.current = null
      try {
        controlsRef.current?.stop()
      } catch (error) {
        console.error('清理 QR Code 相機失敗', error)
      }
      controlsRef.current = null
      stopVideoTracks(videoRef.current)
    }
  }, [closeReminder, closeScanner])

  async function startCamera() {
    stopCamera()
    if (!supportsLiveCamera()) {
      const input = cameraCaptureInputRef.current
      if (!input) {
        setPhase('error')
        setMessage('拍照功能尚未準備完成，請重新開啟掃描器後再試。')
        return
      }
      input.value = ''
      input.click()
      return
    }

    const cameraAttempt = cameraAttemptRef.current
    lastLiveScanRef.current = ''
    setPhase('idle')
    setCameraStarting(true)
    setMessage('相機啟動中...')
    try {
      const { BrowserQRCodeReader } = await loadQrReader()
      const reader = new BrowserQRCodeReader()
      if (!videoRef.current) throw new Error('掃描畫面尚未準備完成。')
      const controls = await reader.decodeFromConstraints({
        audio: false,
        video: { facingMode: { ideal: 'environment' } }
      }, videoRef.current, (result) => {
        if (!result || processingRef.current || reminderOpenRef.current) return
        const rawValue = result.getText()
        if (rawValue === lastLiveScanRef.current) return
        lastLiveScanRef.current = rawValue
        void processSalesId(rawValue, 'camera')
      })
      if (cameraAttempt !== cameraAttemptRef.current) {
        controls.stop()
        stopVideoTracks(videoRef.current)
        return
      }
      controlsRef.current = controls
      setCameraActive(true)
      setMessage('相機已開啟，請將銷貨單 QR Code 對準框內。')
    } catch (error) {
      if (cameraAttempt !== cameraAttemptRef.current) return
      stopCamera()
      setPhase('error')
      setMessage(cameraErrorMessage(error))
    } finally {
      if (cameraAttempt === cameraAttemptRef.current) setCameraStarting(false)
    }
  }

  async function scanImage(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    stopCamera()
    if (file.type && !file.type.startsWith('image/')) {
      setPhase('error')
      setMessage('請選擇圖片格式的 QR Code 檔案。')
      return
    }
    const imageAttempt = ++imageAttemptRef.current
    setPhase('processing')
    setMessage('正在辨識照片中的 QR Code...')
    try {
      const decodedText = await decodeQrImage(file)
      if (imageAttempt !== imageAttemptRef.current) return
      await processSalesId(decodedText, 'photo')
    } catch (error) {
      if (imageAttempt !== imageAttemptRef.current) return
      setPhase('error')
      setMessage(error instanceof Error ? `拍照辨識失敗：${error.message}` : '照片中找不到可辨識的 QR Code。')
    }
  }

  const busy = cameraStarting || phase === 'processing'
  const cameraButtonDisabled = cameraStarting || (phase === 'processing' && !cameraActive)

  return createPortal(
    <div className="erp-order-scanner" role="dialog" aria-modal="true" aria-label="銷貨單狀態掃描">
      <style>{`
        .erp-order-scanner { position: fixed; inset: 0; z-index: 100000; min-height: 100dvh; overflow-y: auto; background: #f3f5f4; color: #18211d; padding-bottom: calc(24px + env(safe-area-inset-bottom)); box-sizing: border-box; }
        .erp-order-scanner * { box-sizing: border-box; }
        .erp-order-scanner-header { position: sticky; top: 0; z-index: 2; min-height: 58px; display: grid; grid-template-columns: 52px 1fr 52px; align-items: center; padding: max(6px, env(safe-area-inset-top)) 8px 6px; background: #087f5b; color: #fff; box-shadow: 0 1px 5px rgba(0,0,0,.2); }
        .erp-order-scanner-header h1 { margin: 0; text-align: center; font-size: 19px; }
        .erp-order-scanner-close { min-width: 44px; min-height: 44px; border: 0; background: transparent; color: #fff; font-size: 30px; line-height: 1; }
        .erp-order-scanner-content { width: min(100%, 520px); margin: 0 auto; padding: 12px; }
        .erp-order-scanner-panel { overflow: hidden; border: 1px solid #c8cecb; background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
        .erp-order-scanner-video { position: relative; aspect-ratio: 1 / 1; background: #111; }
        .erp-order-scanner-video video { display: block; width: 100%; height: 100%; object-fit: cover; }
        .erp-order-scanner-frame { position: absolute; inset: 16%; border: 3px solid #25d998; box-shadow: 0 0 0 999px rgba(0,0,0,.2); pointer-events: none; }
        .erp-order-scanner-video.is-photo-mode { display: grid; place-items: center; background: #26312c; }
        .erp-order-scanner-video.is-photo-mode video, .erp-order-scanner-video.is-photo-mode .erp-order-scanner-frame { display: none; }
        .erp-order-scanner-photo-hint { padding: 24px; color: #fff; text-align: center; font-size: 16px; line-height: 1.6; }
        .erp-order-scanner-message { min-height: 68px; display: grid; place-items: center; padding: 12px 16px; border-top: 1px solid #ddd; text-align: center; line-height: 1.5; white-space: pre-line; overflow-wrap: anywhere; }
        .erp-order-scanner-message.is-error { color: #a21d18; background: #fff3f2; }
        .erp-order-scanner-message.is-warning { color: #765500; background: #fff7dc; font-weight: bold; }
        .erp-order-scanner-message.is-success { color: #086846; background: #edfff7; font-weight: bold; }
        .erp-order-scanner-actions { display: grid; gap: 10px; margin-top: 12px; }
        .erp-order-scanner-action { width: 100%; min-height: 48px; border: 1px solid #777; background: #fff; color: #18211d; font-size: 16px; }
        .erp-order-scanner-action.primary { border-color: #087f5b; background: #087f5b; color: #fff; }
        .erp-order-scanner-capture-input { position: fixed; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
        .erp-order-scanner-card { margin-top: 14px; border: 1px solid #c8cecb; background: #fff; padding: 14px; }
        .erp-order-scanner-card h2 { margin: 0 0 10px; font-size: 17px; }
        .erp-order-scanner-grid { display: grid; grid-template-columns: 90px minmax(0,1fr); gap: 9px 10px; line-height: 1.45; }
        .erp-order-scanner-label { color: #68716d; }
        .erp-order-scanner-status { color: #087f5b; font-size: 18px; font-weight: bold; }
        .erp-order-scanner-reminder-backdrop { position: fixed; inset: 0; z-index: 5; display: grid; place-items: center; padding: max(16px, env(safe-area-inset-top)) 16px calc(16px + env(safe-area-inset-bottom)); background: rgba(10,20,15,.58); }
        .erp-order-scanner-reminder-backdrop[hidden] { display: none; }
        .erp-order-scanner-reminder { width: min(100%, 560px); max-height: min(82dvh, 720px); display: flex; flex-direction: column; overflow: hidden; border-radius: 14px; background: #fff; box-shadow: 0 18px 60px rgba(0,0,0,.32); }
        .erp-order-scanner-reminder-header { padding: 18px 18px 12px; border-bottom: 1px solid #dce2df; }
        .erp-order-scanner-reminder-header h2 { margin: 0; color: #075c47; font-size: 20px; font-weight: 500; line-height: 1.4; }
        .erp-order-scanner-reminder-header p { margin: 7px 0 0; color: #68716d; font-size: 14px; line-height: 1.45; }
        .erp-order-scanner-reminder-list { display: grid; gap: 10px; min-height: 0; margin: 0; padding: 12px 18px; overflow-y: auto; list-style: none; background: #fff; }
        .erp-order-scanner-reminder-order { padding: 13px 13px 13px 15px; border: 1px solid #cbd7d2; border-left: 4px solid #0aa17b; border-radius: 9px; background: #fbfdfc; }
        .erp-order-scanner-reminder-order-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
        .erp-order-scanner-reminder-order-heading strong { font-size: 17px; }
        .erp-order-scanner-reminder-address-badge { display: inline-flex; flex: 0 0 auto; align-items: center; min-height: 26px; padding: 2px 8px; border-radius: 999px; background: #ddf7eb; color: #087f5b; font-size: 13px; font-weight: bold; }
        .erp-order-scanner-reminder-address-badge.needs-check { background: #fff0cc; color: #765500; }
        .erp-order-scanner-reminder-details { display: grid; grid-template-columns: 90px minmax(0,1fr); gap: 7px 8px; font-size: 14px; line-height: 1.45; }
        .erp-order-scanner-reminder-label { color: #68716d; }
        .erp-order-scanner-reminder-status { color: #087f5b; font-weight: 700; }
        .erp-order-scanner-reminder-truncated { padding: 10px 12px; border-radius: 8px; background: #fff7dc; color: #765500; font-size: 13px; line-height: 1.5; }
        .erp-order-scanner-reminder-footer { padding: 12px 18px calc(12px + env(safe-area-inset-bottom)); border-top: 1px solid #dce2df; background: #fff; }
        .erp-order-scanner-reminder-close { width: 100%; min-height: 48px; border: 0; border-radius: 0; background: #f7f7f7; color: #18211d; font-size: 16px; font-weight: 500; }
        .erp-order-scanner-reminder-close:active { background: #ecefed; }
        @media (max-width: 600px) {
          .erp-order-scanner-reminder-backdrop { padding: max(16px, env(safe-area-inset-top)) 16px calc(16px + env(safe-area-inset-bottom)); }
          .erp-order-scanner-reminder { width: 100%; max-height: 82dvh; border-radius: 14px; }
          .erp-order-scanner-reminder-details { grid-template-columns: 90px minmax(0,1fr); }
        }
      `}</style>
      <header className="erp-order-scanner-header">
        <span />
        <h1>銷貨單狀態掃描</h1>
        <button type="button" className="erp-order-scanner-close" onClick={closeScanner} aria-label="關閉掃描器">×</button>
      </header>
      <div className="erp-order-scanner-content">
        <section className="erp-order-scanner-panel">
          <div className={`erp-order-scanner-video${liveCameraSupported ? '' : ' is-photo-mode'}`}>
            <video ref={videoRef} muted playsInline aria-label="QR Code 掃描預覽" />
            <div className="erp-order-scanner-frame" />
            {!liveCameraSupported && <div className="erp-order-scanner-photo-hint">此裝置無法使用即時預覽<br />請拍照後辨識 QR Code</div>}
          </div>
          <div className={`erp-order-scanner-message${phase === 'error' ? ' is-error' : phase === 'warning' ? ' is-warning' : phase === 'success' ? ' is-success' : ''}`} role={phase === 'error' ? 'alert' : 'status'}>{message}</div>
        </section>

        <div className="erp-order-scanner-actions">
          <button type="button" className="erp-order-scanner-action primary" onClick={() => void (cameraActive ? stopCamera() : startCamera())} disabled={cameraButtonDisabled}>
            {cameraStarting ? '相機啟動中...' : cameraActive ? '停止相機' : liveCameraSupported ? '開啟相機掃描' : '拍照掃描 QR Code'}
          </button>
          <input
            ref={cameraCaptureInputRef}
            className="erp-order-scanner-capture-input"
            type="file"
            accept="image/*"
            capture="environment"
            aria-label="拍照掃描 QR Code"
            onChange={(event) => void scanImage(event)}
            disabled={busy}
          />
        </div>

        {order && (
          <section className="erp-order-scanner-card">
            <h2>銷貨單資料</h2>
            <div className="erp-order-scanner-grid">
              <div className="erp-order-scanner-label">銷貨單號</div><div>{order.salesNo || '—'}</div>
              <div className="erp-order-scanner-label">客戶</div><div>{order.customer || '—'}</div>
              <div className="erp-order-scanner-label">取件方式</div><div>{order.shippingMethod || '—'}</div>
              <div className="erp-order-scanner-label">訂單狀態</div><div className="erp-order-scanner-status">{order.orderStatus}</div>
            </div>
          </section>
        )}
      </div>

      <div className="erp-order-scanner-reminder-backdrop" hidden={!reminderOpen}>
        <section className="erp-order-scanner-reminder" role="alertdialog" aria-modal="true" aria-labelledby="erp-order-scanner-reminder-title">
          <header className="erp-order-scanner-reminder-header">
            <h2 id="erp-order-scanner-reminder-title">同一客戶還有 {reminderOrders.length} 筆待處理訂單</h2>
            <p>請核對日期時間與地址，確認是否可一併配送或施工。</p>
          </header>
          <ul className="erp-order-scanner-reminder-list">
            {reminderOrders.map((relatedOrder) => (
              <li className="erp-order-scanner-reminder-order" key={relatedOrder.salesId || relatedOrder.id}>
                <div className="erp-order-scanner-reminder-order-heading">
                  <strong>{relatedOrder.salesNo || '未設定單號'}</strong>
                  <span className={`erp-order-scanner-reminder-address-badge${relatedOrder.sameAddress ? '' : ' needs-check'}`}>
                    {relatedOrder.sameAddress ? '同地址' : '地址需確認'}
                  </span>
                </div>
                <div className="erp-order-scanner-reminder-details">
                  <div className="erp-order-scanner-reminder-label">客戶</div><div>{[relatedOrder.customerCode, relatedOrder.customer].filter(Boolean).join(' ') || '—'}</div>
                  <div className="erp-order-scanner-reminder-label">方式</div><div>{relatedOrder.shippingMethod || '—'}</div>
                  <div className="erp-order-scanner-reminder-label">狀態</div><div className="erp-order-scanner-reminder-status">{relatedOrder.orderStatus}</div>
                  <div className="erp-order-scanner-reminder-label">日期時間</div><div>{fulfillmentSchedule(relatedOrder)}</div>
                  <div className="erp-order-scanner-reminder-label">收件人</div><div>{relatedOrder.recipientName || relatedOrder.customer || '—'}</div>
                  <div className="erp-order-scanner-reminder-label">地址</div><div>{relatedOrder.recipientAddress || '—'}</div>
                </div>
              </li>
            ))}
            {reminderTruncated && (
              <li className="erp-order-scanner-reminder-truncated" role="note">
                符合條件的訂單較多，目前僅顯示部分資料，請回銷貨單查詢確認完整清單。
              </li>
            )}
          </ul>
          <footer className="erp-order-scanner-reminder-footer">
            <button type="button" className="erp-order-scanner-reminder-close" onClick={closeReminder}>我知道了，繼續掃描</button>
          </footer>
        </section>
      </div>
    </div>,
    document.body
  )
}
