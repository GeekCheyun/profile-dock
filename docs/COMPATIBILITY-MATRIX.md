# 兼容性与验收矩阵

| 维度 | 当前基线 | 证据 | 状态 |
| --- | --- | --- | --- |
| Windows 桌面后端 | Electron 43.3.0，`asInvoker` | `npm run smoke:electron` | 已验证本机 |
| Node/TypeScript | Node 25 开发测试，Electron 内置 Node 22+ | `npm test`、`npm run build` | 已验证本机 |
| Chromium loopback | 真实 Chromium + 不可达代理 | `npm run test:browser` | 已验证 |
| 控制 API | loopback、Origin、Bearer Token | `npm run test:api` | 已验证 |
| Profile 隔离 | config/browser/appdata/userdata/temp/runtime/logs | layout/manifest 单测 | 已验证代码边界 |
| Job Object | Windows 子进程附加/终止 | job probe | 已验证单实例 |
| 三实例目录与状态 | 3 个实例独立目录、Manifest、PID 和内容 | `npm run test:isolation`、`npm run test:soak`（100 轮/20 次故障注入） | 已验证代码边界 |
| 可信出口 | 无凭据 HTTP/HTTPS CONNECT，失败闭锁 | egress 单测；真实出口需用户配置 | 部分验证 |
| Chrome/Edge 外链 | 显式实例浏览器 Broker | URL/Profile 安全单测 | 已验证入口边界 |
| 目标 WorkBuddy 多实例 | 真实目标版本、三实例并发、24 小时 soak | 尚未完成 | 未证明 |
| 平台设备识别/签到 | 服务端回执 | 必须用户完成新授权和上游回执 | 未证明/不承诺 |
| 签名安装包 | 证书和发布账户 | 当前未配置签名证书 | 未证明 |
| 本地许可证门禁 | active/grace/expired/invalid/unconfigured 状态机 | `npm run test:isolation`、`GET /api/license/status` | 已验证模拟器，未接商业服务 |
| SBOM/供应链 | CycloneDX、许可证清单、静态安全门禁 | `npm run security:check`、`npm run security:sbom` | 已验证生成，1 项许可证待复核 |

本表刻意区分本地代码验证、目标应用行为验证和外部服务回执，三者不能互相替代。
