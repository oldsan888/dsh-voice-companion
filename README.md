# @oldsan888/dsh-voice-companion

DSH v2（DeepSeek Harness）的语音插件。它在任务完成、需要用户回答或最终失败时生成语音提示，并在浏览器面板中播放；也支持音色管理、低延迟流式播放和可选的飞书语音投递。

## 功能

- 完成、提问和失败三类语音事件；`@voice` 标记与 `voice_prepare` 预合成。
- 音色 Profile 的创建、试听、启用和回滚。
- 默认 voiceclone 模式的句子级流水，以及预置音色的低延迟 PCM 流式模式。
- 浏览器端播放控制：音量、静音、队列、诊断和多标签页 leader 租约。
- 可选飞书投递：`voice_send_to_lark` 需显式确认，音频转码、有限重试、临时文件清理和脱敏审计均由插件处理。
- MiMo TTS 直连；不依赖本地 TTS 服务或 5256 端口。

## 安装

将插件作为 DSH v2 的 Profile Bundle 安装；不要修改 DSH 源码。以下命令中的尖括号内容需要替换为你的实际目录：

```powershell
cd <dsh-repository>
$env:DSH_HOME = '<dsh-home-directory>'
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add "file:<plugin-directory>"
```

安装完成后重启 DSH Web 进程。插件会通过 `cordis.patch.yml` 注册 Host 和 Client 模块。

## 配置

MiMo TTS 需要以下环境变量，或等价地写入 `<DSH_HOME>/secrets/dsh-voice-companion.env`：

| 变量 | 说明 |
| --- | --- |
| `DSH_VOICE_MIMO_API_BASE_URL` | MiMo API Base URL（不含 `/chat/completions`） |
| `DSH_VOICE_MIMO_API_KEY` | MiMo API Key |

```dotenv
DSH_VOICE_MIMO_API_BASE_URL=https://your-endpoint.example.com/v4
DSH_VOICE_MIMO_API_KEY=your-api-key-here
```

环境变量优先于 secrets 文件。请勿将凭据提交到 Git；插件不会将凭据写入日志、HTTP 响应或浏览器。

`cordis.patch.yml` 包含非敏感默认配置，例如模型、语速、队列上限、请求超时和音频大小上限。飞书投递默认可关闭；启用时凭据由本机 `lark-cli` 管理，不与 MiMo 凭据混用。

## 使用

- 打开右下角语音面板，解锁浏览器音频后即可试听、控制音量或接管播放租约。
- 对简短回复，可在行首使用 `@voice`：

  ```text
  @voice 已经处理完成。
  ```

- 对耗时任务，模型可先调用 `voice_prepare`；音频只会在任务成功结束后播放。
- 飞书语音外发只能通过 `voice_send_to_lark` 显式指定接收方、内容并确认，普通播报不会自动外发。

## 开发

```powershell
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

当前测试套件包含 238 个测试，覆盖事件提取、队列、租约、TTS、Profile、流式 API、面板交互、飞书投递和隔离场景。

## 安全边界

- 运行数据、临时音频和凭据均位于 `DSH_HOME`。
- 音频、文本和上游响应均有大小限制；错误信息经过脱敏处理。
- 多标签页中只有租约 leader 可消费和合成语音。
- 飞书投递仅在显式启用且确认后执行；临时文件成功后立即清理。

## License

MIT
