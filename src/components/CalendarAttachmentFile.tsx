import type { AnchorHTMLAttributes } from 'react'
import { calendarDriveFileId, useCalendarAttachmentAccess } from '../lib/calendarAttachmentAccess'

export default function CalendarAttachmentFile({ eventId, href = '', children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { eventId: string }) {
  const fileId = calendarDriveFileId(href)
  const { links, error } = useCalendarAttachmentAccess(eventId, fileId)
  return <a {...props} href={fileId ? links?.downloadUrl : href} aria-disabled={Boolean(fileId && !links)} title={error || props.title}>
    {children}{fileId && !links && <small>{error || '附件授權中'}</small>}
  </a>
}
