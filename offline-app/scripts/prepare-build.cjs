/**
 * Prepare build assets (icon PNG for electron-builder).
 * Run before packaging: node scripts/prepare-build.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const sharp = require('sharp')

const repoRoot = path.resolve(__dirname, '..', '..')
const LOGO_URL = 'https://cm.sepehralimohammadi.com/logo.webp'
const srcLogo = path.join(repoRoot, 'public', 'logo.webp')
const buildDir = path.join(__dirname, '..', 'build')
const destPng = path.join(buildDir, 'icon.png')

async function ensureLogoFile() {
  if (fs.existsSync(srcLogo)) return srcLogo
  console.log('prepare-build: downloading logo from', LOGO_URL)
  const res = await fetch(LOGO_URL)
  if (!res.ok) throw new Error(`Failed to download logo: ${res.status} ${res.statusText}`)
  const buf = Buffer.from(await res.arrayBuffer())
  fs.mkdirSync(path.dirname(srcLogo), { recursive: true })
  fs.writeFileSync(srcLogo, buf)
  return srcLogo
}

async function main() {
  const logoPath = await ensureLogoFile()

  fs.mkdirSync(buildDir, { recursive: true })
  await sharp(logoPath)
    .resize(512, 512, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .png()
    .toFile(destPng)

  console.log('prepare-build: wrote', destPng, 'from', logoPath)
}

main().catch(err => {
  console.error('prepare-build failed:', err)
  process.exit(1)
})
