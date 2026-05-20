import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

function loadLocalServerEnv() {
  const envPath = path.resolve(process.cwd(), '.env.vercel.local')
  if (!fs.existsSync(envPath)) return

  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!match || process.env[match[1]]) continue
    const value = match[2].trim().replace(/^['"]|['"]$/g, '')
    process.env[match[1]] = value
  }
}

function localApiPlugin(): Plugin {
  return {
    name: 'local-api',
    configureServer(server) {
      loadLocalServerEnv()
      server.middlewares.use('/api/upload-drive', async (req, res) => {
        const apiRes = res as typeof res & {
          status: (code: number) => typeof apiRes
          json: (body: unknown) => void
        }
        apiRes.status = (code: number) => {
          apiRes.statusCode = code
          return apiRes
        }
        apiRes.json = (body: unknown) => {
          if (!apiRes.getHeader('Content-Type')) {
            apiRes.setHeader('Content-Type', 'application/json; charset=utf-8')
          }
          apiRes.end(JSON.stringify(body))
        }

        try {
          const { default: handler } = await import('./api/upload-drive.js')
          await handler(req, apiRes)
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Local API failed'
          server.config.logger.error(message)
          apiRes.status(500).json({ error: message })
        }
      })
    }
  }
}

export default defineConfig({
  plugins: [
    react(),
    localApiPlugin(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'icons.svg'],
      manifest: {
        name: '行事曆',
        short_name: '行事曆',
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
        navigateFallbackDenylist: [/^\/__\/auth\//, /^\/api\//],
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
            urlPattern: ({ request, url }) => request.mode === 'navigate' && !url.pathname.startsWith('/__/auth/') && !url.pathname.startsWith('/api/'),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'pages',
              expiration: { maxEntries: 20, maxAgeSeconds: 24 * 60 * 60 }
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
