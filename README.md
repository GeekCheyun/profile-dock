# 应用多开工具

Windows 桌面多开工作台。当前稳定路径为：每个实例使用独立、持久化的 Chromium/Electron Profile，并为原生应用 OAuth 提供可审计的实例浏览器代理。

## 支持边界

| 能力 | 当前保证 |
| --- | --- |
| 多实例并存 | 每实例独立 `--user-data-dir`、工作目录和浏览器 Profile |
| 登录态 | 每个实例的数据目录持久保存，不在正常重启时清空 |
| 授权回调 | 只接受 HTTPS 授权入口与 HTTP loopback 回调；验证回调监听进程属于目标实例后才打开浏览器 |
| 代理 | 授权回调始终绕过代理；不自动抓取免费代理 |
| 物理设备身份 | 不承诺。一个 Windows 进程/Profile 不等于一台物理设备，不伪造 Trae 服务端设备身份 |
| 签到成功 | 只在取得 Trae 服务端真实成功响应后才能认定；本地弹窗或“设备已签到”不是成功回执 |

原生设备/文件系统全局 Hook 和设备指纹轮换不属于默认路径。实例启动会为每个 WorkBuddy 子进程设置独立的 `APPDATA/LOCALAPPDATA/USERPROFILE/HOME`，这是隔离账号、会话和运行时数据所必需的；不会改写宿主进程的环境。诊断人员如需复现旧版兼容行为，必须显式设置 `MULTIOPEN_ENABLE_NATIVE_HOOKS=1` 或 `MULTIOPEN_ENABLE_LEGACY_FINGERPRINT=1`，且该模式不属于商用稳定路径。

## 使用

1. 双击 `启动.vbs` 或运行 `npm run electron`。
2. 在“多开管理”中选择 TraeWork 档案，输入要新增的实例数并启动。
3. 每个实例长期使用自己的目录：`engine/instances/<profile-id>/<index>/config`。
4. 关闭实例只终止该 Profile 的进程树；不会自动删除实例历史和登录数据。

删除实例会同时终止该实例的浏览器进程（包括通过系统默认浏览器打开的 Edge，
其配置位于实例内 `appdata\Local\Microsoft\Edge\User Data`），确保配置目录
可被完整删除；重新创建的同序号实例不会再加入旧浏览器会话，因此不会有
“删除后残留登录信息”的问题。

WorkBuddy 自启的 Edge 浏览器主进程命令行不带 `--user-data-dir`，工具通过读取
进程环境变量（`LOCALAPPDATA` 指向实例目录 + `EDGE_BROWSER_PID` 反查）识别并
终止这些进程，关闭/删除实例时不会因浏览器占用而失败。

输入法：微信输入法(WeType)/搜狗/百度等第三方输入法的用户数据（`%APPDATA%\Tencent\WeType`
等）会以 Junction 桥接进实例，保证实例内可以正常使用和切换中文输入法。
授权流程和“实例浏览器”按钮通过显式 Browser Broker 打开实例专属 `browser-profile-v2`；
稳定路径不把系统默认浏览器的外链自动重定向伪装成已验证的隔离能力。

浏览器探测同时支持 Chrome/Edge 的当前用户安装目录（例如
`%LOCALAPPDATA%\\Google\\Chrome\\Application`）和系统安装目录；浏览器进程启动失败会被
安全捕获并返回失败，不会再以未处理异常崩溃 Electron 主进程。

桌面程序默认以当前用户权限运行（`asInvoker`），以保证 Windows 输入法、剪贴板和文本服务可以正常连接实例。删除目录遇到权限问题时会返回明确错误；需要 Sandboxie 时请单独启动其服务，不会通过提升整个多开工具权限来运行。

> **重要：不要以管理员身份运行本工具。** 高完整性进程无法连接 Windows 输入法(TSF)，
> 实例内会无法使用中文输入法、无法切换中英文；同时 WorkBuddy 的认证/网络服务
> 会明显变慢（专家市场等依赖登录的功能可能加载失败）。`启动.vbs` 与 `多开工具.bat`
> 均已按普通权限启动，桌面快捷方式不要勾选“以管理员身份运行”。即使误以管理员
> 启动，工具也会自动以普通权限重启一次，保证实例输入法可用。

如果曾用旧版（提权）工具启动过实例，删除实例后可能残留 `*.deleting-*` 目录——
旧实例日志目录带有当前用户的“拒绝删除”Deny ACE，直接删除会被拒绝。脚本会先用
`icacls /remove:d` 解除该 ACE 再删除，**普通权限即可，无需管理员/UAC**。
直接双击 `scripts\清理残留实例数据.bat` 即可清理；若残留目录属主已被旧版提权
工具改为 Administrators，脚本会自动请求一次 UAC 提权重试。工具每次启动时也会
自动做同样的快速清理（仅处理 `*.deleting-*`，不动活动实例和 `shared/` 共享的
真实文件夹）。

## Trae 授权

1. 在目标 Trae 实例中点击登录，取得该次新生成的授权链接。PKCE 链接与本机临时回调端口是一一对应的，旧链接不要重放。
2. 在多开工具对应实例点击“授权链路”，粘贴新链接。
3. 先点“仅检查”。工具会确认：目标实例正在运行、回调端口正在监听、监听者属于目标实例、系统存在可用 Edge/Chrome。
4. 检查通过后点“检查并打开”。浏览器使用该实例专属 `browser-profile-v2`，并原样传递当前授权 URL。
5. 工具只保存脱敏回执：主机、路径、查询参数名称、回调端口、进程归属和启动结果；不保存授权码、PKCE challenge、Cookie 或 Token。

