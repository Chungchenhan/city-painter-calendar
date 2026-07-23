import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { onAuthStateChanged, signOut, type User } from 'firebase/auth'
import { doc, getDoc, onSnapshot } from 'firebase/firestore'
import { auth, db } from '../lib/firebase'
import {
  canOpenSalesFormFromAccess,
  canScanSalesOrderFromAccess,
  canViewSalesAttachmentsFromAccess,
} from '../lib/erpAccess'
import type { UserRole } from '../types'

interface AuthContextType {
  user: User | null
  role: 'admin' | 'employee' | 'loading' | 'unknown'
  employeeId: string | null
  employeeDepartmentId: string
  employeeDepartmentName: string
  displayName: string
  canOpenSalesForm: boolean
  canScanSalesOrder: boolean
  canViewSalesAttachments: boolean
  loading: boolean
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  role: 'loading',
  employeeId: null,
  employeeDepartmentId: '',
  employeeDepartmentName: '',
  displayName: '',
  canOpenSalesForm: false,
  canScanSalesOrder: false,
  canViewSalesAttachments: false,
  loading: true
})

const AUTH_PROFILE_CACHE_KEY = 'cityPainterCalendarAuthProfile'

type CachedAuthProfile = {
  uid: string
  role: AuthContextType['role']
  employeeId: string | null
  employeeDepartmentId?: string
  employeeDepartmentName?: string
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

function clearCachedAuthProfile() {
  try {
    window.localStorage.removeItem(AUTH_PROFILE_CACHE_KEY)
  } catch {
    // 忽略本機快取清除失敗。
  }
}

function employeeCanAccess(data: { status?: string; resignDate?: string | null } | null): boolean {
  return Boolean(data && data.status !== 'inactive' && !data.resignDate)
}

function erpAccessCanAccess(
  data: Record<string, unknown> | null,
  uid: string,
  employeeId: string,
  employeeNo = '',
): boolean {
  if (!data) return false
  return data.enabled === true
    && data.uid === uid
    && data.employeeId === employeeId
    && (!employeeNo || data.employeeNo === employeeNo)
    && Number(data.schemaVersion) >= 2
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [role, setRole] = useState<AuthContextType['role']>('loading')
  const [employeeId, setEmployeeId] = useState<string | null>(null)
  const [employeeDepartmentId, setEmployeeDepartmentId] = useState('')
  const [employeeDepartmentName, setEmployeeDepartmentName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [canOpenSalesForm, setCanOpenSalesForm] = useState(false)
  const [canScanSalesOrder, setCanScanSalesOrder] = useState(false)
  const [canViewSalesAttachments, setCanViewSalesAttachments] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (nextUser) => {
      setLoading(true)
      setCanOpenSalesForm(false)
      setCanScanSalesOrder(false)
      setCanViewSalesAttachments(false)

      if (!nextUser) {
        setUser(null)
        setRole('unknown')
        setEmployeeId(null)
        setEmployeeDepartmentId('')
        setEmployeeDepartmentName('')
        setDisplayName('')
        clearCachedAuthProfile()
        setLoading(false)
        return
      }

      setUser(nextUser)
      const cachedProfile = readCachedAuthProfile(nextUser.uid)
      if (cachedProfile) {
        setRole(cachedProfile.role)
        setEmployeeId(cachedProfile.employeeId)
        setEmployeeDepartmentId(cachedProfile.employeeDepartmentId ?? '')
        setEmployeeDepartmentName(cachedProfile.employeeDepartmentName ?? '')
        setDisplayName(cachedProfile.displayName)
        setLoading(false)
      }

      try {
        const roleSnap = await getDoc(doc(db, 'userRoles', nextUser.uid))

        if (!roleSnap.exists()) {
          clearCachedAuthProfile()
          setRole('unknown')
          setEmployeeId(null)
          setEmployeeDepartmentId('')
          setEmployeeDepartmentName('')
          setDisplayName(nextUser.displayName ?? nextUser.email ?? '')
          setLoading(false)
          return
        }

        const roleData = roleSnap.data() as UserRole
        const nextEmployeeId = roleData.employeeId ?? null
        if (!nextEmployeeId) {
          clearCachedAuthProfile()
          setRole('unknown')
          setEmployeeId(null)
          setEmployeeDepartmentId('')
          setEmployeeDepartmentName('')
          setDisplayName('')
          await signOut(auth)
          setLoading(false)
          return
        }

        setRole(roleData.role)
        setEmployeeId(nextEmployeeId)
        let nextDisplayName = roleData.displayName || nextUser.displayName || ''

        const empSnap = await getDoc(doc(db, 'employees', nextEmployeeId))
        const empData = empSnap.exists()
          ? (empSnap.data() as { empNo?: string; name?: string; nickname?: string; departmentId?: string; departmentName?: string; status?: string; resignDate?: string | null })
          : null
        if (
          !empData
          || !employeeCanAccess(empData)
        ) {
          clearCachedAuthProfile()
          setRole('unknown')
          setEmployeeId(null)
          setEmployeeDepartmentId('')
          setEmployeeDepartmentName('')
          setDisplayName('')
          await signOut(auth)
          setLoading(false)
          return
        }
        nextDisplayName = empData.nickname || empData.name || nextDisplayName
        const nextDepartmentId = empData.departmentId ?? ''
        const nextDepartmentName = empData.departmentName ?? ''
        setEmployeeDepartmentId(nextDepartmentId)
        setEmployeeDepartmentName(nextDepartmentName)
        setDisplayName(nextDisplayName)
        try {
          const accessSnap = await getDoc(doc(db, 'erp_access', nextUser.uid))
          const accessData = accessSnap.exists() ? accessSnap.data() as Record<string, unknown> : null
          setCanOpenSalesForm(
            erpAccessCanAccess(accessData, nextUser.uid, nextEmployeeId, empData.empNo)
            && canOpenSalesFormFromAccess(accessData),
          )
          setCanScanSalesOrder(
            erpAccessCanAccess(accessData, nextUser.uid, nextEmployeeId, empData.empNo)
            && canScanSalesOrderFromAccess(accessData),
          )
          setCanViewSalesAttachments(
            erpAccessCanAccess(accessData, nextUser.uid, nextEmployeeId, empData.empNo)
            && canViewSalesAttachmentsFromAccess(accessData),
          )
        } catch {
          setCanOpenSalesForm(false)
          setCanScanSalesOrder(false)
          setCanViewSalesAttachments(false)
        }
        writeCachedAuthProfile({
          uid: nextUser.uid,
          role: roleData.role,
          employeeId: nextEmployeeId,
          employeeDepartmentId: nextDepartmentId,
          employeeDepartmentName: nextDepartmentName,
          displayName: nextDisplayName
        })
      } catch {
        if (!cachedProfile) {
          setRole('unknown')
          setEmployeeId(null)
          setEmployeeDepartmentId('')
          setEmployeeDepartmentName('')
          setDisplayName(nextUser.displayName ?? nextUser.email ?? '')
        }
      } finally {
        setLoading(false)
      }
    })

    return unsub
  }, [])

  useEffect(() => {
    setCanOpenSalesForm(false)
    setCanScanSalesOrder(false)
    setCanViewSalesAttachments(false)
    if (!user || !employeeId) return
    return onSnapshot(doc(db, 'erp_access', user.uid), async (snapshot) => {
      const accessData = snapshot.exists() ? snapshot.data() as Record<string, unknown> : null
      if (!erpAccessCanAccess(accessData, user.uid, employeeId)) {
        setCanOpenSalesForm(false)
        setCanScanSalesOrder(false)
        setCanViewSalesAttachments(false)
        return
      }
      setCanOpenSalesForm(canOpenSalesFormFromAccess(accessData))
      setCanScanSalesOrder(canScanSalesOrderFromAccess(accessData))
      setCanViewSalesAttachments(canViewSalesAttachmentsFromAccess(accessData))
    }, () => {
      setCanOpenSalesForm(false)
      setCanScanSalesOrder(false)
      setCanViewSalesAttachments(false)
    })
  }, [employeeId, user])

  useEffect(() => {
    if (!user || !employeeId) return

    return onSnapshot(doc(db, 'employees', employeeId), async (snapshot) => {
      const employee = snapshot.exists()
        ? snapshot.data() as { departmentId?: string; departmentName?: string; status?: string; resignDate?: string | null }
        : null
      if (employeeCanAccess(employee)) {
        setEmployeeDepartmentId(employee?.departmentId ?? '')
        setEmployeeDepartmentName(employee?.departmentName ?? '')
        return
      }

      clearCachedAuthProfile()
      setRole('unknown')
      setEmployeeId(null)
      setEmployeeDepartmentId('')
      setEmployeeDepartmentName('')
      setDisplayName('')
      await signOut(auth)
    })
  }, [employeeId, user])

  return (
    <AuthContext.Provider value={{ user, role, employeeId, employeeDepartmentId, employeeDepartmentName, displayName, canOpenSalesForm, canScanSalesOrder, canViewSalesAttachments, loading }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
