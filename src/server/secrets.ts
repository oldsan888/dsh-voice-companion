/**
 * 专用 secrets 解析器：只接受 DSH_VOICE_MIMO_API_BASE_URL 与
 * DSH_VOICE_MIMO_API_KEY 两个变量；进程环境变量优先于专用 secrets 文件。
 *
 * - 不加载任何第三方 .env 解析库，也不读取任何其他服务的 env 文件；
 * - 文件解析只认 `KEY=VALUE` 行（支持注释、export 前缀、成对引号），
 *   其他键一律忽略；
 * - 任何日志/错误都不得包含值本身。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** secrets 文件允许且仅允许的两个键。 */
export const SECRET_KEYS = ['DSH_VOICE_MIMO_API_BASE_URL', 'DSH_VOICE_MIMO_API_KEY'] as const

export type SecretKey = (typeof SECRET_KEYS)[number]

export type SecretsResult =
  | { ok: true; apiBaseUrl: string; apiKey: string; origin: 'env' | 'file' | 'mixed' }
  | { ok: false; reason: 'missing-file' | 'io-error' | 'missing-keys' | 'bad-base-url'; detail: string }

/** 最小 .env 形态解析（仅本插件两个键；返回对象不进入日志）。 */
export function parseSecretsFile(content: string): Partial<Record<SecretKey, string>> {
  const result: Partial<Record<SecretKey, string>> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line
    const eq = withoutExport.indexOf('=')
    if (eq <= 0) continue
    const key = withoutExport.slice(0, eq).trim()
    if (!(SECRET_KEYS as readonly string[]).includes(key)) continue
    let value = withoutExport.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2)
      || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1)
    }
    if (value) result[key as SecretKey] = value
  }
  return result
}

/** 校验并归一 API Base URL：仅 http/https，无 query/fragment，去掉结尾斜杠。 */
export function normalizeApiBaseUrl(raw: string): { ok: true; url: string } | { ok: false } {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false }
  if (parsed.search || parsed.hash) return { ok: false }
  return { ok: true, url: `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}` }
}

/** 读取 secrets 文件（缺失/IO 错误转为脱敏结果）。 */
function readSecretsFile(secretsFile: string): { ok: true; content: string } | { ok: false; reason: 'missing-file' | 'io-error' } {
  try {
    return { ok: true, content: readFileSync(secretsFile, 'utf8') }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    return code === 'ENOENT' ? { ok: false, reason: 'missing-file' } : { ok: false, reason: 'io-error' }
  }
}

export interface ResolveSecretsInput {
  env?: Record<string, string | undefined>
  /** 已读取的 secrets 文件内容（测试注入）；与 secretsFile 二选一。 */
  fileContent?: string
  secretsFile?: string
}

/**
 * 组装凭据：环境变量优先，文件补缺。两个键必须齐备；
 * Base URL 必须通过协议校验。失败结果只含脱敏原因。
 */
export function resolveSecrets(input: ResolveSecretsInput): SecretsResult {
  const env = input.env ?? process.env
  const fromEnvBase = env.DSH_VOICE_MIMO_API_BASE_URL?.trim() || ''
  const fromEnvKey = env.DSH_VOICE_MIMO_API_KEY?.trim() || ''

  let fromFile: Partial<Record<SecretKey, string>> = {}
  let haveFile = false
  if (input.fileContent !== undefined) {
    fromFile = parseSecretsFile(input.fileContent)
    haveFile = true
  } else if (input.secretsFile !== undefined) {
    const read = readSecretsFile(input.secretsFile)
    if (!read.ok) {
      return {
        ok: false,
        reason: read.reason,
        detail: read.reason === 'missing-file'
          ? 'secrets 文件不存在（配置 dsh-home secrets 后重启 DSH 即可）'
          : 'secrets 文件不可读',
      }
    }
    fromFile = parseSecretsFile(read.content)
    haveFile = true
  }

  const apiBaseUrlRaw = fromEnvBase || fromFile.DSH_VOICE_MIMO_API_BASE_URL || ''
  const apiKey = fromEnvKey || fromFile.DSH_VOICE_MIMO_API_KEY || ''
  if (!apiBaseUrlRaw || !apiKey) {
    return {
      ok: false,
      reason: 'missing-keys',
      detail: '凭据未配置：需要 DSH_VOICE_MIMO_API_BASE_URL 与 DSH_VOICE_MIMO_API_KEY（环境变量或 dsh-home secrets 文件）',
    }
  }
  const normalized = normalizeApiBaseUrl(apiBaseUrlRaw)
  if (!normalized.ok) return { ok: false, reason: 'bad-base-url', detail: 'API Base URL 协议不合法（仅 http/https，且不带 query）' }

  const origin = fromEnvBase && fromEnvKey ? 'env'
    : (fromEnvBase || fromEnvKey) && haveFile ? 'mixed'
      : haveFile ? 'file' : 'env'
  return { ok: true, apiBaseUrl: normalized.url, apiKey, origin }
}

/**
 * 校验 secrets 路径必须位于 dsh-home 内（防止把凭据指到任意位置）。
 * dsh-home 解析规则与宿主一致：显式 > DSH_HOME > ~/.dsh。
 */
export function isInsideDshHome(secretsFile: string, env: Record<string, string | undefined> = process.env): boolean {
  const configured = env.DSH_HOME?.trim()
  const home = normalize(configured ? expandTilde(configured) : join(homedir(), '.dsh'))
  const file = normalize(expandTilde(secretsFile))
  return file !== home && file.startsWith(`${home}/`)
}

/** 统一为 POSIX 形式的绝对路径（Windows 反斜杠归一为斜杠）。 */
function normalize(p: string): string {
  return resolve(p).replaceAll('\\', '/').replace(/\/+$/, '')
}

function expandTilde(p: string): string {
  return p.replace(/^~(?=$|[\\/])/, homedir())
}
