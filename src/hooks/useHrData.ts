import { useQuery } from '@tanstack/react-query'
import { collection, getDocs, orderBy, query } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { readLocalQueryCache, writeLocalQueryCache } from '../lib/localQueryCache'
import type { Department, Employee, Shift } from '../types'

function sortDepartments(rows: Department[]) {
  return rows
    .map((department, index) => ({ ...department, __index: index }))
    .sort((a, b) => {
      const sortA = typeof a.sort === 'number' ? a.sort : Number.MAX_SAFE_INTEGER
      const sortB = typeof b.sort === 'number' ? b.sort : Number.MAX_SAFE_INTEGER
      if (sortA !== sortB) return sortA - sortB
      return a.__index - b.__index
    })
    .map(({ __index, ...department }) => department)
}

export function useEmployees() {
  return useQuery({
    queryKey: ['employees'],
    queryFn: async () => {
      const snap = await getDocs(query(collection(db, 'employees'), orderBy('name')))
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as Employee[]
      writeLocalQueryCache('employees', rows)
      return rows
    },
    placeholderData: () => readLocalQueryCache<Employee[]>('employees'),
    staleTime: 5 * 60 * 1000
  })
}

export function useDepartments() {
  return useQuery({
    queryKey: ['departments'],
    queryFn: async () => {
      const snap = await getDocs(collection(db, 'departments'))
      const rows = sortDepartments(snap.docs.map((d) => ({ id: d.id, ...d.data() })) as Department[])
      writeLocalQueryCache('departments', rows)
      return rows
    },
    placeholderData: () => sortDepartments(readLocalQueryCache<Department[]>('departments') ?? []),
    staleTime: 5 * 60 * 1000
  })
}

export function useShifts() {
  return useQuery({
    queryKey: ['shifts'],
    queryFn: async () => {
      const snap = await getDocs(collection(db, 'shifts'))
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as Shift[]
      writeLocalQueryCache('shifts', rows)
      return rows
    },
    placeholderData: () => readLocalQueryCache<Shift[]>('shifts'),
    staleTime: 5 * 60 * 1000
  })
}
