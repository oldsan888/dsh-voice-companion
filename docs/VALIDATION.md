# 公开验证报告

本报告记录可由第三方或 AI 安装代理重复执行的发布前验收。它不包含本机绝对路径、登录 token、Cookie、API Key 或其他凭据。

## 验证基线

- DSH：`0.1.2-alpha.1`。
- 插件：`0.2.0`，从 GitHub 完整 commit SHA 安装。
- 安装方式：全新隔离 `DSH_HOME`，不使用本地 `file:` 依赖。
- 运行形态：DSH Web Profile Bundle。

最终发布 commit SHA 将以本仓库默认分支和安装 lockfile 为准。

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
- 真实 MiMo 试听请求返回 `audio/wav`，健康状态从 `notYetTested` 变为已验证 ready。
- profile 仅覆写 `secretsFile` 时，飞书投递仍保持默认关闭。

## 重启与隔离

最终发布 SHA 的重启、持久化、事件播报和旧 Home 零写入结果会在远程复验完成后固化到本节。验收方法见 [安装与配置](INSTALLATION.md)。

## 已解决问题

| 问题 | 结论 |
| --- | --- |
| Git `prepare` 被阻止 | pnpm 安全策略；使用精确 SHA `allowBuilds`，不能静默绕过。 |
| profile 看不到宿主 peers | 保留准确 peer 声明，并在 profile 使用 `peerDependencyRules.ignoreMissing`；运行时由 DSH fallback 提供唯一宿主实例。 |
| `dsh-client-runtime` 注入 | 当前 DSH 不存在该包；已删除并改为真实的 `ui-slots` 与 `ui-layout`。 |
| `secretsFile` 覆写后飞书意外启用 | DSH config 为替换语义；代码安全默认已改为 `larkEnabled: false` 并增加回归测试。 |
