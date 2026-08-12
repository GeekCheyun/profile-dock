import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const electronDist = path.join(root, 'node_modules', 'electron', 'dist')
const candidate = path.join(root, 'release', 'portable-candidate')
const appRoot = path.join(candidate, 'resources', 'app')
if (!fs.existsSync(electronDist)) throw new Error('缺少 Electron runtime；请先 npm install')
for (const required of ['dist', 'dist-server', 'electron', 'server/pick.ps1', 'native/build', 'package.json']) {
  if (!fs.existsSync(path.join(root, required))) throw new Error(`缺少构建输入：${required}`)
}
fs.rmSync(candidate, { recursive: true, force: true })
fs.mkdirSync(path.dirname(candidate), { recursive: true })
function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true })
  if (process.platform === 'win32') {
    const copy = spawnSync('robocopy.exe', [source, destination, '/E', '/COPY:DAT', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS'], { stdio: 'inherit', windowsHide: true })
    if (copy.error || copy.status === null || copy.status > 7) {
      throw new Error(`robocopy 复制目录失败：${copy.error?.message || copy.status}`)
    }
    return
  }
  fs.cpSync(source, destination, { recursive: true })
}
copyDirectory(electronDist, candidate)
fs.mkdirSync(appRoot, { recursive: true })
for (const relative of ['dist', 'dist-server', 'electron', 'native/build', 'package.json']) {
  const source = path.join(root, relative)
  const destination = path.join(appRoot, relative)
  if (fs.statSync(source).isDirectory()) copyDirectory(source, destination)
  else fs.copyFileSync(source, destination)
}
fs.mkdirSync(path.join(appRoot, 'server'), { recursive: true })
fs.copyFileSync(path.join(root, 'server', 'pick.ps1'), path.join(appRoot, 'server', 'pick.ps1'))
fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(appRoot, 'package-lock.json'))
fs.copyFileSync(path.join(root, 'README.md'), path.join(candidate, 'README.md'))
fs.writeFileSync(path.join(candidate, '启动多开工具.bat'), '@echo off\ncd /d "%~dp0"\nstart "" "%~dp0应用多开工具.exe"\n', 'utf8')
fs.renameSync(path.join(candidate, 'electron.exe'), path.join(candidate, '应用多开工具.exe'))
fs.writeFileSync(path.join(candidate, 'PORTABLE-CANDIDATE.txt'), [
  '这是未签名便携候选包，不是正式商业安装器。',
  '它包含本地 Electron runtime 和编译产物，不包含用户 data/实例目录。',
  '正式发布前仍需代码签名、干净机器安装验收和更新服务。',
].join('\n') + '\n', 'utf8')
console.log(JSON.stringify({ ok: true, output: path.relative(root, candidate), signed: false, note: '便携候选包不等于正式签名安装器' }, null, 2))
