import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const lockFile = path.join(root, 'package-lock.json')
const outputDir = path.join(root, 'release')
const outputFile = path.join(outputDir, 'sbom.cdx.json')
const noticesFile = path.join(outputDir, 'THIRD-PARTY-NOTICES.json')

if (!fs.existsSync(lockFile)) throw new Error('缺少 package-lock.json，不能生成 SBOM')
const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
const components = []
const notices = []
for (const [location, entry] of Object.entries(lock.packages || {})) {
  if (!location.startsWith('node_modules/') || !entry?.version) continue
  const name = location.slice('node_modules/'.length)
  const component = {
    type: 'library',
    name,
    version: String(entry.version),
    purl: `pkg:npm/${name.replace(/^@/, '').replace('/', '%2F')}@${entry.version}`,
  }
  components.push(component)
  notices.push({
    name,
    version: String(entry.version),
    license: entry.license || 'UNKNOWN_REVIEW_REQUIRED',
    source: 'package-lock.json',
  })
}
components.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))
notices.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))
fs.mkdirSync(outputDir, { recursive: true })
fs.writeFileSync(outputFile, JSON.stringify({
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${crypto.randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [{ vendor: 'MultiOpen Workbench', name: 'generate-sbom.mjs', version: '1.0.0' }],
  },
  components,
}, null, 2) + '\n', 'utf8')
fs.writeFileSync(noticesFile, JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: 'package-lock.json',
  reviewRequired: notices.filter((entry) => entry.license === 'UNKNOWN_REVIEW_REQUIRED').length,
  packages: notices,
}, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ ok: true, sbom: path.relative(root, outputFile), notices: path.relative(root, noticesFile), components: components.length, unknownLicenses: notices.filter((entry) => entry.license === 'UNKNOWN_REVIEW_REQUIRED').length }, null, 2))
