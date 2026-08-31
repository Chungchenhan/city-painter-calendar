import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { User } from 'firebase/auth'
import { doc, onSnapshot } from 'firebase/firestore'
import { db, refreshFirebaseSession } from '../lib/firebase'
import { readLocalQueryCache, removeLocalQueryCache, writeLocalQueryCache } from '../lib/localQueryCache'
import {
  fetchSalesOperationalStatus,
  normalizeSalesLineStatusPatch,
  normalizeSalesPaymentStatusPatch,
  splitSalesOperationalStatus,
  type SalesLineStatusPatch,
  type SalesOperationalStatus,
  type SalesPaymentStatusPatch,
} from '../lib/salesOperationalStatus'

type KeyedStatus = {
  key: string
  status: SalesOperationalStatus | null
}

type KeyedRequestState = {
  key: string
  loading: boolean
  error: string
}

type StatusCache = {
  lineStatus?: SalesLineStatusPatch
  paymentStatus?: SalesPaymentStatusPatch
}

function cacheKeys(uid: string, eventId: string) {
  const base = `sales-operational-status:${uid}:${eventId}`
  return {
    line: `${base}:line`,
    payment: `${base}:payment`,
  }
}

function statusForAccess(status: SalesOperationalStatus, canViewPayment: boolean) {
  if (canViewPayment) return status
  const { lineStatus } = splitSalesOperationalStatus(status)
  return lineStatus as SalesOperationalStatus
}

function readCachedStatus(uid: string, eventId: string, canViewPayment: boolean): SalesOperationalStatus | null {
  if (!uid || !eventId) return null
  const keys = cacheKeys(uid, eventId)
  const lineStatus = readLocalQueryCache<SalesLineStatusPatch>(keys.line)
  if (!lineStatus || typeof lineStatus.eligible !== 'boolean' || typeof lineStatus.bound !== 'boolean') return null
  const paymentStatus = canViewPayment
    ? readLocalQueryCache<SalesPaymentStatusPatch>(keys.payment)
    : undefined
  return { ...lineStatus, ...paymentStatus } as SalesOperationalStatus
}

function writeStatusCache(uid: string, eventId: string, status: SalesOperationalStatus, canViewPayment: boolean) {
  const keys = cacheKeys(uid, eventId)
  const { lineStatus, paymentStatus } = splitSalesOperationalStatus(status)
  writeLocalQueryCache(keys.line, lineStatus)
  if (canViewPayment) writeLocalQueryCache(keys.payment, paymentStatus)
}

function writePatchCache(uid: string, eventId: string, patch: StatusCache) {
  const keys = cacheKeys(uid, eventId)
  if (patch.lineStatus) {
    writeLocalQueryCache(keys.line, {
      ...readLocalQueryCache<SalesLineStatusPatch>(keys.line),
      ...patch.lineStatus,
    })
  }
  if (patch.paymentStatus) {
    writeLocalQueryCache(keys.payment, {
      ...readLocalQueryCache<SalesPaymentStatusPatch>(keys.payment),
      ...patch.paymentStatus,
    })
  }
}

