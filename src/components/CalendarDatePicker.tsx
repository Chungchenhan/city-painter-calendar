import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import dayjs from 'dayjs'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

type CalendarDatePickerProps = {
  value: string
  min?: string
  disabled?: boolean
  ariaLabel: string
  title?: string
  className?: string
  onChange: (value: string) => void
}

function validDate(value: string) {
  const parsed = dayjs(value)
  return parsed.isValid() ? parsed : dayjs()
}

export default function CalendarDatePicker({
  value,
  min,
  disabled = false,
  ariaLabel,
  title,
  className = '',
  onChange,
}: CalendarDatePickerProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value)
  const [visibleMonth, setVisibleMonth] = useState(() => validDate(value).startOf('month'))
  const dialogRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const today = dayjs().format('YYYY-MM-DD')
  const todayDisabled = Boolean(min && today < min)

  const closePicker = useCallback(() => {
    setOpen(false)
    window.requestAnimationFrame(() => triggerRef.current?.focus())
  }, [])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closePicker()
    }
    window.addEventListener('keydown', handleKeyDown)
    const focusTimer = window.setTimeout(() => dialogRef.current?.focus(), 0)
    return () => {
      window.clearTimeout(focusTimer)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [closePicker, open])

  const days = useMemo(() => {
    const firstGridDay = visibleMonth.startOf('month').startOf('week')
    return Array.from({ length: 42 }, (_, index) => firstGridDay.add(index, 'day'))
  }, [visibleMonth])

  function chooseToday() {
    if (todayDisabled) return
    setDraft(today)
    setVisibleMonth(dayjs().startOf('month'))
  }

  function openPicker() {
    setDraft(value)
    setVisibleMonth(validDate(value).startOf('month'))
    setOpen(true)
  }

  function confirmSelection() {
    if (!draft || (min && draft < min)) return
    onChange(draft)
    closePicker()
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`calendar-date-trigger${className ? ` ${className}` : ''}`}
        onClick={openPicker}
        disabled={disabled}
        aria-label={ariaLabel}
        title={title}
      >
        {validDate(value).format('YYYY/MM/DD')}
      </button>
      {open && createPortal(
        <div className="calendar-date-picker-overlay" onClick={closePicker}>
          <div
            ref={dialogRef}
            className="calendar-date-picker"
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="calendar-date-picker-header">
              <strong>{visibleMonth.format('YYYY 年 M 月')}</strong>
              <div>
                <button type="button" onClick={() => setVisibleMonth((month) => month.subtract(1, 'month'))} aria-label="上一個月">‹</button>
                <button type="button" onClick={() => setVisibleMonth((month) => month.add(1, 'month'))} aria-label="下一個月">›</button>
              </div>
            </div>
            <div className="calendar-date-picker-weekdays" aria-hidden="true">
              {WEEKDAYS.map((weekday) => <span key={weekday}>週{weekday}</span>)}
            </div>
            <div className="calendar-date-picker-days">
              {days.map((date) => {
                const dateValue = date.format('YYYY-MM-DD')
                const isToday = dateValue === today
                const isSelected = dateValue === draft
                const isOutsideMonth = date.month() !== visibleMonth.month()
                const isDisabled = Boolean(min && dateValue < min)
                return (
                  <button
                    type="button"
                    className={`${isToday ? 'today ' : ''}${isSelected ? 'selected ' : ''}${isOutsideMonth ? 'outside-month' : ''}`.trim()}
                    disabled={isDisabled}
                    aria-label={`${date.format('YYYY 年 M 月 D 日')}${isToday ? '，今天' : ''}`}
                    aria-current={isToday ? 'date' : undefined}
                    aria-pressed={isSelected}
                    onClick={() => setDraft(dateValue)}
                    key={dateValue}
                  >
                    {date.date()}
                  </button>
                )
              })}
            </div>
            <div className="calendar-date-picker-footer">
              <button type="button" className="today-button" disabled={todayDisabled} onClick={chooseToday}>今天</button>
              <button type="button" className="confirm-button" onClick={confirmSelection} aria-label="確認日期">✓</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
