import { defineConfig } from 'vite'
import fs from 'node:fs'
import path from 'node:path'

function versionPlugin() {
  const buildId =
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.CF_PAGES_COMMIT_SHA ||
    String(Date.now())

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

export default defineConfig({
  plugins: [versionPlugin()],
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        login: 'login.html'
      }
    }
  }
})
