# Commercial Release Runbook

## 发布前

1. 确认版本号、变更记录和迁移脚本。
2. 执行 TypeScript 构建、单元测试、API 测试、浏览器 loopback 测试和 Electron 冒烟测试。
3. 在干净 Windows 环境安装并启动两个实例。
4. 验证 A/B 登录态、目录、进程、浏览器和外链边界。
5. 如果发布网络出口能力，必须完成实例内出口验证和失败闭锁测试。
6. 扫描日志、安装包和诊断导出，确认无 Token、Cookie、授权 URL、PKCE 或代理凭据。
7. 运行 `npm run security:check`、`npm run security:sbom` 和 `npm run release:manifest`，保留 SBOM、许可证清单和文件哈希。
8. 生成签名安装包；若未配置 `CSC_LINK`，只能生成未签名候选包，不能称为正式商业发布。
9. 运行 `npm run release:check`；记录 `signingConfigured` 和所有未证明项。

## 灰度

- 先内部环境；
- 再 5 个试点用户；
- 观察崩溃、启动失败、孤儿进程、磁盘增长和恢复成功率；
- 仅在关键门禁通过后扩大范围。

## 回滚

- 保留上一版本安装包；
- 升级前备份 SQLite 元数据和实例 Manifest；
- 升级失败只回滚程序，不覆盖用户实例数据；
- 数据迁移失败必须进入恢复模式，禁止自动删除旧数据。

## 支持诊断

诊断包只包含版本、状态、脱敏路径、进程摘要、错误码、健康检查结果和时间线，不包含用户内容、Cookie、Token、授权链接或代理密码。

桌面控制 API 提供 `/api/instances/:box/diagnostics` 脱敏报告；实例备份必须使用 `server/backup.ts` 的不覆盖恢复流程，`shared` Junction 不进入备份。

无安装器权限时可运行 `npm run release:portable` 生成未签名便携候选包；它只用于内部验收，不能替代签名安装器和自动更新服务。
