# @oldsan888/dsh-voice-companion

面向 DSH v2（DeepSeek Harness）的语音插件。它把任务完成、需要回答和最终失败等事件转换为语音，并通过浏览器右下角的全局面板播放；同时提供音色管理、低延迟流式播放和可选的飞书语音投递。

## 主要能力

- 完成、提问、失败三类自动播报，以及 `@voice` 和 `voice_prepare` 预合成。
- MiMo TTS 直连，不依赖本地 TTS 服务或固定端口。
- 音色 Profile 的设计、试听、启用、回滚与删除。
- 浏览器端音量、静音、队列、诊断、多标签页 leader 租约和可拖动面板。
- 可选飞书语音投递；默认关闭，启用后仍要求显式确认。
- 运行数据、凭据和临时文件均限制在当前 `DSH_HOME`。

## 兼容性

- 已验证：DSH `0.1.2-alpha.1`。
- 安装形态：DSH Web Profile Bundle。
- 分发形态：Git 源码安装；安装时需按 pnpm 提示授权精确 commit 的 `prepare` 构建。
- TTS：需要有效的 MiMo API Base URL 与 API Key。

## 安装入口

不要修改 DSH 源码，也不要直接编辑插件在 `node_modules` 中的安装副本。请按 [安装与配置](docs/INSTALLATION.md) 使用远程 Git 的完整 commit SHA 安装，并在独立 `DSH_HOME` 中保存凭据。

最短命令形态：

```powershell
$env:DSH_HOME = '<absolute-path-to-dsh-home>'
pnpm dsh plugin --profile web add 'git+https://github.com/oldsan888/dsh-voice-companion.git#<full-commit-sha>'
```

第一次执行被 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 拒绝是 pnpm 的安全机制。只在审核源码后，把 pnpm 输出的精确键加入该 profile 的 `pnpm-workspace.yaml`，再重试。

## 使用概览

- 打开右下角语音面板并解锁浏览器音频。
- 简短回复可在行首使用 `@voice`。
- 耗时任务可先调用 `voice_prepare`，仅在任务成功结束后播放。
- 音色变更先设计与试听，得到用户确认后再启用。
- 飞书外发仅由 `voice_send_to_lark` 显式发起；默认不启用。

## 目录

```text
assets/                 随包参考音频
src/client/             浏览器面板、播放队列与 API 客户端
src/server/             事件、TTS、音色、HTTP API 与可选飞书适配器
src/shared/             Host/Client 共享协议与常量
tests/                  自动化测试
cordis.patch.yml        DSH Bundle 装配入口
docs/                   安装、技术参考与验证报告
```

## 文档

- [安装与配置](docs/INSTALLATION.md)
- [技术参考](docs/TECHNICAL-REFERENCE.md)
- [公开验证报告](docs/VALIDATION.md)

## 安全边界

凭据不得提交到 Git。插件限制输入、文本、音频和上游响应大小，错误信息经过脱敏；多标签页只有租约 leader 可以消费和合成语音；飞书投递默认关闭且需要确认。

## License

MIT
