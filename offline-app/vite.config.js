import { defineConfig } from 'vite'
import path from 'node:path'
import fs from 'node:fs'

const repoRoot = path.resolve(__dirname, '..')

/** Serve shared static assets (fonts, icons) from the online app root in dev/build. */
function sharedStaticPlugin() {
  const sharedDirs = ['public/fonts', 'public/vendor']
  const sharedFiles = ['icon.webp']

  return {
    name: 'offline-shared-static',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] || ''
        for (const dir of sharedDirs) {
          const publicPrefix = dir.startsWith('public/') ? dir.slice('public/'.length) : dir
          if (url.startsWith(`/${publicPrefix}/`)) {
            const filePath = path.join(repoRoot, dir, url.slice(`/${publicPrefix}/`.length))
            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
              res.setHeader('Cache-Control', 'no-store')
              fs.createReadStream(filePath).pipe(res)
              return
            }
          }
        }
        for (const file of sharedFiles) {
          if (url === `/${file}`) {
            const filePath = path.join(repoRoot, file)
            if (fs.existsSync(filePath)) {
              fs.createReadStream(filePath).pipe(res)
              return
            }
          }
        }
        next()
      })
    },
    closeBundle() {
      const outDir = path.resolve(__dirname, 'dist')
      for (const dir of sharedDirs) {
        const src = path.join(repoRoot, dir)
        const publicPrefix = dir.startsWith('public/') ? dir.slice('public/'.length) : dir
        const dest = path.join(outDir, publicPrefix)
        if (fs.existsSync(src)) {
          fs.cpSync(src, dest, { recursive: true })
        }
      }
      for (const file of sharedFiles) {
        const src = path.join(repoRoot, file)
        const dest = path.join(outDir, file)
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dest)
        }
      }
    }
  }
}

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [sharedStaticPlugin()],
  resolve: {
    alias: {
      '@backup': path.resolve(repoRoot, 'src/backup'),
      '@online-src': path.resolve(repoRoot, 'src')
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'index.html')
    }
  },
  server: {
    port: 5174,
    strictPort: true
  }
})
