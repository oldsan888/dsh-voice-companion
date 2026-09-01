# 安装与配置

本文面向开发者和 AI 安装代理。目标是从远程 Git 固定版本安装插件，不修改 DSH 源码，并确保所有运行数据只进入指定的 `DSH_HOME`。

## 1. 前置条件

- 一份可正常启动的 DSH v2 Web 源码。
- 一个已配置 LLM、但尚未安装本插件的独立 `DSH_HOME`。
- Node.js、pnpm 和 Git。
- MiMo TTS 的 API Base URL 与 API Key。

安装、检查和启动的每条命令都必须显式设置同一个 `DSH_HOME`：

```powershell
$DshRepo = '<absolute-path-to-deepseek-harness>'
$DshHome = '<absolute-path-to-isolated-dsh-home>'
$Commit = '<audited-40-character-commit-sha>'
$env:DSH_HOME = $DshHome
Set-Location $DshRepo
```

启动前可搜索新 Home，确认其中没有旧 Home 的绝对路径、junction 或 symbolic link。

## 2. 从 Git 固定版本安装

不要用浮动的 `main` 作为可复现安装目标：

```powershell
pnpm dsh plugin --profile web add "git+https://github.com/oldsan888/dsh-voice-companion.git#$Commit"
```

Git 包通过 `prepare` 生成 `lib/`。pnpm 首次通常会返回 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`；这是预期的安装脚本安全拦截。审核源码后，将错误消息给出的完整键原样加入：

```yaml
# <DSH_HOME>/profiles/web/pnpm-workspace.yaml
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false

allowBuilds:
  '@oldsan888/dsh-voice-companion@git+https://github.com/oldsan888/dsh-voice-companion.git#<full-commit-sha>': true

peerDependencyRules:
  ignoreMissing:
    - '@deepseek-ai/*'
```

`ignoreMissing` 只消除 profile 安装器看不到宿主 peers 的静态警告，不会下载或替换 DSH 的宿主包。然后重新执行安装命令。

安装后检查：

```powershell
pnpm --dir "$DshHome/profiles/web" peers check
pnpm dsh --profile web --dump-config
```

`pnpm-lock.yaml` 中的 resolution 必须固定到预期完整 SHA；配置中应出现 `voice-companion-server` 和 `voice-companion-ui`。

### 升级 Git commit

升级时先把旧 SHA 和新 SHA 两个精确 `allowBuilds` 键同时保留为 `true`，执行新 SHA 的 `plugin add`，确认 lockfile 已切换后再删除旧键。直接提前删除旧键，pnpm 可能在升级事务检查旧包时返回 `ERR_PNPM_IGNORED_BUILDS`。

## 3. 配置 MiMo 凭据

插件需要以下两个变量：

| 变量 | 说明 |
| --- | --- |
| `DSH_VOICE_MIMO_API_BASE_URL` | `http`/`https` Base URL；不要带 query、fragment 或 `/chat/completions` 后缀。 |
| `DSH_VOICE_MIMO_API_KEY` | MiMo API Key。 |

MiMo 官方控制台：[小米 MiMo 开放平台](https://platform.xiaomimimo.com/console)

推荐创建仅位于当前 Home 的文件：

```dotenv
# <DSH_HOME>/secrets/dsh-voice-companion.env
DSH_VOICE_MIMO_API_BASE_URL=https://your-endpoint.example.com/v4
DSH_VOICE_MIMO_API_KEY=replace-with-your-secret
```

再在 profile 用户层声明该文件：

```yaml
# <DSH_HOME>/profiles/web/cordis.patch.yml
- id: voice-companion-server
  config:
    secretsFile: !!js dshHomePath('secrets/dsh-voice-companion.env')
```

DSH 的同 id profile `config` 会替换 bundle `config`；未写出的字段由插件代码的安全默认值补齐。尤其是 `larkEnabled` 仍为 `false`。`secretsFile` 必须位于当前 `DSH_HOME` 内，越界路径会被拒绝。

也可以把这两个变量放入 DSH Web 控制器使用的环境文件。进程环境变量优先于 secrets 文件。

## 4. 可选配置

需要覆写非敏感选项时，把它们写在同一个 profile config 中：

```yaml
- id: voice-companion-server
  config:
    secretsFile: !!js dshHomePath('secrets/dsh-voice-companion.env')
    speed: 1
    queueLimit: 8
    promptEnabled: true
    larkEnabled: false
```

飞书投递只有在 `larkEnabled: true` 时才装配，并依赖本机已认证的 `lark-cli`；发送工具仍要求目标、文本与显式确认。

## 5. 启动与验收

```powershell
$env:DSH_HOME = $DshHome
pnpm dsh --profile web --no-open
```

验收标准：

1. DSH 正常监听，启动日志无插件 import、pending service 或凭据泄露。
2. Web boot manifest 与 client bundle 包含 `@oldsan888/dsh-voice-companion`。
3. 右下角面板出现，状态为 `ready`，内置 Profile 可列出。
4. 点击试听后得到可播放 WAV，健康状态不再标记 `notYetTested`。
5. 新建会话触发完成/提问事件，只有当前 leader 标签页播放。
6. 重启同一 Home 后 Profile 和设置仍可读取；其他 Home 没有产生写入。

## 6. 常见问题

- `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`：按 pnpm 输出授权精确 Git SHA 后重试。
- `ERR_PNPM_IGNORED_BUILDS`：升级期间同时保留旧、新 SHA 的授权；按提示处理其他明确需要的构建包。
- TTS 显示 `unconfigured`：检查两个变量是否齐全，以及 profile 是否声明 `secretsFile`。
- TTS 返回错误：确认 Base URL 格式、网络、Key 权限和上游配额；插件不会回显 Key。
- 面板没有出现：检查 boot manifest、client bundle 和浏览器控制台的 pending service/import 错误。
- 没有声音：先与页面交互以解除浏览器自动播放限制，再确认该标签页持有 leader 租约且未静音。

## 7. 卸载

使用 DSH plugin CLI 从对应 profile 删除包，然后重启 DSH。删除 `$DSH_HOME/voice-profiles`、secrets 或其他运行数据前应先备份；这些数据不会写入 DSH 源码仓库。