export function useSalesOperationalStatus({
  user,
  eventId,
  enabled,
  canViewPayment,
}: {
  user: User | null
  eventId: string
  enabled: boolean
  canViewPayment: boolean
}) {
  const uid = user?.uid ?? ''
  const key = enabled && uid && eventId ? `${uid}:${eventId}:${canViewPayment ? 'payment' : 'line'}` : ''
  const cachedStatus = useMemo(
    () => readCachedStatus(uid, eventId, canViewPayment),
    [canViewPayment, eventId, uid],
  )
  const [keyedStatus, setKeyedStatus] = useState<KeyedStatus>(() => ({ key, status: cachedStatus }))
  const [requestState, setRequestState] = useState<KeyedRequestState>(() => ({
    key,
    loading: Boolean(key && !cachedStatus),
    error: '',
  }))
  const activeKeyRef = useRef(key)
  const revalidateInFlightRef = useRef<{ key: string, request: Promise<void> } | null>(null)
  activeKeyRef.current = key

  const rawStatus = !key ? null : keyedStatus.key === key ? keyedStatus.status : cachedStatus
  const status = rawStatus ? statusForAccess(rawStatus, canViewPayment) : null
  const loading = Boolean(key && requestState.key === key && requestState.loading && !status)
  const error = key && requestState.key === key ? requestState.error : ''

  const commitStatus = useCallback((nextStatus: SalesOperationalStatus | null) => {
    if (!key || !nextStatus || activeKeyRef.current !== key) return
    const accessibleStatus = statusForAccess(nextStatus, canViewPayment)
    writeStatusCache(uid, eventId, accessibleStatus, canViewPayment)
    setKeyedStatus({ key, status: accessibleStatus })
  }, [canViewPayment, eventId, key, uid])

  const setStatus = useCallback<Dispatch<SetStateAction<SalesOperationalStatus | null>>>((updater) => {
    if (!key || activeKeyRef.current !== key) return
    setKeyedStatus((current) => {
      const currentStatus = current.key === key
        ? current.status
        : readCachedStatus(uid, eventId, canViewPayment)
      const nextStatus = typeof updater === 'function' ? updater(currentStatus) : updater
      const accessibleStatus = nextStatus ? statusForAccess(nextStatus, canViewPayment) : null
      if (accessibleStatus) writeStatusCache(uid, eventId, accessibleStatus, canViewPayment)
      return { key, status: accessibleStatus }
    })
  }, [canViewPayment, eventId, key, uid])

  useEffect(() => {
    if (!key || !user) return
    let active = true
    const listenerErrors = { line: '', payment: '', revision: '', api: '' }
    const keys = cacheKeys(uid, eventId)
    if (!canViewPayment) removeLocalQueryCache(keys.payment)
    const cached = readCachedStatus(uid, eventId, canViewPayment)
    setKeyedStatus({ key, status: cached })
    setRequestState({ key, loading: !cached, error: '' })

    const updateError = () => {
      if (!active || activeKeyRef.current !== key) return
      const messages = Object.values(listenerErrors).filter(Boolean)
      const errorPrefix = readCachedStatus(uid, eventId, canViewPayment)
        ? '背景更新失敗，顯示上次資料：'
        : '狀態讀取失敗：'
      setRequestState((current) => ({
        key,
        loading: current.key === key ? current.loading : false,
        error: messages.length > 0 ? `${errorPrefix}${messages.join('；')}` : '',
      }))
    }

    const mergePatch = (patch: StatusCache) => {
      if (!active || activeKeyRef.current !== key) return
      writePatchCache(uid, eventId, patch)
      setKeyedStatus((current) => {
        const currentStatus = current.key === key
          ? current.status
          : readCachedStatus(uid, eventId, canViewPayment)
        const nextStatus = {
          ...(currentStatus ?? {}),
          ...(patch.lineStatus ?? {}),
          ...(patch.paymentStatus ?? {}),
        }
        if (typeof nextStatus.eligible !== 'boolean' || typeof nextStatus.bound !== 'boolean') return current
        const normalized = statusForAccess(nextStatus as SalesOperationalStatus, canViewPayment)
        writeStatusCache(uid, eventId, normalized, canViewPayment)
        return { key, status: normalized }
      })
      setRequestState((current) => ({
        key,
        loading: false,
        error: current.key === key ? current.error : '',
      }))
    }

    const stopLineListener = onSnapshot(
      doc(db, 'calendarSalesLineStatuses', eventId),
      (snapshot) => {
        listenerErrors.line = ''
        if (snapshot.exists()) {
          const lineStatus = normalizeSalesLineStatusPatch(snapshot.data().lineStatus)
          if (lineStatus) mergePatch({ lineStatus })
        }
        updateError()
      },
      (listenerError) => {
        console.warn('[calendar] sales LINE status listener failed', listenerError)
        listenerErrors.line = 'LINE 即時狀態無法連線'
        updateError()
      },
    )
    const stopPaymentListener = canViewPayment ? onSnapshot(
      doc(db, 'calendarSalesPaymentStatuses', eventId),
      (snapshot) => {
        listenerErrors.payment = ''
        if (snapshot.exists()) {
          const paymentStatus = normalizeSalesPaymentStatusPatch(snapshot.data().paymentStatus)
          if (paymentStatus) mergePatch({ paymentStatus })
        }
        updateError()
      },
      (listenerError) => {
        console.warn('[calendar] sales payment status listener failed', listenerError)
        listenerErrors.payment = '付款即時狀態無法連線'
        updateError()
      },
    ) : () => undefined

    const revalidate = (refreshSession = false): Promise<void> => {
      if (!active) return Promise.resolve()
      if (revalidateInFlightRef.current?.key === key) {
        const inFlightRequest = revalidateInFlightRef.current.request
        return refreshSession ? inFlightRequest.then(() => revalidate(true)) : inFlightRequest
      }
      let request: Promise<void> | null = null
      request = (async () => {
        try {
          if (refreshSession) await refreshFirebaseSession()
          const nextStatus = await fetchSalesOperationalStatus(user, eventId)
          if (!active || activeKeyRef.current !== key) return
          listenerErrors.api = ''
          commitStatus(nextStatus)
          setRequestState((current) => ({ key, loading: false, error: current.key === key ? current.error : '' }))
          updateError()
        } catch (refreshError) {
          if (!active || activeKeyRef.current !== key) return
          listenerErrors.api = refreshError instanceof Error ? refreshError.message : '訂單狀態更新失敗'
          setRequestState((current) => ({ key, loading: false, error: current.key === key ? current.error : '' }))
          updateError()
        } finally {
          if (request && revalidateInFlightRef.current?.request === request) revalidateInFlightRef.current = null
        }
      })()
      revalidateInFlightRef.current = { key, request }
      return request
    }

    let revisionSignature = ''
    const stopRevisionListener = onSnapshot(
      doc(db, 'calendarSalesStatusRevisions', 'global'),
      (snapshot) => {
        if (!snapshot.exists()) return
        listenerErrors.revision = ''
        const data = snapshot.data()
        const nextSignature = `${Number(data.lineVersion) || 0}:${Number(data.paymentVersion) || 0}`
        if (!revisionSignature) {
          revisionSignature = nextSignature
          return
        }
        if (nextSignature === revisionSignature) return
        revisionSignature = nextSignature
        void revalidate()
      },
      (listenerError) => {
        console.warn('[calendar] sales status revision listener failed', listenerError)
        listenerErrors.revision = '狀態版本監聽無法連線'
        updateError()
      },
    )

    const handleFocus = () => void revalidate(true)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void revalidate(true)
    }
    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    void revalidate()

    return () => {
      active = false
      stopLineListener()
      stopPaymentListener()
      stopRevisionListener()
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [canViewPayment, commitStatus, eventId, key, uid, user])

  return { status, loading, error, setStatus }
}
