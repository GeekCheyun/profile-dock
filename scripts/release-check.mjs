import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const pkg = JSON.parse(read('package.json'))
const required = ['dist/index.html', 'dist-server/index.js', 'README.md', 'docs/RELEASE-RUNBOOK.md', '.taskmaster/tasks/tasks.json']
const missing = required.filter((file) => !fs.existsSync(path.join(root, file)))
const sourceFiles = []
for (const dir of ['server', 'electron', 'src']) {
  const walk = (current) => {
    for (const entry of fs.readdirSync(path.join(root, current), { withFileTypes: true })) {
      const rel = path.join(current, entry.name)
      if (entry.isDirectory()) walk(rel)
      else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) sourceFiles.push(rel)
    }
  }
  walk(dir)
}
const source = sourceFiles.map(read).join('\n')
const findings = []
if (/NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]0['"]/.test(source)) findings.push('unsafe TLS downgrade')
if (source.includes('<-loopback>')) findings.push('subtractive loopback bypass')
if (pkg.build?.win?.requestedExecutionLevel !== 'asInvoker') findings.push('installer execution level is not asInvoker')
if (missing.length) findings.push(`missing artifacts: ${missing.join(', ')}`)
const result = {
  ok: findings.length === 0,
  version: pkg.version,
  electron: pkg.devDependencies?.electron || '',
  artifacts: required.filter((file) => !missing.includes(file)),
  signingConfigured: Boolean(process.env.CSC_LINK),
  findings,
}
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exit(2)
