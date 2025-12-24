# 任务：增强速率限制处理

## 1. 后端：指数退避
- [ ] 1.1 在 `src/types/config.ts` 中创建 `RetryConfig` 类型，包含 `maxRetries`、`initialDelayMs`、`maxDelayMs`、`jitterFactor`
- [ ] 1.2 添加 `calculateBackoffDelay()` 工具函数，支持抖动
- [ ] 1.3 更新 `ProxyService.handleChatCompletions()` 使用指数退避
- [ ] 1.4 为退避计算添加单元测试

## 2. 后端：预请求配额检查
- [ ] 2.1 在 `TokenManagerService` 中添加 `requestCount` 和 `lastRequestTime` 追踪
- [ ] 2.2 实现 `checkQuotaBeforeRequest(accountId)` 方法
- [ ] 2.3 在 `ProxyService` 调用 Gemini API 前集成预请求检查
- [ ] 2.4 若当前配额不足，自动切换到下一个账号

## 3. 后端：RPM/TPM 追踪
- [ ] 3.1 为每个账号创建滑动窗口计数器以追踪 RPM
- [ ] 3.2 从请求/响应中计算 Token 数以追踪 TPM
- [ ] 3.3 通过 IPC 暴露指标供前端使用
- [ ] 3.4 添加 IPC 处理器 `gateway.getQuotaMetrics()`

## 4. 前端：配额仪表盘
- [ ] 4.1 创建 `QuotaDashboard` 组件，包含进度条
- [ ] 4.2 添加配额重置时间倒计时
- [ ] 4.3 显示账号健康状态指示器（绿/黄/红）
- [ ] 4.4 将仪表盘集成到代理页面的服务控制下方

## 5. 前端：通知
- [ ] 5.1 当账号被限流时添加 Toast 通知
- [ ] 5.2 当自动切换到新账号时添加 Toast 通知
- [ ] 5.3 为所有新消息添加 i18n 翻译

## 6. 配置
- [ ] 6.1 在 `ProxyConfigSchema` 中添加 `ProxyRetryConfig` 及默认值
- [ ] 6.2 在代理页面添加重试配置的 UI 控件
- [ ] 6.3 添加自动切换敏感度的配额阈值滑块

## 7. 验证
- [ ] 7.1 为重试逻辑编写集成测试
- [ ] 7.2 手动测试：触发 429 并验证退避行为
- [ ] 7.3 手动测试：验证配额仪表盘实时更新
- [ ] 7.4 运行 `npm run type-check` 和 `npm run lint`
