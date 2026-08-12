# MultiOpen Workbench 商用化计划

## 目标

把当前 Windows 多开工具升级为可安装、可升级、可恢复、可诊断、可支持的商用桌面产品。

产品主线是“授权应用的多实例与环境隔离”，不是物理设备伪装或平台风控规避。

## 能力分层

1. Profile 隔离：应用数据、浏览器数据、AppData、Home、Temp、进程树独立。
2. 网络出口隔离：每实例绑定可信的代理/VPN 出口，实际请求验证，出口失效时闭锁。
3. 强隔离：Hyper-V 或远程 Windows 实例。
4. 测试模拟：仅对自有测试系统提供语言、时区、窗口参数，不作为反检测能力。

## 当前项目必须先解决的问题

- 统一稳定 Profile 路径和浏览器 Broker，避免 Hook、系统默认浏览器、授权浏览器三套行为不一致；浏览器入口必须拒绝宿主目录回退。
- 删除稳定产品中的 MachineGuid、CPU、SMBIOS 等物理身份伪装模型。
- 将 SQLite WAL 与 `InstanceManifest` 作为运行时状态源；`config.json` 仅作兼容导出和旧版迁移输入，防止实例状态漂移。
- 用 Job Object 管理进程树，并保留受实例目录约束的 marker 扫描作为兼容/审计手段，避免关闭实例后残留 renderer、GPU 或浏览器进程。
- 建立 Egress Manager，禁止免费代理、代理失效直连和证书校验降级。
- 建立安装、升级、回滚、备份、恢复和诊断闭环。
- 建立本地许可证能力接口、SBOM、安全门禁、试点支持和隐私数据处理边界；商业签发服务仍作为外部依赖。

## 目标目录

```text
engine/instances/<instance-id>/
  manifest.json
  app-state/
  browser-profile/
  appdata/
  userdata/
  temp/
  runtime/
  shared-readonly/
  logs/
```

共享目录只放只读程序或素材。账号、Cookie、缓存、设备 ID 和运行时状态禁止共享。

## 目标模块

- `InstanceManager`：实例 CRUD 和状态机；
- `ProcessManager`：启动、Job Object、进程树、孤儿清理；
- `FilesystemIsolation`：目录、ACL、备份、删除和迁移；
- `BrowserBroker`：实例浏览器、OAuth、loopback、外链；
- `EgressManager`：出口绑定、凭据、安全检查和失败闭锁；
- `StateStore`：SQLite WAL、迁移、并发和恢复；
- `Diagnostics`：脱敏结构化日志和诊断包；
- `UpdateManager`：签名安装包、升级和回滚；
- `LicenseManager`：授权、试用、宽限和能力门禁。

## 里程碑

| 阶段 | 交付物 | 通过条件 |
|---|---|---|
| P0 | PRD、隔离契约、威胁模型 | 所有产品承诺可证明 |
| P1 | SQLite、Manifest、状态机 | 三实例状态不漂移 |
| P2 | 生命周期和恢复 | A/B/宿主互不误伤 |
| P3 | Browser Broker | 外链和 OAuth 不落宿主 Profile |
| P4 | Egress Manager | 实际出口验证，失败不直连 |
| P5 | 安装、更新、诊断、授权 | 干净机器可安装和回滚 |
| P6 | 兼容性和试点 | 24 小时稳定，问题可诊断 |

## 商业发布前必须证明

- A 登录、退出、重启、删除不影响 B；
- 浏览器 Cookie、Storage、Cache 和历史不串；
- 外部链接进入实例浏览器；
- 实际实例流量从配置出口出去；
- 出口失效后不能直连；
- 授权回调归属正确；
- 无进程泄漏；
- 安装、升级、回滚和数据迁移成功；
- 日志、导出和诊断包无敏感信息。

## 不可承诺

一个 Windows 进程/Profile 不等于一台物理设备。服务端是否将实例视为不同设备，必须作为外部未证明项，不得写入销售承诺。
