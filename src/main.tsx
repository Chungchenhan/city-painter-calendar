import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import { useAuth } from './contexts/AuthContext'
import AppShell from './components/AppShell'
import CalendarPage from './pages/CalendarPage'
import LoginPage from './pages/LoginPage'
import { setupAppUpdateChecks } from './lib/appUpdate'
import { setupVisualViewportVars } from './lib/visualViewport'
import './styles.css'

const queryClient = new QueryClient()

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

  if (loading || role === 'loading') return <div className="loading-page">載入中...</div>
  if (!user) return <Navigate to="/login" replace />
  if (role === 'unknown') return <div className="loading-page">此帳號尚未設定 HR 權限</div>
  return children
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
      { index: true, element: <CalendarPage /> }
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
