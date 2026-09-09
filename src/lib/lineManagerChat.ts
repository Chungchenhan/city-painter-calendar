export type SalesManagerChat = {
  name: string
  url: string
}

export function normalizeSalesManagerChats(value: unknown): SalesManagerChat[] {
  return (Array.isArray(value) ? value : []).flatMap((chat) => {
    if (!chat || typeof chat !== 'object') return []
    const source = chat as Record<string, unknown>
    const name = typeof source.name === 'string' ? source.name.trim().slice(0, 200) : ''
    const url = typeof source.url === 'string' ? source.url.trim() : ''
    if (!name || !/^https:\/\/chat\.line\.biz\/U[0-9a-f]{32}\/chat\/[UCR][0-9a-f]{32}$/iu.test(url)) return []
    return [{ name, url }]
  }).slice(0, 20)
}
