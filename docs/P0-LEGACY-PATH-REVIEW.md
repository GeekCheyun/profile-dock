# P0 旧路径隔离审计

日期：2026-08-09

## 结论

商用稳定路径只应用持久化实例目录、实例私有 `APPDATA/LOCALAPPDATA/USERPROFILE/HOME`、独立浏览器 Profile 和显式 Browser Broker。旧版 native Hook、物理设备身份重写、CDP 指纹注入、代理环境覆盖和 TTNet 守卫不再因 Profile 配置自动启用。

## 旧模块盘点

| 模块 | 历史作用 | P0 稳定路径处理 |
| --- | --- | --- |
| `server/fingerprint.ts` | 生成 MachineGuid、主机名、UA、时区和代理 | 保留历史数据结构；不自动应用 |
| `server/fingerprint-script.ts` / `server/cdp-injector.ts` | 浏览器层脚本覆盖和 CDP 注入 | 仅在显式 legacy fingerprint 实验中进入启动参数 |
| `server/proxy-pool.ts` | 抓取和轮换公开代理 | 正常启动不调用；API 已返回 410 |
| `native/hook_dll/hook_dll.c` | 进程/浏览器外链 Hook | 默认不加载；浏览器 Hook 需显式开关 |
| `server/engine.ts` 身份重写函数 | 改写 device id、machineid、TTNet 配置 | 默认不调用；仅诊断开关开启时调用 |

## 显式实验开关

- `MULTIOPEN_ENABLE_BROWSER_HOOKS=1`：仅启用浏览器外链兼容 Hook。
- `MULTIOPEN_ENABLE_NATIVE_HOOKS=1`：显式启用 native Hook 兼容实验。
- `MULTIOPEN_ENABLE_LEGACY_FINGERPRINT=1`：显式启用旧版身份、浏览器指纹和代理注入实验。

这些开关不构成“独立物理设备”“独立平台指纹”或“平台风控通过”的承诺，日志和发布文档不得把实验结果写成商业能力。

## P0 验收证据

- `server/runtime-policy.ts` 的默认判断只有环境变量精确等于 `1` 才启用。
- `server/engine.ts` 不再设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`。
- 默认启动参数不接收历史 fingerprint，默认不分配 CDP 端口、不执行身份重写、不启动 TTNet 守卫。
- `server/profiles.ts` 默认不注入临时代理池，也不自动检测/重分配历史代理。
