import { useQuery } from '@tanstack/react-query'
import { collection, getDocs } from 'firebase/firestore'
import { db } from '../lib/firebase'
import type { CalendarEvent, CalendarGroup } from '../types'

export function useCalendarGroups() {
  return useQuery({
    queryKey: ['calendarCalendars'],
    queryFn: async () => {
      const snap = await getDocs(collection(db, 'calendarCalendars'))
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as CalendarGroup[]
      return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
    },
    staleTime: 2 * 60 * 1000
  })
}

export function useCalendarEvents() {
  return useQuery({
    queryKey: ['calendarEvents'],
    queryFn: async () => {
      const snap = await getDocs(collection(db, 'calendarEvents'))
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as CalendarEvent[]
      return rows.sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`))
    },
    staleTime: 60 * 1000
  })
}
