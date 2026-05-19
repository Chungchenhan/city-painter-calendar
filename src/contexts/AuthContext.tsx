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
        setLoading(false)
        return
      }

      setUser(nextUser)

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

        if (nextEmployeeId) {
          const empSnap = await getDoc(doc(db, 'employees', nextEmployeeId))
          const empName = empSnap.exists() ? (empSnap.data() as { name?: string }).name : ''
          setDisplayName(empName || roleData.displayName || nextUser.displayName || '')
        } else {
          setDisplayName(roleData.displayName || nextUser.displayName || '')
        }
      } catch {
        setRole('unknown')
        setEmployeeId(null)
        setDisplayName(nextUser.displayName ?? nextUser.email ?? '')
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
