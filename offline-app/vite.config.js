import { defineConfig } from 'vite'
import path from 'node:path'
import fs from 'node:fs'

const repoRoot = path.resolve(__dirname, '..')
const onlineSrc = path.resolve(repoRoot, 'src')
const shimDir = path.resolve(__dirname, 'src/shims')

const SHIM_MAP = {
  'supabase.js': 'supabase-shim.js',
  'live-sync.js': 'live-sync-stub.js',
  'app-update.js': 'app-update-stub.js',
  'sms.js': 'sms-stub.js',
  'sale-toasts.js': 'sale-toasts-stub.js',
  'browser-notifications.js': 'browser-notifications-stub.js',
  'config.js': 'config-shim.js',
  'backup-ui.js': 'backup-ui-shim.js',
  'dm-chat.js': 'dm-chat-stub.js'
}

function resolveOnlineShim(source, importer) {
  if (!importer) return null
  const normalized = importer.replace(/\\/g, '/')
  if (!normalized.includes('/src/')) return null
  const base = path.basename(source)
  const shimFile = SHIM_MAP[base]
  if (!shimFile) return null
  return path.resolve(shimDir, shimFile)
}

/** Serve shared static assets (fonts, icons) from the online app root in dev/build. */
function sharedStaticPlugin() {
  const sharedDirs = ['public/fonts', 'public/vendor']
  const sharedFiles = ['public/logo.webp', 'public/icon.webp']

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
          const urlPath = file.startsWith('public/') ? `/${file.slice('public/'.length)}` : `/${file}`
          if (url === urlPath || url === `/${path.basename(file)}`) {
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
        const destName = file.startsWith('public/') ? file.slice('public/'.length) : file
        const dest = path.join(outDir, path.basename(destName))
        if (fs.existsSync(src)) {
          fs.mkdirSync(path.dirname(dest), { recursive: true })
          fs.copyFileSync(src, dest)
        }
      }

      const buildIconPng = path.resolve(__dirname, 'build', 'icon.png')
      if (fs.existsSync(buildIconPng)) {
        fs.copyFileSync(buildIconPng, path.join(outDir, 'icon.png'))
      }
    }
  }
}

/** Absolute /public paths break under Electron file:// — use relative paths in packaged builds. */
function fixOfflineAssetPaths(html) {
  return html
    .replace(/href="\/icon\.webp"/g, 'href="./icon.webp"')
    .replace(/src="\/icon\.webp"/g, 'src="./icon.webp"')
    .replace(/href="\/logo\.webp"/g, 'href="./logo.webp"')
    .replace(/src="\/logo\.webp"/g, 'src="./logo.webp"')
    .replace(/href="\/fonts\//g, 'href="./fonts/')
    .replace(/href="\/vendor\//g, 'href="./vendor/')
}

function onlineAppHtmlPlugin() {
  let appHtml = ''
  return {
    name: 'offline-app-html',
    buildStart() {
      const onlineHtml = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8')
      appHtml = fixOfflineAssetPaths(
        onlineHtml
          .replace(
            '<script type="module" src="/src/main.js"></script>',
            '<script type="module" src="/src/app-main.js"></script>'
          )
          .replace(/<script src="\/vendor\/jalalidatepicker.min.js"><\/script>\s*/g, '')
          .replace(/<title>[^<]+<\/title>/, '<title>CARNO — نسخه آفلاین</title>')
      )
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (ctx.path && ctx.path.endsWith('app.html')) {
          return appHtml || html
        }
        return html
      }
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] === '/app.html') {
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(appHtml)
          return
        }
        next()
      })
    }
  }
}

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [
    {
      name: 'offline-online-shims',
      enforce: 'pre',
      resolveId(source, importer) {
        return resolveOnlineShim(source, importer)
      }
    },
    sharedStaticPlugin(),
    onlineAppHtmlPlugin()
  ],
  resolve: {
    alias: {
      '@backup': path.resolve(repoRoot, 'src/backup'),
      '@online-src': onlineSrc
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        login: path.resolve(__dirname, 'login.html'),
        app: path.resolve(__dirname, 'app.html')
      }
    }
  },
  server: {
    port: 5174,
    strictPort: true,
    fs: {
      allow: [repoRoot]
    }
  }
})
