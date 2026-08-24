/** 安全分句测试（Phase 3 §5.3）：中文句末、英文缩写/小数/省略号、引号组合。 */
import { describe, expect, it } from 'vitest'
import { splitSentences } from '../src/shared/split.ts'

describe('splitSentences', () => {
  it('中文句末标点切句，空句子丢弃', () => {
    expect(splitSentences('你好。这是第二句！第三句？')).toEqual(['你好。', '这是第二句！', '第三句？'])
    expect(splitSentences('第一句；第二句；')).toEqual(['第一句；', '第二句；'])
  })

  it('连续省略号整体不切', () => {
    expect(splitSentences('我想想……好的。')).toEqual(['我想想……', '好的。'])
    expect(splitSentences('嗯...然后呢')).toEqual(['嗯...', '然后呢'])
  })

  it('带右引号的句末标点并入同一句', () => {
    expect(splitSentences('他说“好的。”走了。')).toEqual(['他说“好的。”', '走了。'])
  })

  it('英文小数与版本号不切', () => {
    expect(splitSentences('圆周率是 3.14。')).toEqual(['圆周率是 3.14。'])
    expect(splitSentences('版本 v2.5 已发布')).toEqual(['版本 v2.5 已发布'])
  })

  it('英文缩写与缩略词不切；真正的英文句点切句', () => {
    expect(splitSentences('Mr. Smith arrived. Next story.')).toEqual(['Mr. Smith arrived.', 'Next story.'])
    expect(splitSentences('U.S. 总统当选。')).toEqual(['U.S. 总统当选。'])
    expect(splitSentences('a.m. 和 p.m. 都支持。')).toEqual(['a.m. 和 p.m. 都支持。'])
    expect(splitSentences('Hello world. It works!')).toEqual(['Hello world.', 'It works!'])
  })

  it('单句原样返回单元素（无标点）', () => {
    expect(splitSentences('只此一句')).toEqual(['只此一句'])
    expect(splitSentences('')).toEqual([])
    expect(splitSentences('   ')).toEqual([])
  })

  it('长文本按句切分后拼接等于原文（非空相接）', () => {
    const text = '首先说明背景。然后给出结论！最后补充一句问号？收尾。'
    const parts = splitSentences(text)
    expect(parts.length).toBe(4)
    expect(parts.join('')).toBe(text)
  })
})