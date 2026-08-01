import { lazy, StrictMode, Suspense, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import { useAuth } from './contexts/AuthContext'
import AppShell from './components/AppShell'
import LoginPage from './pages/LoginPage'
import { setupAppUpdateChecks } from './lib/appUpdate'
import { setupVisualViewportVars } from './lib/visualViewport'
import './styles.css'

const queryClient = new QueryClient()
const loadCalendarPage = () => import('./pages/CalendarPage')
const CalendarPage = lazy(loadCalendarPage)

type CalendarRootElement = HTMLElement & {
  cityPainterCalendarRoot?: Root
}

if (import.meta.env.DEV && window.location.hostname === '127.0.0.1') {
  window.location.replace(`http://localhost:${window.location.port}${window.location.pathname}${window.location.search}${window.location.hash}`)
}

setupAppUpdateChecks()
setupVisualViewportVars()

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type !== 'OPEN_URL' || !event.data.url) return
    const url = new URL(event.data.url, window.location.origin)
    if (url.origin === window.location.origin) {
      window.location.href = `${url.pathname}${url.search}${url.hash}`
    }
  })
}

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, role, loading } = useAuth()

  useEffect(() => {
    if (user) void loadCalendarPage()
  }, [user])

  if (loading || role === 'loading') return <CalendarLoadingShell />
  if (!user) return <Navigate to="/login" replace />
  if (role === 'unknown') return <div className="loading-page">此帳號尚未設定 HR 權限</div>
  return children
}

function CalendarLoadingShell() {
  return (
    <div className="calendar-startup-shell" aria-label="行事曆載入中" aria-busy="true">
      <header className="calendar-startup-topbar">
        <strong><span>✣</span> Citypainter</strong>
        <i />
        <i />
        <i className="calendar-startup-title" />
      </header>
      <main className="calendar-startup-main">
        <aside>
          <i />
          <i />
          <i />
        </aside>
        <section>
          <div className="calendar-startup-weekdays">
            {['日', '一', '二', '三', '四', '五', '六'].map((day) => <span key={day}>{day}</span>)}
          </div>
          <div className="calendar-startup-grid">
            {Array.from({ length: 42 }, (_, index) => <i key={index} />)}
          </div>
        </section>
      </main>
    </div>
  )
}

function CalendarRoutePage() {
  return (
    <Suspense fallback={<CalendarLoadingShell />}>
      <CalendarPage />
    </Suspense>
  )
}

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: (
      <AuthGuard>
        <AppShell />
      </AuthGuard>
    ),
    children: [
      { index: true, element: <CalendarRoutePage /> }
    ]
  }
])

const rootElement = document.getElementById('root') as CalendarRootElement
const appRoot = rootElement.cityPainterCalendarRoot ?? createRoot(rootElement)
rootElement.cityPainterCalendarRoot = appRoot

appRoot.render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>
)
