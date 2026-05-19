import { useQuery } from '@tanstack/react-query'
import { collection, getDocs, orderBy, query } from 'firebase/firestore'
import { db } from '../lib/firebase'
import type { Department, Employee } from '../types'

export function useEmployees() {
  return useQuery({
    queryKey: ['employees'],
    queryFn: async () => {
      const snap = await getDocs(query(collection(db, 'employees'), orderBy('name')))
      return snap.docs.map((d) => ({ id: d.id, ...d.data() })) as Employee[]
    },
    staleTime: 5 * 60 * 1000
  })
}

export function useDepartments() {
  return useQuery({
    queryKey: ['departments'],
    queryFn: async () => {
      const snap = await getDocs(collection(db, 'departments'))
      return snap.docs.map((d) => ({ id: d.id, ...d.data() })) as Department[]
    },
    staleTime: 5 * 60 * 1000
  })
}
