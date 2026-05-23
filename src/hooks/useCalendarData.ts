import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { collection, getDocs, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { readLocalQueryCache, writeLocalQueryCache } from '../lib/localQueryCache'
import type { CalendarActivityLog, CalendarEvent, CalendarGroup } from '../types'

const EVENT_ARCHIVE_CACHE_KEY = 'calendarEventsArchive'
const EVENT_ARCHIVE_MONTH_CACHE_KEY = 'calendarEventsArchiveMonths'
const EVENT_SEARCH_CACHE_KEY = 'calendarEventsSearchIndex'
const REPEAT_VALUES: NonNullable<CalendarEvent['repeat']>[] = ['daily', 'weekly', 'weekdays', 'monthly', 'monthlyNthWeekday', 'monthlyDay', 'yearly', 'custom']

function sortEvents(rows: CalendarEvent[]) {
  return rows.sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`))
}

function eventEndDate(event: Pick<CalendarEvent, 'date' | 'endDate'>) {
  return event.endDate || event.date
}

function eventOverlapsRange(event: CalendarEvent, startDate: string, endDate: string) {
  return event.date <= endDate && eventEndDate(event) >= startDate
}

function isRepeatingCalendarEvent(event: CalendarEvent) {
  return REPEAT_VALUES.includes(event.repeat as NonNullable<CalendarEvent['repeat']>)
}

function mergeEventArchive(rows: CalendarEvent[], range?: { startDate: string, endDate: string }, repeatRows?: CalendarEvent[]) {
  const cached = readLocalQueryCache<CalendarEvent[]>(EVENT_ARCHIVE_CACHE_KEY) ?? []
  const activeRepeatIds = repeatRows ? new Set(repeatRows.map((event) => event.id)) : null
  const map = new Map<string, CalendarEvent>()
  cached
    .filter((event) => {
      if (range && eventOverlapsRange(event, range.startDate, range.endDate)) return false
      if (activeRepeatIds && isRepeatingCalendarEvent(event) && !activeRepeatIds.has(event.id)) return false
      return true
    })
    .forEach((event) => map.set(event.id, event))
  rows.forEach((event) => map.set(event.id, event))
  const merged = Array.from(map.values())
    .sort((a, b) => `${b.date} ${b.startTime}`.localeCompare(`${a.date} ${a.startTime}`))
    .slice(0, 2000)
  writeLocalQueryCache(EVENT_ARCHIVE_CACHE_KEY, merged)
  return merged
}

function cachedEventsInRange(startDate: string, endDate: string) {
  const cached = readLocalQueryCache<CalendarEvent[]>(EVENT_ARCHIVE_CACHE_KEY) ?? []
  return sortEvents(cached.filter((event) => eventOverlapsRange(event, startDate, endDate)))
}

function cachedArchiveMonths() {
  return new Set(readLocalQueryCache<string[]>(EVENT_ARCHIVE_MONTH_CACHE_KEY) ?? [])
}

function markArchiveMonthCached(monthKey: string) {
  const months = cachedArchiveMonths()
  months.add(monthKey)
  writeLocalQueryCache(EVENT_ARCHIVE_MONTH_CACHE_KEY, Array.from(months).slice(-36))
}

export function useCalendarGroups() {
  return useQuery({
    queryKey: ['calendarCalendars'],
    queryFn: async () => {
      const snap = await getDocs(collection(db, 'calendarCalendars'))
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as CalendarGroup[]
      const sorted = rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
      writeLocalQueryCache('calendarCalendars', sorted)
      return sorted
    },
    placeholderData: () => readLocalQueryCache<CalendarGroup[]>('calendarCalendars'),
    staleTime: 2 * 60 * 1000
  })
}

export function useCalendarEvents(activeMonth: string) {
  const queryClient = useQueryClient()
  const monthValue = dayjs(activeMonth || dayjs().format('YYYY-MM')).startOf('month')
  const startDate = monthValue.subtract(1, 'month').startOf('month').format('YYYY-MM-DD')
  const endDate = monthValue.add(1, 'month').endOf('month').format('YYYY-MM-DD')
  const queryKey = ['calendarEvents', startDate, endDate]

  const result = useQuery({
    queryKey,
    queryFn: async () => {
      const rangeSnap = await getDocs(query(
        collection(db, 'calendarEvents'),
        where('date', '>=', startDate),
        where('date', '<=', endDate)
      ))
      const repeatSnap = await getDocs(query(
        collection(db, 'calendarEvents'),
        where('repeat', 'in', REPEAT_VALUES)
      ))
      const map = new Map<string, CalendarEvent>()
      rangeSnap.docs.forEach((d) => map.set(d.id, { id: d.id, ...d.data() } as CalendarEvent))
      const repeatRows = repeatSnap.docs.map((d) => ({ id: d.id, ...d.data() })) as CalendarEvent[]
      repeatRows.forEach((event) => {
        if (event.date <= endDate) map.set(event.id, event)
      })
      const rows = Array.from(map.values())
      const sorted = sortEvents(rows)
      mergeEventArchive(sorted, { startDate, endDate }, repeatRows)
      return sorted
    },
    placeholderData: () => cachedEventsInRange(startDate, endDate),
    staleTime: 60 * 1000
  })

  useEffect(() => {
    let rangeRows: CalendarEvent[] | null = null
    let repeatRows: CalendarEvent[] | null = null

    const publishRows = () => {
      if (!rangeRows || !repeatRows) return
      const map = new Map<string, CalendarEvent>()
      rangeRows.forEach((event) => map.set(event.id, event))
      repeatRows.forEach((event) => {
        if (event.date <= endDate) map.set(event.id, event)
      })
      const sorted = sortEvents(Array.from(map.values()))
      mergeEventArchive(sorted, { startDate, endDate }, repeatRows)
      queryClient.setQueryData(queryKey, sorted)
    }

    const rangeQuery = query(
      collection(db, 'calendarEvents'),
      where('date', '>=', startDate),
      where('date', '<=', endDate)
    )
    const repeatQuery = query(
      collection(db, 'calendarEvents'),
      where('repeat', 'in', REPEAT_VALUES)
    )

    const unsubscribeRange = onSnapshot(rangeQuery, (snap) => {
      rangeRows = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as CalendarEvent[]
      publishRows()
    })
    const unsubscribeRepeat = onSnapshot(repeatQuery, (snap) => {
      repeatRows = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as CalendarEvent[]
      publishRows()
    })

    return () => {
      unsubscribeRange()
      unsubscribeRepeat()
    }
  }, [endDate, queryClient, startDate])

  useEffect(() => {
    if (!activeMonth) return
    let cancelled = false
    const timer = window.setTimeout(async () => {
      const months = [2, 3, 4].map((offset) => monthValue.subtract(offset, 'month').format('YYYY-MM'))
      for (const monthKey of months) {
        if (cancelled || cachedArchiveMonths().has(monthKey)) continue
        const monthStart = dayjs(monthKey).startOf('month').format('YYYY-MM-DD')
        const monthEnd = dayjs(monthKey).endOf('month').format('YYYY-MM-DD')
        try {
          const snap = await getDocs(query(
            collection(db, 'calendarEvents'),
            where('date', '>=', monthStart),
            where('date', '<=', monthEnd)
          ))
          mergeEventArchive(snap.docs.map((d) => ({ id: d.id, ...d.data() })) as CalendarEvent[], { startDate: monthStart, endDate: monthEnd })
          markArchiveMonthCached(monthKey)
        } catch {
          break
        }
      }
    }, 1800)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [activeMonth])

  return result
}

export function useCalendarSearchEvents(enabled: boolean) {
  return useQuery({
    queryKey: ['calendarEventsSearchIndex'],
    enabled,
    queryFn: async () => {
      const snap = await getDocs(collection(db, 'calendarEvents'))
      const rows = sortEvents(snap.docs.map((d) => ({ id: d.id, ...d.data() })) as CalendarEvent[])
      writeLocalQueryCache(EVENT_SEARCH_CACHE_KEY, rows)
      mergeEventArchive(rows)
      return rows
    },
    placeholderData: () => readLocalQueryCache<CalendarEvent[]>(EVENT_SEARCH_CACHE_KEY),
    staleTime: 5 * 60 * 1000
  })
}

export function useCalendarActivityLogs() {
  const [data, setData] = useState<CalendarActivityLog[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const q = query(collection(db, 'calendarActivityLogs'), orderBy('createdAt', 'desc'), limit(40))
    return onSnapshot(q, (snap) => {
      setData(snap.docs.map((d) => ({ id: d.id, ...d.data() })) as CalendarActivityLog[])
      setIsLoading(false)
    }, () => {
      setIsLoading(false)
    })
  }, [])

  return { data, isLoading }
}
