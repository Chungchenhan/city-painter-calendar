import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import { useAuth } from './contexts/AuthContext'
import AppShell from './components/AppShell'
import CalendarPage from './pages/CalendarPage'
import LoginPage from './pages/LoginPage'
import { setupAppUpdateChecks } from './lib/appUpdate'
import './styles.css'

const queryClient = new QueryClient()

if (import.meta.env.DEV && window.location.hostname === '127.0.0.1') {
  window.location.replace(`http://localhost:${window.location.port}${window.location.pathname}${window.location.search}${window.location.hash}`)
}

setupAppUpdateChecks()

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>
)
