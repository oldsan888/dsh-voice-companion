/**
 * 安全分句（Phase 3 §5.3）：把一段播报稿切成适合逐句合成的句子。
 * Host/Client 共用（纯函数，无 IO）。
 *
 * 规则：
 * - 中文句末（。！？；… 及其带右引号的组合）切分；
 * - 英文句点只在不属于数字/缩写/缩略词时切分：
 *   小数（3.14）、版本（v2.5）、缩写（e.g. / U.S. / Mr.）、句子内连续字母（U.S.A.）不断；
 * - 连续省略号（…… 或 ...）整体作为句末；
 * - 空句子丢弃；每句 trim。
 *
 * 分句粒度只影响合成/播放流水线的粒度：误分是最小伤害（多一次往返），
 * 因此宁可多切、不可吞句。单句文本原样返回单元素数组。
 */

/** 英文常见缩写/术语（句点后不切）。 */
const NO_BREAK_ABBREV = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'vs', 'etc', 'e.g', 'i.e',
  'u.s', 'u.k', 'u.n', 'a.m', 'p.m', 'no', 'fig', 'vol', 'inc', 'ltd',
])

/** 中文句末标点（含省略号单字符）。 */
const CJK_END = new Set(['。', '！', '？', '；', '…'])

function isCjkCodePoint(s: string): boolean {
  const code = s.codePointAt(0) ?? 0
  return (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0x3040 && code <= 0x30ff)
}

export function splitSentences(text: string): string[] {
  if (!text) return []
  const sentences: string[] = []
  let buf = ''
  let prev = ''
  let i = 0
  const push = (): void => {
    const t = buf.trim()
    if (t) sentences.push(t)
    buf = ''
  }
  while (i < text.length) {
    const ch = text[i]
    // 下一个字符（代理对时取完整字符）。
    const next = i + 1 < text.length ? text[i + 1] : ''
    if (CJK_END.has(ch)) {
      buf += ch
      let consumed = i + 1
      // 连续省略号整体：…… 不逐字符切。
      if (ch === '…') {
        while (consumed < text.length && text[consumed] === '…') {
          buf += text[consumed]
          consumed++
        }
      } else if ((ch === '。' || ch === '！' || ch === '？') && (text[consumed] === '”' || text[consumed] === '」' || text[consumed] === '』')) {
        buf += text[consumed]
        consumed++
      }
      push()
      prev = ''
      i = consumed
      continue
    }
    if (ch === '.') {
      const prevChar = prev
      const nextChar = next
      // 英文省略号 ...：整体作为句末。
      if (nextChar === '.') {
        buf += ch
        let k = i + 1
        while (k < text.length && text[k] === '.') {
          buf += text[k]
          k++
        }
        push()
        prev = ''
        i = k
        continue
      }
      const isDigitBefore = /[0-9]/.test(prevChar)
      const isDigitAfter = /[0-9]/.test(nextChar)
      // 小数/版本号：数字两侧 → 不切。
      if (isDigitBefore && isDigitAfter) {
        buf += ch
        i++
        prev = ch
        continue
      }
      // 缩略词（e.g. / U.S.）：前字母 + 后紧跟字母/数字 → 不切。
      if (/[A-Za-z]/.test(prevChar) && /[A-Za-z0-9]/.test(nextChar)) {
        buf += ch
        i++
        prev = ch
        continue
      }
      // 已知缩写 + 空格：Mr. Smith / U.S. 总统 → 不切。
      if (/[A-Za-z]/.test(prevChar) && nextChar === ' ') {
        const token = buf.match(/([A-Za-z.]+)$/)?.[0] ?? ''
        if (NO_BREAK_ABBREV.has(token.trim().toLowerCase())) {
          buf += ch
          i++
          prev = ch
          continue
        }
      }
      // 其余情况：英文句点作句末（. 后跟空格+大写 / 中文 / 引号 / 结尾）。
      buf += ch
      push()
      i++
      prev = ch
      continue
    }
    buf += ch
    prev = ch
    i++
  }
  push()
  return sentences
}