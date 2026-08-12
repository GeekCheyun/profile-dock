# 安全与供应链门禁

## 已执行

- 依赖锁定在 `package-lock.json`；Electron 运行时固定到 43.3.0，以提供商用包所需的 `node:sqlite`。
- 默认关闭 native/browser Hook、旧版物理身份/指纹注入和免费代理路径。
- 控制 API 只允许 loopback、受信 Origin 和 Bearer Token。
- 实例目录和 Browser Broker 拒绝路径穿越及宿主 Profile 回退。
- 禁止 `NODE_TLS_REJECT_UNAUTHORIZED=0` 和 `<-loopback>`。
- 诊断报告不包含授权 URL、PKCE、Cookie、Token、代理密码或用户内容。
- `npm run security:check` 对运行时代码执行危险模式、密钥材料、执行级别和锁文件门禁。
- `npm run security:sbom` 生成 `release/sbom.cdx.json` 与依赖许可证清单。
- `npm audit --registry=https://registry.npmjs.org --omit=dev --audit-level=high` 已通过。

## 发布前必须补齐

- SBOM 中 `UNKNOWN_REVIEW_REQUIRED` 依赖的许可证核实；
- SBOM、第三方许可证和 native 产物来源；
- Windows 安装包代码签名与证书轮换流程；
- 干净机器安装、升级中断和回滚证据；
- 目标应用三实例并发、崩溃恢复和 24 小时 soak 证据。
