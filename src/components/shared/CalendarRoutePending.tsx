export default function CalendarRoutePending() {
  return (
    <div
      data-calendar-route-pending="true"
      role="status"
      aria-live="polite"
      aria-busy="true"
      style={{ minHeight: '100dvh', background: '#f8fafc' }}
    >
      <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}>
        行事曆載入中
      </span>
    </div>
  )
}
