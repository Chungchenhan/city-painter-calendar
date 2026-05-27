self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {}
  const title = data.title || '都市彩繪行事曆'
  const unreadCount = Number(data.unreadCount || 1)

  event.waitUntil((async () => {
    if (self.registration.setAppBadge) {
      try {
        await self.registration.setAppBadge(unreadCount)
      } catch (error) {
        console.warn('[calendar-push] setAppBadge failed', error)
      }
    }

    await self.registration.showNotification(title, {
      body: data.body || '您有新的行事曆通知',
      tag: data.tag || 'city-painter-calendar',
      badge: '/pwa-192x192.png',
      icon: '/pwa-192x192.png',
      data: {
        url: data.url || '/',
        eventId: data.eventId || '',
      },
    })
  })())
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = new URL(event.notification.data?.url || '/', self.location.origin).href

  event.waitUntil((async () => {
    const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const existingClient = windowClients.find(client => client.url.startsWith(self.location.origin))

    if (existingClient) {
      await existingClient.focus()
      existingClient.postMessage({ type: 'OPEN_URL', url: targetUrl })
      return
    }

    await self.clients.openWindow(targetUrl)
  })())
})
