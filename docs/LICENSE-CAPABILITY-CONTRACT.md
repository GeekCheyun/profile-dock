# 许可证与能力门禁契约

## 当前实现

`server/license.ts` 提供许可证状态模型、实例上限、能力集合、到期和离线宽限判断。
当前只实现 `local-simulator`，用于开发、测试和验收，不代表商业签发服务已经接入。

只有显式设置 `MULTIOPEN_ENABLE_LICENSE_GATE=1` 时，许可证才会阻止实例启动。未设置时
保持现有本地开发行为；设置后若没有模拟许可证，启动请求会安全失败，不会静默降级为无限授权。

## 本地模拟器

可使用以下环境变量验证状态机，环境变量只用于本机测试，不得作为商业密钥：

```powershell
$env:MULTIOPEN_ENABLE_LICENSE_GATE='1'
$env:MULTIOPEN_LICENSE_MODE='local-simulator'
$env:MULTIOPEN_LICENSE_PLAN='trial'
$env:MULTIOPEN_LICENSE_MAX_INSTANCES='3'
```

支持 `active`、`grace`、`expired`、`invalid` 和 `unconfigured` 状态。API
`GET /api/license/status` 只返回状态、能力和上限，不返回任何凭据、签名材料或用户内容。

## 尚未自动完成的部分

- 商业签发协议、许可证公钥、租户/客户绑定和在线校验地址需要产品与服务端决策；
- 正式授权条款、价格、试用期限、隐私政策和退款规则需要产品/法务确认；
- 在上述决策完成前，不把本地模拟器称为正式授权系统，也不把 `UNLICENSED` 改成销售许可证。
