import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { GoogleAuthProvider, getRedirectResult, signInWithPopup, signInWithRedirect } from 'firebase/auth'
import { auth } from '../lib/firebase'
import { useAuth } from '../contexts/AuthContext'

function isStandalonePwa() {
  const navigatorWithStandalone = window.navigator as Navigator & { standalone?: boolean }
  return window.matchMedia('(display-mode: standalone)').matches || navigatorWithStandalone.standalone === true
}

function shouldUseRedirectLogin() {
  return isStandalonePwa() || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
}

export default function LoginPage() {
  const { user, loading } = useAuth()
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    getRedirectResult(auth).catch((err) => {
      const code = (err as { code?: string }).code
      if (code && code !== 'auth/no-auth-event') setError(`登入失敗：${code}`)
    })
  }, [])

  if (!loading && user) return <Navigate to="/" replace />

  async function login() {
    setSubmitting(true)
    setError('')
    try {
      const provider = new GoogleAuthProvider()
      if (shouldUseRedirectLogin()) {
        await signInWithRedirect(auth, provider)
        return
      }
      await signInWithPopup(auth, provider)
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === 'auth/popup-blocked' || code === 'auth/cancelled-popup-request') {
        await signInWithRedirect(auth, new GoogleAuthProvider())
        return
      }
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
        <button className="primary-btn login-btn" onClick={login} disabled={submitting}>
          {submitting ? '登入中...' : '使用 Google 登入'}
        </button>
      </section>
    </div>
  )
}
