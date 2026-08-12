import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const findings = []
const warnings = []
const files = []
// 只扫描运行时代码；门禁脚本自身包含用于检测危险模式的字面量，扫描它会造成自匹配误报。
for (const dir of ['server', 'electron', 'src']) {
  const walk = (current) => {
    for (const entry of fs.readdirSync(path.join(root, current), { withFileTypes: true })) {
      const relative = path.join(current, entry.name)
      if (entry.isDirectory()) walk(relative)
      else if (/\.(ts|tsx|mjs|js|ps1)$/.test(entry.name)) files.push(relative)
    }
  }
  if (fs.existsSync(path.join(root, dir))) walk(dir)
}
const source = files.map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n')
if (/NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]0['"]/.test(source)) findings.push('检测到不安全 TLS 降级')
if (source.includes('<-loopback>')) findings.push('检测到会取消 loopback 直连的参数')
if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(source)) findings.push('源文件包含私钥材料')
if (/(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9+/=_-]{24,}['"]/i.test(source)) findings.push('源文件疑似包含硬编码凭据')
if (pkg.build?.win?.requestedExecutionLevel !== 'asInvoker') findings.push('Windows 执行级别不是 asInvoker')
if (!fs.existsSync(path.join(root, 'package-lock.json'))) findings.push('缺少 package-lock.json')
if (pkg.license === 'UNLICENSED') warnings.push('package license 仍为 UNLICENSED，正式商业授权条款需要产品/法务决策')
if (!process.env.CSC_LINK) warnings.push('未配置 CSC_LINK，无法证明代码签名')
const result = { ok: findings.length === 0, filesScanned: files.length, findings, warnings }
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exit(2)
