/**
 * Prepare build assets (icon PNG for electron-builder).
 * Run before packaging: node scripts/prepare-build.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const sharp = require('sharp')
const toIco = require('to-ico')

const repoRoot = path.resolve(__dirname, '..', '..')
const LOGO_URL = 'https://cm.sepehralimohammadi.com/logo.webp'
const srcLogo = path.join(repoRoot, 'public', 'logo.webp')
const buildDir = path.join(__dirname, '..', 'build')
const destPng = path.join(buildDir, 'icon.png')
const destIco = path.join(buildDir, 'icon.ico')
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

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

  const transparentBg = { r: 255, g: 255, b: 255, alpha: 0 }
  const resizeLogo = size =>
    sharp(logoPath).resize(size, size, { fit: 'contain', background: transparentBg }).png()

  await resizeLogo(512).toFile(destPng)

  const icoPngBuffers = await Promise.all(ICO_SIZES.map(size => resizeLogo(size).toBuffer()))
  fs.writeFileSync(destIco, await toIco(icoPngBuffers))

  console.log('prepare-build: wrote', destPng, 'and', destIco, 'from', logoPath)
}

main().catch(err => {
  console.error('prepare-build failed:', err)
  process.exit(1)
})
