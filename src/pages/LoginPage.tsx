import { useEffect, useRef, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { GoogleAuthProvider, signInWithEmailAndPassword, signInWithPopup } from 'firebase/auth'
import { auth } from '../lib/firebase'
import { useAuth } from '../contexts/AuthContext'

export default function LoginPage() {
  const { user, loading } = useAuth()
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const devAutoLoginStartedRef = useRef(false)
  const isLocalNetworkPreview = import.meta.env.DEV && /^\d{1,3}(\.\d{1,3}){3}$/.test(window.location.hostname)

  useEffect(() => {
    if (!isLocalNetworkPreview || user || loading || devAutoLoginStartedRef.current) return
    if (!import.meta.env.VITE_DEV_EMAIL || !import.meta.env.VITE_DEV_PASSWORD) return

    devAutoLoginStartedRef.current = true
    setSubmitting(true)
    setError('')
    signInWithEmailAndPassword(auth, import.meta.env.VITE_DEV_EMAIL, import.meta.env.VITE_DEV_PASSWORD)
      .catch((err) => {
        const code = (err as { code?: string }).code
        setError(`開發預覽登入失敗：${code || '請稍後再試'}`)
      })
      .finally(() => setSubmitting(false))
  }, [isLocalNetworkPreview, loading, user])

  if (!loading && user) return <Navigate to="/" replace />

  async function login() {
    setSubmitting(true)
    setError('')
    try {
      const provider = new GoogleAuthProvider()
      provider.setCustomParameters({ prompt: 'select_account' })
      if (import.meta.env.DEV) {
        localStorage.setItem('cityPainterCalendarDisableDevAutoLogin', '1')
      }
      await signInWithPopup(auth, provider)
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code !== 'auth/popup-closed-by-user') setError(`登入失敗：${code || '請稍後再試'}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-page">
      <section className="login-panel">
        <div className="login-logo">都市彩繪</div>
        <h1>行事曆</h1>
        <p>登入後依 HR 權限查看部門工作與共享行程。</p>
        {error && <div className="form-error">{error}</div>}
        <button className="primary-btn login-btn" onClick={login} disabled={submitting || isLocalNetworkPreview}>
          {submitting ? '登入中...' : isLocalNetworkPreview ? '本地預覽自動登入' : '使用 Google 登入'}
        </button>
      </section>
    </div>
  )
}