如果提示“回调端口尚未监听”，链接已经失效或不是当前登录动作产生的；回到 Trae 重新点登录，不要反复打开旧链接。

## 为什么这样设计

Chromium/Electron 的稳定隔离单元是独立 user data directory。Playwright 的持久上下文同样要求每个实例使用独立 `userDataDir`，且不允许多个实例同时共享同一目录。OAuth 原生应用使用 loopback redirect；Chromium 默认直连 loopback，而 `<-loopback>` 会取消该隐式绕过，因此项目禁止生成这个参数。

参考：

- Chromium user data directory: https://chromium.googlesource.com/chromium/src/+/main/docs/user_data_dir.md
- Chromium proxy bypass: https://chromium.googlesource.com/chromium/src/+/main/net/docs/proxy.md
- OAuth 2.0 for Native Apps: https://datatracker.ietf.org/doc/html/rfc8252
- Playwright persistent context: https://playwright.dev/docs/api/class-browsertype

## 架构

- `electron/`：桌面主进程与安全 IPC；API Token 只通过 preload 桥接给渲染器。
- `server/engine.ts`：实例目录、进程启动、状态与清理。
- `server/auth-routing.ts`：授权 URL 校验、回调归属检查、浏览器启动和脱敏回执。
- `server/index.ts`：仅监听 `127.0.0.1` 的控制 API、Origin 与 Bearer Token 校验。
- `src/components/Workbench.tsx`：多开和授权链路 UI。
- `tests/`：解析、持久化、API 安全和真实 Chromium loopback 集成测试。
- `scripts/electron-smoke.mjs`：桌面 UI、Trae 多实例和授权失败闭环冒烟测试。

## 验证

许可证能力接口默认只提供本地模拟器；商业服务未接入前，不把本地状态称为正式授权。
需要验证许可证状态时查看 `GET /api/license/status`，只有显式设置
`MULTIOPEN_ENABLE_LICENSE_GATE=1` 才启用启动门禁。

## 可信网络出口

实例可在档案配置中显式启用无凭据的 `http://host:port` 或
`https://host:port` 出口。启动前会执行一次上游连通性与公网 IP 预检；预检失败时
实例不会继续启动。该检查只证明代理服务本身可用，不等同于目标应用的全部请求、DNS、
WebRTC 或 QUIC 流量都已通过该出口，也不会自动轮换免费代理或写入系统代理。

商业部署应使用自有、合规、可审计的出口，并自行完成目标应用内的 IP/DNS/WebRTC/QUIC
验收；代理认证信息不写入日志、文档或导出文件。

## 实例隔离模式

实例默认使用 WorkBuddy 的持久化 Profile 隔离：每个实例使用独立 `config`、`userdata` 和浏览器 Profile，因此不会因 Sandboxie 服务异常而无法启动。档案中的“真实文件夹”仍通过共享目录/Junction 访问本机真实文件。

如需额外启用官方开源免费的 Sandboxie Classic 强隔离，可设置 `MULTIOPEN_USE_SANDBOXIE=1`；该模式要求 `SbieSvc`、`SbieDrv` 正常运行，失败时不会静默回退。

Sandboxie 不是默认启动前提。启用 Classic 强隔离时，请确认 `SbieSvc` 和 `SbieDrv` 服务运行。工作目录和历史记录按项目约定保留。

如果点击“开启实例”没有窗口，页面现在会显示 Sandboxie 返回的具体错误；重点检查 `SbieDrv`、`SbieSvc` 是否都为 RUNNING，并在安装驱动或服务后重启 Windows。项目会先回读 `sandboxie/Sandboxie.ini` 确认实例沙箱已创建，避免把配置失败伪装成启动成功。

```powershell
npm run build
npm test
npm run test:api
npm run test:browser
npm run test:browser-isolation
npm run smoke:electron
npm run release:check
npm run test:isolation
npm run security:check
npm run security:sbom
npm run release:manifest
npm run smoke:trae-start
npm run smoke:trae-add
npm run smoke:auth-fail-closed
```

`smoke:*` 需要桌面程序以 `--remote-debugging-port=9333` 运行；它们用于本机验收，不属于普通用户启动流程。

详细交付证据与未证明项见 [AUTHORIZATION_REFACTOR_HANDOFF.md](./AUTHORIZATION_REFACTOR_HANDOFF.md)。
试点支持、隐私边界和回滚流程见 `docs/SUPPORT-RUNBOOK.md`、
`docs/PRIVACY-DATA-HANDLING.md` 和 `docs/ROLLBACK-RUNBOOK.md`。
## External browser routing boundary

WorkBuddy's in-app external-link path calls Electron `shell.openExternal` directly. Windows resolves that call through the host user's default-browser association, so an instance cannot be assigned a different browser profile through environment variables or `--user-data-dir` alone. The launcher no longer advertises `MULTIOPEN_BROWSER_*` as if it intercepted that call.

The explicit Browser Broker accepts only `http:` and `https:` URLs. It rejects empty or whitespace-only input, URLs containing credentials, and URLs over 16 KiB before resolving a browser executable. Rejected input does not create or modify an instance browser profile.

Normal launches do not enable native process hooks. The explicit Browser Broker action opens the
instance's `browser-profile-v2`; the optional browser-only hook requires
`MULTIOPEN_ENABLE_BROWSER_HOOKS=1` and is diagnostic-only. Device identity, hardware identity,
free-proxy rotation, and global profile rewriting are not stable-path guarantees.

Instance data is persistent by default. Closing and reopening an instance preserves its application profile, login state, browser cookies, and browser history. Cleanup is only performed by an explicit clean/delete/reset action. Every instance uses a different `config` and `browser-profile-v2` directory; browser sessions are not shared between instances.
