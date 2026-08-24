/** 事件提取纯函数测试：@voice 标记规则、turn 过滤、失败话术、ask 提取、码点截断。 */
import { describe, expect, it } from 'vitest'
import {
  buildFailText,
  concatTextBlocks,
  extractAsk,
  extractDoneSpoken,
  findVoiceMarker,
  makeVoiceEvent,
  parseDirectionTags,
  sanitizeSpeechDirection,
  truncateCodePoints,
} from '../src/server/events.ts'

function msg(turn: number, text: string, interrupted?: true) {
  return {
    turn,
    message: { content: [{ type: 'text', text }] },
    ...(interrupted === undefined ? {} : { interrupted }),
  }
}

describe('truncateCodePoints', () => {
  it('按 code point 截断，不破坏 emoji/代理对', () => {
    const text = `好的😀${'啊'.repeat(20)}`
    const cut = truncateCodePoints(text, 5)
    expect(Array.from(cut).length).toBeLessThanOrEqual(5)
    expect(cut.startsWith('好的😀')).toBe(true)
    expect(cut.endsWith('…')).toBe(true)
  })

  it('短文本原样返回', () => {
    expect(truncateCodePoints('你好', 10)).toBe('你好')
  })
})

describe('findVoiceMarker', () => {
  it('只接受行首 @voice', () => {
    expect(findVoiceMarker('正文提到 @voice 不触发').found).toBe(false)
    expect(findVoiceMarker('@voiceover 也不触发').found).toBe(false)
    expect(findVoiceMarker('@voice 已经完成').spoken).toBe('已经完成')
  })

  it('支持中英文括号标签与冒号', () => {
    expect(findVoiceMarker('@voice（开心）已经完成了。').spoken).toBe('已经完成了。')
    expect(findVoiceMarker('@voice (笑) 搞定啦').spoken).toBe('搞定啦')
    expect(findVoiceMarker('@voice: 全部就绪').spoken).toBe('全部就绪')
    expect(findVoiceMarker('@voice：全部就绪').spoken).toBe('全部就绪')
  })

  it('空内容返回 found + 空串', () => {
    const result = findVoiceMarker('@voice   ')
    expect(result.found).toBe(true)
    expect(result.spoken).toBe('')
  })

  it('取最后一行的行首标记（多行文本）', () => {
    const text = '第一段说明\n@voice 收工了'
    // findVoiceMarker 扫描所有行；extractDoneSpoken 只取消息级判断。
    expect(findVoiceMarker(text).spoken).toBe('收工了')
  })
})

describe('speechDirection：@voice 标签解析（Phase 3）', () => {
  it('单个情绪标签映射为 direction，正文不变', () => {
    const result = findVoiceMarker('@voice（开心）已经完成了。')
    expect(result.direction).toEqual({ emotion: 'happy' })
    expect(result.spoken).toBe('已经完成了。')
  })

  it('英文括号 + 多标签（逗号/顿号分隔）', () => {
    const result = findVoiceMarker('@voice (开心,稍快) 全部就绪')
    expect(result.direction).toEqual({ emotion: 'happy', speed: 'fast' })
    expect(result.spoken).toBe('全部就绪')
  })

  it('最长匹配：语速很快 → fastest（不误切为 fast）', () => {
    expect(parseDirectionTags('语速很快')).toEqual({ speed: 'fastest' })
    expect(parseDirectionTags('很快')).toEqual({ speed: 'fastest' })
  })

  it('音量倾向标签 → loudness', () => {
    expect(parseDirectionTags('轻声')).toEqual({ loudness: 'quiet' })
    expect(parseDirectionTags('大声，严肃')).toEqual({ loudness: 'loud', emotion: 'serious' })
  })

  it('未识别标签静默丢弃，不带 direction，正文不受影响（向后兼容）', () => {
    const result = findVoiceMarker('@voice (笑) 搞定啦')
    expect(result.direction).toBeUndefined()
    expect(result.spoken).toBe('搞定啦')
    expect(result.found).toBe(true)
  })

  it('混合识别与丢弃：只保留识别的字段', () => {
    const result = findVoiceMarker('@voice (开心 神秘 慢) 好的')
    expect(result.direction).toEqual({ emotion: 'happy', speed: 'slow' })
  })
})

describe('sanitizeSpeechDirection（Phase 3 协议校验）', () => {
  it('合法枚举与字段通过', () => {
    expect(sanitizeSpeechDirection({ emotion: 'calm', speed: 'normal', loudness: 'quiet', role: '四川话', director: '声音放软一点' }))
      .toEqual({ emotion: 'calm', speed: 'normal', loudness: 'quiet', role: '四川话', director: '声音放软一点' })
  })

  it('枚举外值 / 错误类型 / 非对象一律丢弃', () => {
    expect(sanitizeSpeechDirection({ emotion: 'screaming' })).toBeUndefined()
    expect(sanitizeSpeechDirection({ speed: 3 })).toBeUndefined()
    expect(sanitizeSpeechDirection('happy')).toBeUndefined()
    expect(sanitizeSpeechDirection(null)).toBeUndefined()
    expect(sanitizeSpeechDirection({ emotion: 'happy', unknownField: 'x' })).toEqual({ emotion: 'happy' })
  })

  it('role/director 按 code point 截断', () => {
    const direction = sanitizeSpeechDirection({ role: '很'.repeat(60), director: '长'.repeat(100) })
    expect(direction?.role).toHaveLength(40)
    expect(direction?.director).toHaveLength(80)
  })

  it('空白 role/director 不产生字段', () => {
    expect(sanitizeSpeechDirection({ role: '   ' })).toBeUndefined()
  })
})

