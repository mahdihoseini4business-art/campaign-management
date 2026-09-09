import { defineConfig } from 'vite'
import fs from 'node:fs'
import path from 'node:path'

function versionPlugin() {
  const buildId = String(Date.now())

  return {
    name: 'emit-version-json',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/version.json')) {
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Cache-Control', 'no-store')
          res.end(JSON.stringify({ version: 'dev' }))
          return
        }
        next()
      })
    },
    closeBundle() {
      const outDir = path.resolve(process.cwd(), 'dist')
      fs.mkdirSync(outDir, { recursive: true })
      fs.writeFileSync(
        path.join(outDir, 'version.json'),
        JSON.stringify({ version: buildId }, null, 0),
        'utf8'
      )
    }
  }
}

/** Map clean URLs in Vite dev/preview. */
function platformPathPlugin() {
  const rewrite = (req) => {
    const raw = req.url || ''
    const pathOnly = raw.split('?')[0]
    const qs = raw.includes('?') ? raw.slice(raw.indexOf('?')) : ''
    if (pathOnly === '/login' || pathOnly === '/login/') {
      req.url = `/login.html${qs}`
    } else if (pathOnly === '/platform' || pathOnly === '/platform/') {
      req.url = `/platform.html${qs}`
    } else if (pathOnly === '/signup' || pathOnly === '/signup/') {
      req.url = `/signup.html${qs}`
    }
  }

  return {
    name: 'platform-path-rewrite',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        rewrite(req)
        next()
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => {
        rewrite(req)
        next()
      })
    }
  }
}

export default defineConfig({
  // Multi-page app: missing /assets/* must not fall back to index.html
  // (SPA fallback returns text/html and breaks module scripts).
  appType: 'mpa',
  plugins: [versionPlugin(), platformPathPlugin()],
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        login: 'login.html',
        platform: 'platform.html',
        signup: 'signup.html',
        paymentResult: 'payment-result.html'
      }
    }
  }
})
