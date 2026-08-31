# 公开验证报告

本报告记录可由第三方或 AI 安装代理重复执行的发布前验收。它不包含本机绝对路径、登录 token、Cookie、API Key 或其他凭据。

## 验证基线

- DSH：`0.1.2-alpha.1`。
- 插件：`0.2.0`；功能代码验证 commit 为 `0d0a11014d9f5ce916a0b67672115d954570e143`。
- 安装方式：全新隔离 `DSH_HOME`，不使用本地 `file:` 依赖。
- 运行形态：DSH Web Profile Bundle。

验证时 `pnpm-lock.yaml` 固定到上述完整 SHA；后续纯文档提交不改变该运行代码结论。

## 自动化质量门

- TypeScript 严格类型检查：通过。
- DSH 官方宿主类型：通过；未使用手写宿主 service shim。
- Vitest：14 个测试文件、250 项测试通过。
- Host ESM 与 Client CJS 构建：通过，目标 ES2022。
- `pnpm pack --dry-run`：仅包含运行产物、参考音频、装配文件、License、README 和公开文档。

## 远程安装

1. 从干净 DSH 基线创建新 Home，确认没有旧 Home 引用或 reparse point。
2. 第一次固定 SHA 安装被 pnpm 以 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 拒绝，profile 没有残留依赖或 lockfile。
3. 审核并加入 pnpm 输出的精确 `allowBuilds` 键后，Git 临时 checkout 的 `prepare` 成功生成 Host 与 Client 产物。
4. profile `pnpm-lock.yaml` 的 resolution 固定到预期完整 commit。
5. `pnpm peers check` 与 `--dump-config` 通过；配置包含 server 与 UI 两条 entry。

## 运行与真实 TTS

- DSH 正常监听，Host 没有 import 或 pending service 错误。
- 鉴权后的 Web boot manifest 包含插件；client bundle 返回 200，并包含面板注册标识。
- `/api/dsh-voice/state` 返回协议版本 1、空队列和 ready TTS。
- 内置 Profile 可列出。
- 真实 MiMo 试听请求返回 HTTP 200、`audio/wav` 和有效 RIFF/WAV；首次样本为 199,724 字节，健康状态从 `notYetTested` 变为已验证 ready。
- profile 仅覆写 `secretsFile` 时，飞书投递仍保持默认关闭。

真实 LLM 会话中，模型实际调用了一次 `voice_prepare`，收到成功工具结果，输出指定验证标记，并以 `completed` 结束回合；预合成完成播报随后进入语音队列。这证明了 `LLM → tools/execute → session/event → voice queue` 链路。

## 重启与隔离

- 激活内置 Profile 后停止 DSH，并用同一 Home 重启。
- 重启后 boot manifest 仍包含插件，激活 Profile 保持不变，飞书仍默认关闭。
- 内存队列按设计在重启后为空；再次真实试听返回 HTTP 200 和有效 222,764 字节 RIFF/WAV。
- 以最终候选首次启动时间为边界，排除 `node_modules` 检查 7 个旧 Home，均无文件写入；会话、投影缓存、Profile 和参考音频只写入目标 Home。

## 已解决问题

| 问题 | 结论 |
| --- | --- |
| Git `prepare` 被阻止 | pnpm 安全策略；使用精确 SHA `allowBuilds`，不能静默绕过。 |
| profile 看不到宿主 peers | 保留准确 peer 声明，并在 profile 使用 `peerDependencyRules.ignoreMissing`；运行时由 DSH fallback 提供唯一宿主实例。 |
| `dsh-client-runtime` 注入 | 当前 DSH 不存在该包；已删除并改为真实的 `ui-slots` 与 `ui-layout`。 |
| `secretsFile` 覆写后飞书意外启用 | DSH config 为替换语义；代码安全默认已改为 `larkEnabled: false` 并增加回归测试。 |