describe('makeVoiceEvent / extractDoneSpoken 携带 speechDirection（Phase 3）', () => {
  it('makeVoiceEvent 透传 direction', () => {
    const event = makeVoiceEvent({
      id: 'e1', kind: 'done', text: '好了', createdAt: 1, sourceKey: 'k',
      speechDirection: { emotion: 'calm' },
    })
    expect(event.speechDirection).toEqual({ emotion: 'calm' })
    expect(event.priority).toBe(2)
  })

  it('extractDoneSpoken 从 @voice（情绪）提取 direction', () => {
    const result = extractDoneSpoken([msg(2, '@voice（疲惫）终于弄完了')], 2, 150)
    expect(result.silent).toBe(false)
    if (!result.silent) {
      expect(result.text).toBe('终于弄完了')
      expect(result.direction).toEqual({ emotion: 'tired' })
    }
  })

  it('不带标签时 direction 不出现', () => {
    const result = extractDoneSpoken([msg(2, '@voice 完成了')], 2, 150)
    expect(result.silent).toBe(false)
    if (!result.silent) expect(result.direction).toBeUndefined()
  })
})

describe('extractDoneSpoken', () => {
  it('同 turn 的最后一条未中断消息提取成功', () => {
    const result = extractDoneSpoken([msg(1, '@voice 旧一轮'), msg(2, '正文'), msg(2, '@voice 新一轮完成')], 2, 150)
    expect(result.silent).toBe(false)
    if (!result.silent) expect(result.text).toBe('新一轮完成')
  })

  it('旧 turn 的 marker 不触发', () => {
    const result = extractDoneSpoken([msg(1, '@voice 历史')], 2, 150)
    expect(result.silent).toBe(true)
  })

  it('中断消息不触发', () => {
    const result = extractDoneSpoken([msg(2, '@voice 被打断', true)], 2, 150)
    expect(result.silent).toBe(true)
  })

  it('空 marker 静默', () => {
    const result = extractDoneSpoken([msg(2, '@voice ')], 2, 150)
    expect(result.silent).toBe(true)
  })

  it('无 marker 静默', () => {
    const result = extractDoneSpoken([msg(2, '普通回复')], 2, 150)
    expect(result.silent).toBe(true)
  })

  it('超长播报词按码点截断', () => {
    const long = `@voice ${'好'.repeat(200)}`
    const result = extractDoneSpoken([msg(2, long)], 2, 150)
    expect(!result.silent && Array.from(result.text).length).toBe(150)
  })
})

describe('buildFailText', () => {
  it('固定话术不携带宿主错误内容', () => {
    const text = buildFailText()
    expect(text).toContain('老三，刚才出了点状况')
    expect(text).not.toContain('secret')
    expect(text).not.toContain('private')
    expect(text).not.toContain('E_UNKNOWN')
    expect(text.length).toBeLessThan(80)
  })

})

describe('extractAsk', () => {
  it('识别 ask_user_question 第一个 question 并截断', () => {
    const ask = extractAsk({
      name: 'ask_user_question',
      callId: 'call-1',
      arguments: { questions: [{ id: 'q1', question: '要继续吗？' }, { id: 'q2', question: '第二个' }] },
    }, 80)
    expect(ask?.text).toBe('要继续吗？')
    expect(ask?.sourceKey).toBe('call-1|ask')
  })

  it('非提问工具返回 undefined；空问题返回 undefined', () => {
    expect(extractAsk({ name: 'other', callId: 'c', arguments: {} }, 80)).toBeUndefined()
    expect(extractAsk({ name: 'ask_user_question', callId: 'c', arguments: { questions: [] } }, 80)).toBeUndefined()
  })
})

describe('makeVoiceEvent / concatTextBlocks', () => {
  it('事件携带正确优先级', () => {
    expect(makeVoiceEvent({ id: 'i', kind: 'ask', text: 't', createdAt: 1, sourceKey: 's' }).priority).toBe(3)
    expect(makeVoiceEvent({ id: 'i', kind: 'done', text: 't', createdAt: 1, sourceKey: 's' }).priority).toBe(2)
    expect(makeVoiceEvent({ id: 'i', kind: 'fail', text: 't', createdAt: 1, sourceKey: 's' }).priority).toBe(1)
    expect(makeVoiceEvent({ id: 'i', kind: 'manual', text: 't', createdAt: 1, sourceKey: 's' }).priority).toBe(2)
  })

  it('拼接多个 text block', () => {
    const text = concatTextBlocks([{ type: 'text', text: 'a' }, { type: 'tool', text: 'x' }, { type: 'text', text: 'b' }])
    expect(text).toBe('a\nb\n')
  })
})
