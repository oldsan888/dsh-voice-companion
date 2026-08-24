/** 播报文本净化测试（Phase 3 §8.2）：Markdown/URL/路径/哈希/凭据/长数字/符号。 */
import { describe, expect, it } from 'vitest'
import { sanitizeForSpeech } from '../src/server/sanitize.ts'

describe('sanitizeForSpeech', () => {
  it('保留正常中文/英文正文', () => {
    expect(sanitizeForSpeech('你好，任务已经全部完成。')).toBe('你好，任务已经全部完成。')
    expect(sanitizeForSpeech('DSH 正在处理你的请求，请稍候。')).toBe('DSH 正在处理你的请求，请稍候。')
  })

  it('清除 Markdown：标题/列表/引用/分隔线/链接', () => {
    expect(sanitizeForSpeech('# 标题\n正文')).toBe('正文')
    expect(sanitizeForSpeech('- 列表项一\n- 列表项二')).toBe('列表项一 列表项二')
    expect(sanitizeForSpeech('> 引用内容')).toBe('引用内容')
    expect(sanitizeForSpeech('[点这里](https://example.com/x)')).toBe('点这里')
    expect(sanitizeForSpeech('---')).toBe('')
  })

  it('清除代码块与行内代码', () => {
    expect(sanitizeForSpeech('看这段：```js\nconst x = 1\n```')).toBe('看这段：')
    expect(sanitizeForSpeech('运行 `npm install` 即可')).toBe('运行 即可')
  })

  it('清除 URL 与文件路径（Windows/Unix）', () => {
    expect(sanitizeForSpeech('详情见 https://docs.example.com/v2')).toBe('详情见')
    expect(sanitizeForSpeech('文件在 C:\\Users\\me\\secret\\report.txt 里')).toBe('文件在 里')
    expect(sanitizeForSpeech('路径 /home/user/project/readme.md 已更新')).toBe('路径 已更新')
  })

  it('清除长哈希与超长数字', () => {
    expect(sanitizeForSpeech('提交 a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0')).toBe('提交')
    expect(sanitizeForSpeech('订单号 12345678901234567890 已处理')).toBe('订单号 已处理')
  })

  it('清除凭据形态（sk- / api_key= / Bearer）', () => {
    expect(sanitizeForSpeech('使用 sk-abc123def456ghi789 完成')).toBe('使用 完成')
    expect(sanitizeForSpeech('api_key=SECRET_VALUE 已配置')).toBe('已配置')
    expect(sanitizeForSpeech('Bearer eyJhbGciOiJIUzI1NiJ9.xyz 认证成功')).toBe('认证成功')
  })

  it('清除 emoji/控制符/噪音符号，不误伤口语标点', () => {
    expect(sanitizeForSpeech('搞定啦 🎉')).toBe('搞定啦')
    expect(sanitizeForSpeech('curl https://x/y | grep a`b`')).toBe('curl grep a')
    expect(sanitizeForSpeech('检查 `|` 与 \\ 残留')).toBe('检查 与 残留')
  })

  it('空/纯噪音 → 空串', () => {
    expect(sanitizeForSpeech('')).toBe('')
    expect(sanitizeForSpeech('   ')).toBe('')
    expect(sanitizeForSpeech('```\n```')).toBe('')
  })

  it('净化输出不含 Markdown/URL/路径原文', () => {
    const out = sanitizeForSpeech('# 标题 [链接](https://example.com) 路径 C:\\a\\b code `x=1` sk-abc123')
    expect(out).not.toContain('https://')
    expect(out).not.toContain('C:\\')
    expect(out).not.toContain('`')
    expect(out).not.toContain('#')
    expect(out).not.toContain('sk-')
  })

  it('超长净化稿按 code point 兜底截断（4000）', () => {
    const long = sanitizeForSpeech(`${'好'.repeat(10000)}`)
    expect(Array.from(long).length).toBe(4000)
  })
})