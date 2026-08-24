/**
 * 播报文本净化（Phase 3 §8.2）：进入 TTS 前清理或口语化，纯函数、无状态。
 *
 * 处理项：
 * - Markdown：代码块、行内代码、链接、标题、列表、引用、分隔线；
 * - URL、文件路径（Windows/Unix）、哈希、超长数字；
 * - 凭据/密钥/Token 片段（替换为占位，不朗读）；
 * - 控制字符、零宽字符与不适合口头表达的符号（emoji、框线、制表符等）。
 *
 * 设计约束：
 * - 正文（屏幕显示）与播报稿分离：本模块只作用于到达 TTS 的播报稿；
 * - 输出绝不包含 Markdown 语法、URL、路径、哈希或凭据原文；
 * - 只移除确定不该读的字符，保留 @ # / % 等口语可读符号，避免误伤正文。
 */
import { truncateCodePoints } from './events.ts'

/** 控制字符 + 零宽 + 软连字符（\n 稍后归一为空格）。 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF\u00AD]/g

/** 常见 emoji / 装饰箭头 / 杂项符号（不读）。 */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{FE0E}\u{FE0F}\u{200D}]/gu

/** 行内代码与代码块（``` 或 ~~~ 成对）。 */
const CODE_BLOCK = /```[\s\S]*?```|~~~[\s\S]*?~~~|``[^`\n]*``|`[^`\n]*`/g

/** Markdown 链接 [label](url) → label。 */
const MD_LINK = /\[([^\]]*)\]\([^)\s]+(?:\s+"[^"]*")?\)/g

/** 行首 Markdown：标题整行删；列表/引用/任务框只去标记留文本；分隔线删。 */
const MD_LINE_LEAD = /^[ \t]*(?:#{1,6}[ \t]+[^\n]*|[-*+][ \t]+|\d+[.、)][ \t]+|>[ \t]*|\[[ xX]\]|[-*_]{3,}[ \t]*$)/gm

/** URL（http/https/ftp）。 */
const URLS = /https?:\/\/[^\s<>(){}[\]"'\\]+|ftp:\/\/[^\s<>(){}[\]"'\\]+/g

/** 文件路径：Windows（盘符/UNC）与 Unix 风格（/ 前缀不要求词边界）。 */
const PATHS = /[A-Za-z]:[\\/][^\s<>"']*|\\\\[^\s<>"']+|~\/[^\s<>"']*|\/(?:home|Users|usr|etc|opt|var)(?:\/[^\s<>"']*)?/g

/** 长十六进制哈希（≥16 位）。 */
const HASHES = /\b[0-9a-fA-F]{16,}\b/g

/** 凭据/密钥/Token 形态（key=value、Bearer、sk-、AKIA 等）→ 移除。 */
const CREDENTIALS = /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{6,}|\bBearer[ \t]+[A-Za-z0-9._~+/-]+=*|\b(?:api[_-]?key|password|passwd|secret|token|access[_-]?key)[ \t]*[:=][ \t]*[^\s,;，。]+/gi

/** 超长数字（≥10 位连续数字）→ 移除占位（如订单号/内部 ID，不朗读）。 */
const LONG_DIGITS = /\b\d{10,}\b/g

/** 制表符/换行 → 空格。 */
const BREAKS = /[ \t\r\n]+/g

/** 不需要朗读的嘈杂符号：竖线、反引号、波浪号、脱字符、反斜杠残留、词中下划线串。 */
const NOISY_SYMBOLS = /[|`~^\\]+|(?<=\w)_(?=\w)/g

/** 符号区兜底：仅清除 Unicode 框线/数学运算符/拼音注音/私用区等确定不读的块。 */
const STRIP_BLOCKS = /[\u{2500}-\u{257F}\u{2580}-\u{259F}\u{2E00}-\u{2E7F}\u{1D00}-\u{1DBF}\u{E000}-\u{F8FF}\u{FFF0}-\u{FFFF}]/gu

/**
 * 净化一段播报文本（纯函数）。顺序敏感：
 * 代码块/链接/行首结构 → URL → 路径 → 哈希 → 凭据 → 长数字 →
 * 噪音符号与不可读字符 → 空白归一 → 超长兜底线。
 */
export function sanitizeForSpeech(text: string): string {
  if (!text) return ''
  let out = text
    .replace(CODE_BLOCK, ' ')
    .replace(MD_LINK, (_match, label: string) => label || ' ')
    .replace(MD_LINE_LEAD, ' ')
    .replace(URLS, ' ')
    .replace(PATHS, ' ')
    .replace(HASHES, ' ')
    .replace(CREDENTIALS, ' ')
    .replace(LONG_DIGITS, ' ')
    .replace(NOISY_SYMBOLS, ' ')
    .replace(EMOJI, ' ')
    .replace(CONTROL_CHARS, ' ')
    .replace(STRIP_BLOCKS, ' ')
    .replace(BREAKS, ' ')
    .trim()
  out = out.replace(BREAKS, ' ').trim()
  return truncateCodePoints(out, 4000)
}

/** 净化并判断是否值得播报：空/纯噪音 → ''（调用方据此静默）。 */
export function sanitizeForSpeechOrEmpty(text: string): string {
  return sanitizeForSpeech(text)
}