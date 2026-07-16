import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { signInWithEmailAndPassword } from 'firebase/auth'
import { auth } from '../lib/firebase'
import { useAuth } from '../contexts/AuthContext'
import {
  employeeLoginEmail,
  formatEmployeeLoginInput,
  isEmployeeLoginId,
  normalizeEmployeeLoginId,
} from '../lib/employeeLogin'

const REMEMBER_KEY = 'cityPainterCalendarRememberLogin'

type RememberedLogin = {
  empNo: string
  remember: boolean
}

function readRememberedLogin(): RememberedLogin {
  try {
    const raw = window.localStorage.getItem(REMEMBER_KEY)
    const parsed = raw
      ? JSON.parse(raw) as (Partial<RememberedLogin> & { password?: unknown }) | null
      : null
    const remembered = {
      empNo: formatEmployeeLoginInput(parsed?.empNo),
      remember: parsed?.remember ?? true,
    }
    if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'password')) {
      window.localStorage.setItem(REMEMBER_KEY, JSON.stringify(remembered))
    }
    return remembered
  } catch {
    return { empNo: '', remember: true }
  }
}

function writeRememberedLogin(value: RememberedLogin) {
  try {
    if (value.remember) {
      window.localStorage.setItem(REMEMBER_KEY, JSON.stringify({ empNo: value.empNo, remember: true }))
    } else {
      window.localStorage.removeItem(REMEMBER_KEY)
    }
  } catch {
    // 記憶登入資訊失敗不影響登入流程。
  }
}

export default function LoginPage() {
  const { user, loading } = useAuth()
  const remembered = readRememberedLogin()
  const [empNo, setEmpNo] = useState(remembered.empNo)
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [remember, setRemember] = useState(remembered.remember)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  if (!loading && user) return <Navigate to="/" replace />

  async function login() {
    const normalizedEmpNo = normalizeEmployeeLoginId(empNo)
    if (!normalizedEmpNo || !password) {
      setError('請輸入員工編號與密碼')
      return
    }
    if (!isEmployeeLoginId(normalizedEmpNo)) {
      setError('員工編號格式需為 c 加 6 位數字')
      return
    }

    setSubmitting(true)
    setError('')
    try {
      await signInWithEmailAndPassword(auth, employeeLoginEmail(normalizedEmpNo), password)
      writeRememberedLogin({ empNo: normalizedEmpNo, remember })
    } catch {
      setError('員工編號或密碼錯誤，請確認後再試')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-page login-page--calendar">
      <section className="login-panel">
        <div className="login-logo">都市彩繪</div>
        <h1>行事曆</h1>
        <p>請輸入員工編號與密碼登入。</p>
        {error && <div className="form-error">{error}</div>}
        <div className="login-form">
          <input
            value={empNo}
            onChange={(event) => setEmpNo(formatEmployeeLoginInput(event.target.value))}
            placeholder="員工編號"
            autoComplete="username"
            inputMode="numeric"
            maxLength={7}
          />
          <div className="login-password-row">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void login()
              }}
              placeholder="密碼"
              autoComplete="current-password"
            />
            <button type="button" onClick={() => setShowPassword(prev => !prev)}>
              {showPassword ? '隱藏' : '顯示'}
            </button>
          </div>
          <label className="login-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            <span>記憶帳號</span>
          </label>
          <button type="button" className="login-btn" onClick={login} disabled={submitting}>
            {submitting ? '登入中...' : '登入'}
          </button>
        </div>
      </section>
    </div>
  )
}
