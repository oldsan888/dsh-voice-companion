# 技术参考

## 装配结构

插件是一个 DSH Web Profile Bundle：

- `./server` 注册 Host 服务、事件监听、工具和 `/api/dsh-voice/*` exact 路由。
- `./client` 通过 `shell.overlay` slot 注册全局面板。
- `cordis.patch.yml` 只声明非敏感默认和两条 Loader entry。
- `package.json#dsh.client.inject` 声明 `ui-slots` 与 `ui-layout`，保证客户端依赖先装载。

Host 使用 DSH 官方 `cordis`、`dsh-tools`、`dsh-session`、`dsh-system-prompt` 和 `dsh-host-webserver` 类型；这些是宿主 peers，不应由插件复制一套运行时实例。

## 事件与播放

- `session/event`：从 `assistant/message` 与 `turn/end` 提取完成或最终失败播报。
- `tools/execute`：识别需要用户回答的工具通道。
- `voice_prepare`：提前合成，但只有对应 turn 成功结束后才授权播放。
- 队列有大小、优先级、去重 TTL 和统计；失败不会反向中断 DSH 主流程。
- 浏览器标签页通过短租约选举 leader，只有 leader 可以 drain 与 TTS。

## 模型工具

| 工具 | 作用 |
| --- | --- |
| `voice_prepare` | 为当前回合预合成完成播报。 |
| `voice_profile_list` | 列出音色 Profile。 |
| `voice_profile_design` | 根据描述生成候选音色。 |
| `voice_profile_refine` | 基于调整描述生成新候选，不覆盖旧候选。 |
| `voice_profile_preview` | 试听指定候选。 |
| `voice_profile_activate` | 用户确认后启用音色。 |
| `voice_profile_rollback` | 回滚到上一音色。 |
| `voice_profile_delete` | 删除允许删除的 Profile。 |
| `voice_send_to_lark` | 显式确认后向指定目标发送语音。 |
| `voice_delivery_status` | 查询可选投递适配器状态。 |

## TTS 模式

- 身份优先：MiMo voiceclone，使用当前 Profile 的参考 WAV，按句流水合成。
- 速度优先：MiMo 预置音色流式接口，服务端把 PCM16/24 kHz/单声道分片封装为 NDJSON 中的 WAV 段。
- 音色设计：voicedesign 生成候选，存储后必须先试听并明确批准，才允许切换。

## 数据与安全

- 凭据只从进程环境或 `DSH_HOME` 内的 secrets 文件读取。
- Profile 参考音频、元数据、临时转码与审计记录都在当前 Home 的插件目录中。
- Base URL、文本、音频、请求体、候选数和响应大小均有校验或上限。
- 日志和 HTTP 错误经过脱敏，不返回 API Key 或完整上游响应。
- 飞书投递默认关闭；启用后仍需工具参数校验和显式确认，临时文件在完成后清理。

## 配置替换语义

DSH profile 中针对同一 Loader id 的 `config` 是替换层，不是深合并。插件因此在代码中维护与 bundle 一致的完整默认值；当用户只配置 `secretsFile` 时，其余字段仍会得到安全默认，特别是 `larkEnabled: false`。
