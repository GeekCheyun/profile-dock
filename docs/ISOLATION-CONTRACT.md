# Instance Isolation Contract

## 目的

定义商用版实例隔离的可验证边界，防止“目录独立”被误报成“物理设备独立”。

## 每实例私有资源

- 应用 Profile；
- 浏览器 Profile；
- `APPDATA`；
- `LOCALAPPDATA`；
- `USERPROFILE` / `HOME`；
- `TEMP` / `TMP`；
- 运行时锁和端口；
- 进程树和 Job Object；
- 日志和诊断记录；
- 网络出口绑定。

实例目录实现为 `config`、`browser-profile-v2`、`appdata`、`userdata`、`temp`、`runtime`、`logs` 和 `shared`。实例根目录和 profile ID 必须经过路径规范化，不能通过 `..`、绝对路径或非法序号逃逸到宿主目录。

## 允许共享

- 安装目录中的只读程序文件；
- 明确标记的只读工具包；
- 用户明确选择的真实工作文件夹。

## 禁止共享

- Cookie、LocalStorage、IndexedDB；
- 浏览器历史和缓存；
- 登录态和 Token；
- Machine ID、设备数据库和运行时数据库；
- 可写的公共 AppData；
- 代理凭据；
- 授权 URL 和 PKCE 数据。

## 生命周期要求

关闭实例只终止该实例进程树，不删除数据。删除必须是显式操作，并先确认精确实例目录、活动 PID 和备份策略。

## 网络要求

网络出口是独立能力。只有完成实例内实际验证后才显示 `egress_verified`。出口不可用时，实例进入 `quarantined`，不允许静默直连。

## 非目标

本契约不保证独立物理设备、独立硬件序列号、独立 SMBIOS、独立服务端设备身份或平台风控结果。
