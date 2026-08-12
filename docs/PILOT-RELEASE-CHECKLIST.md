# 试点发布清单

## 自动门禁

- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run test:api`
- [ ] `npm run test:browser`
- [ ] `npm run test:isolation`
- [ ] `npm run test:soak`
- [ ] `npm run security:check`
- [ ] `npm run security:sbom`
- [ ] `npm run release:check`
- [ ] `npm run release:manifest`

## 人工/外部门禁

- [ ] 代码签名证书可验证且证书轮换责任人明确；
- [ ] 干净 Windows 安装、升级中断、回滚和卸载保留数据；
- [ ] 两至三个真实目标应用实例并发运行；
- [ ] 目标应用登录态、浏览器 Cookie、外链和授权回调不串；
- [ ] 真实代理出口 IP/DNS/WebRTC/QUIC 和断网闭锁；
- [ ] 目标平台成功必须有上游回执；
- [ ] 5-20 个试点用户的诊断、回滚和问题收敛流程已演练。

## 发布结论

未完成外部门禁时只能发布“未签名内部候选包”或“测试构建”，不能称为正式商业版。
