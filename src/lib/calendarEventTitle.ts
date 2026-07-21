export function composeEditableEventTitle(icon: string, title: string) {
  const normalizedIcon = icon.trim()
  if (!normalizedIcon) return title
  return `${normalizedIcon}${title ? ` ${title}` : ''}`
}
