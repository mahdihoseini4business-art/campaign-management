/**
 * Prepare build assets (icon PNG for electron-builder).
 * Run before packaging: node scripts/prepare-build.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const sharp = require('sharp')

const repoRoot = path.resolve(__dirname, '..', '..')
const srcIcon = path.join(repoRoot, 'public', 'icon.webp')
const buildDir = path.join(__dirname, '..', 'build')
const destPng = path.join(buildDir, 'icon.png')

async function main() {
  if (!fs.existsSync(srcIcon)) {
    console.warn('prepare-build: icon.webp not found at', srcIcon)
    process.exit(0)
  }

  fs.mkdirSync(buildDir, { recursive: true })
  await sharp(srcIcon)
    .resize(256, 256, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .png()
    .toFile(destPng)

  console.log('prepare-build: wrote', destPng)
}

main().catch(err => {
  console.error('prepare-build failed:', err)
  process.exit(1)
})
