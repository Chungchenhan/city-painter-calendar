import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'icons.svg'],
      manifest: {
        name: '都市彩繪行事曆',
        short_name: '彩繪行事曆',
        description: '都市彩繪有限公司部門工作行事曆',
        theme_color: '#f6b100',
        background_color: '#fff8e6',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        lang: 'zh-TW',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/(firestore|identitytoolkit|securetoken)\.googleapis\.com\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'firebase-api',
              expiration: { maxEntries: 60, maxAgeSeconds: 5 * 60 },
              networkTimeoutSeconds: 5
            }
          },
          {
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'pages',
              expiration: { maxEntries: 20, maxAgeSeconds: 24 * 60 * 60 },
              networkTimeoutSeconds: 3
            }
          }
        ]
      }
    })
  ],
  server: {
    hmr: { overlay: false }
  }
})
