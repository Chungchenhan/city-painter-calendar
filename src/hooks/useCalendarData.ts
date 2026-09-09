import { useEffect } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import dayjs from 'dayjs'
import { useAuth } from '../contexts/AuthContext'
import { fetchCalendarData } from '../lib/calendarDataApi'
import { readLocalQueryCache, writeLocalQueryCache } from '../lib/localQueryCache'
import type { CalendarActivityLog, CalendarEvent, CalendarGroup } from '../types'

const EVENT_ARCHIVE_CACHE_KEY = 'calendarEventsArchive'
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

export function useCalendarGroups() {
  const { user } = useAuth()
  return useQuery({
    queryKey: ['calendarCalendars', user?.uid],
    enabled: Boolean(user),
    queryFn: async () => {
      const rows = await fetchCalendarData<CalendarGroup>('groups')
      const sorted = rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
      writeLocalQueryCache('calendarCalendars', sorted)
      return sorted
    },
    placeholderData: () => readLocalQueryCache<CalendarGroup[]>('calendarCalendars') ?? [],
    staleTime: 2 * 60 * 1000,
  })
}

export function useCalendarEvents(activeMonth: string) {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!user) return
    let previous: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = onSnapshot(doc(db, 'calendarDataRevisions', 'global'), snapshot => {
      const version = Number(snapshot.data()?.version || 0)
      if (previous === undefined) { previous = version; return }
      if (previous === version) return
      previous = version
      clearTimeout(timer)
      timer = setTimeout(() => {
        for (const key of ['calendarEvents', 'calendarEventsSearchIndex', 'calendarActivityLogs', 'calendarCalendars']) {
          void queryClient.invalidateQueries({ queryKey: [key] }, { cancelRefetch: false })
        }
        window.dispatchEvent(new Event('calendar-data-revision'))
      }, 300)
    }, () => { /* 版本提示失敗時由 focus 與有界輪詢補查。 */ })
    return () => { unsubscribe(); clearTimeout(timer) }
  }, [user?.uid, queryClient])
  const monthValue = dayjs(activeMonth || dayjs().format('YYYY-MM')).startOf('month')
  const startDate = monthValue.subtract(2, 'month').startOf('month').format('YYYY-MM-DD')
  const endDate = monthValue.add(2, 'month').endOf('month').format('YYYY-MM-DD')
  return useQuery<CalendarEvent[]>({
    queryKey: ['calendarEvents', user?.uid, startDate, endDate],
    enabled: Boolean(user),
    queryFn: async ({ signal }) => {
      const [rangeRows, repeatRows] = await Promise.all([
        fetchCalendarData<CalendarEvent>('events', { start: startDate, end: endDate }, Infinity, signal),
        fetchCalendarData<CalendarEvent>('repeat', {}, Infinity, signal),
      ])
      const map = new Map(rangeRows.map(event => [event.id, event]))
      repeatRows.filter(event => event.date <= endDate).forEach(event => map.set(event.id, event))
      const sorted = sortEvents(Array.from(map.values()))
      mergeEventArchive(sorted, { startDate, endDate }, repeatRows)
      return sorted
    },
    placeholderData: () => cachedEventsInRange(startDate, endDate),
    refetchOnWindowFocus: 'always',
    refetchInterval: 60000,
    staleTime: 10000,
  })
}

export function useCalendarSearchEvents(enabled: boolean) {
  const { user } = useAuth()
  return useQuery({
    queryKey: ['calendarEventsSearchIndex', user?.uid],
    enabled: enabled && Boolean(user),
    queryFn: async ({ signal }) => {
      const rows = sortEvents(await fetchCalendarData<CalendarEvent>('events', {}, Infinity, signal))
      writeLocalQueryCache(EVENT_SEARCH_CACHE_KEY, rows)
      mergeEventArchive(rows)
      return rows
    },
    staleTime: 5 * 60 * 1000,
  })
}

export function useCalendarActivityLogs(enabled = true) {
  const { user } = useAuth()
  return useQuery({
    queryKey: ['calendarActivityLogs', user?.uid],
    enabled: enabled && Boolean(user),
    queryFn: () => fetchCalendarData<CalendarActivityLog>('activity', {}, 40),
    refetchInterval: 60000,
    staleTime: 10000,
    placeholderData: [],
  })
}
