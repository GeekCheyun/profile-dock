import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const outputDir = path.join(root, 'release')
const outputFile = path.join(outputDir, 'release-manifest.json')
const roots = ['dist', 'dist-server', 'electron', 'server/pick.ps1', 'native/build', 'package.json', 'package-lock.json']
const files = []
function collect(relative) {
  const absolute = path.join(root, relative)
  if (!fs.existsSync(absolute)) return
  const stat = fs.statSync(absolute)
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(absolute)) collect(path.join(relative, entry))
    return
  }
  const data = fs.readFileSync(absolute)
  files.push({ path: relative.replaceAll(path.sep, '/'), size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') })
}
for (const relative of roots) collect(relative)
files.sort((a, b) => a.path.localeCompare(b.path))
fs.mkdirSync(outputDir, { recursive: true })
fs.writeFileSync(outputFile, JSON.stringify({
  schemaVersion: 1,
  product: pkg.name,
  version: pkg.version,
  generatedAt: new Date().toISOString(),
  signed: Boolean(process.env.CSC_LINK),
  installer: 'not-generated-by-this-manifest',
  files,
}, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ ok: true, file: path.relative(root, outputFile), count: files.length, signed: Boolean(process.env.CSC_LINK) }, null, 2))
