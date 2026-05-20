import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { onAuthStateChanged, type User } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db } from '../lib/firebase'
import type { UserRole } from '../types'

interface AuthContextType {
  user: User | null
  role: 'admin' | 'employee' | 'loading' | 'unknown'
  employeeId: string | null
  displayName: string
  loading: boolean
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  role: 'loading',
  employeeId: null,
  displayName: '',
  loading: true
})

const AUTH_PROFILE_CACHE_KEY = 'cityPainterCalendarAuthProfile'

type CachedAuthProfile = {
  uid: string
  role: AuthContextType['role']
  employeeId: string | null
  displayName: string
}

function readCachedAuthProfile(uid: string) {
  try {
    const raw = window.localStorage.getItem(AUTH_PROFILE_CACHE_KEY)
    const cached = raw ? JSON.parse(raw) as CachedAuthProfile : null
    return cached?.uid === uid ? cached : null
  } catch {
    return null
  }
}

function writeCachedAuthProfile(profile: CachedAuthProfile) {
  try {
    window.localStorage.setItem(AUTH_PROFILE_CACHE_KEY, JSON.stringify(profile))
  } catch {
    // 權限快取失敗不影響登入流程。
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [role, setRole] = useState<AuthContextType['role']>('loading')
  const [employeeId, setEmployeeId] = useState<string | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (nextUser) => {
      setLoading(true)

      if (!nextUser) {
        setUser(null)
        setRole('unknown')
        setEmployeeId(null)
        setDisplayName('')
        try {
          window.localStorage.removeItem(AUTH_PROFILE_CACHE_KEY)
        } catch {
          // 忽略本機快取清除失敗。
        }
        setLoading(false)
        return
      }

      setUser(nextUser)
      const cachedProfile = readCachedAuthProfile(nextUser.uid)
      if (cachedProfile) {
        setRole(cachedProfile.role)
        setEmployeeId(cachedProfile.employeeId)
        setDisplayName(cachedProfile.displayName)
        setLoading(false)
      }

      try {
        const roleSnap = await getDoc(doc(db, 'userRoles', nextUser.uid))

        if (!roleSnap.exists()) {
          setRole('unknown')
          setEmployeeId(null)
          setDisplayName(nextUser.displayName ?? nextUser.email ?? '')
          setLoading(false)
          return
        }

        const roleData = roleSnap.data() as UserRole
        const nextEmployeeId = roleData.employeeId ?? null
        setRole(roleData.role)
        setEmployeeId(nextEmployeeId)
        let nextDisplayName = roleData.displayName || nextUser.displayName || ''

        if (nextEmployeeId) {
          const empSnap = await getDoc(doc(db, 'employees', nextEmployeeId))
          const empData = empSnap.exists() ? (empSnap.data() as { name?: string; nickname?: string }) : {}
          nextDisplayName = empData.nickname || empData.name || nextDisplayName
        }
        setDisplayName(nextDisplayName)
        writeCachedAuthProfile({
          uid: nextUser.uid,
          role: roleData.role,
          employeeId: nextEmployeeId,
          displayName: nextDisplayName
        })
      } catch {
        if (!cachedProfile) {
          setRole('unknown')
          setEmployeeId(null)
          setDisplayName(nextUser.displayName ?? nextUser.email ?? '')
        }
      } finally {
        setLoading(false)
      }
    })

    return unsub
  }, [])

  return (
    <AuthContext.Provider value={{ user, role, employeeId, displayName, loading }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
