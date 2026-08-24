import { describe, expect, it, vi } from 'vitest'
import { createVoicePrefetch } from '../src/server/prefetch.ts'
import { makeWav } from './host-test-utils.ts'

describe('voice prefetch', () => {
  it('成功终态绑定事件并复用后台合成结果', async () => {
    const wav = makeWav({ dataBytes: 24 })
    const synthesize = vi.fn(async () => wav)
    const prefetch = createVoicePrefetch({ synthesize })
    prefetch.prepare('s#1', '任务完成')
    expect(prefetch.peek('s#1')).toEqual({ text: '任务完成' })
    expect(prefetch.authorize('s#1', 'event-1')).toBe(true)
    await expect(prefetch.consume('event-1', '任务完成')).resolves.toBe(wav)
    await expect(prefetch.consume('event-1', '任务完成')).resolves.toBeUndefined()
    expect(synthesize).toHaveBeenCalledTimes(1)
  })

  it('中断丢弃会取消上游且不能再授权', async () => {
    let aborted = false
    const synthesize = vi.fn((_text: string, signal?: AbortSignal) => new Promise<Buffer>((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        aborted = true
        reject(new Error('aborted'))
      }, { once: true })
    }))
    const prefetch = createVoicePrefetch({ synthesize })
    prefetch.prepare('s#2', '不会播放')
    prefetch.discardTurn('s#2')
    await Promise.resolve()
    expect(aborted).toBe(true)
    expect(prefetch.authorize('s#2', 'event-2')).toBe(false)
  })

  it('同轮后一次准备替换并取消前一次', async () => {
    const signals: AbortSignal[] = []
    const wav = makeWav({})
    const synthesize = vi.fn((_text: string, signal?: AbortSignal) => {
      if (signal !== undefined) signals.push(signal)
      return Promise.resolve(wav)
    })
    const prefetch = createVoicePrefetch({ synthesize })
    prefetch.prepare('s#3', '旧文本')
    prefetch.prepare('s#3', '新文本')
    expect(signals[0]?.aborted).toBe(true)
    expect(prefetch.peek('s#3')).toEqual({ text: '新文本' })
  })

  it('文本不一致安全未命中并取消缓存', async () => {
    const controllerSeen: AbortSignal[] = []
    const synthesize = vi.fn(async (_text: string, signal?: AbortSignal) => {
      if (signal !== undefined) controllerSeen.push(signal)
      return makeWav({})
    })
    const prefetch = createVoicePrefetch({ synthesize })
    prefetch.prepare('s#4', '准备文本')
    prefetch.authorize('s#4', 'event-4')
    await expect(prefetch.consume('event-4', '不同文本')).resolves.toBeUndefined()
    expect(controllerSeen[0]?.aborted).toBe(true)
  })

  it('超出容量时淘汰并取消最旧轮次', () => {
    const signals: AbortSignal[] = []
    const synthesize = (_text: string, signal?: AbortSignal) => {
      if (signal !== undefined) signals.push(signal)
      return new Promise<Buffer>(() => undefined)
    }
    const prefetch = createVoicePrefetch({ synthesize }, 2)
    prefetch.prepare('s#1', '一')
    prefetch.prepare('s#2', '二')
    prefetch.prepare('s#3', '三')
    expect(signals[0]?.aborted).toBe(true)
    expect(prefetch.peek('s#1')).toBeUndefined()
    expect(prefetch.peek('s#3')).toEqual({ text: '三' })
    prefetch.dispose()
  })

  it('放行后超时会取消未消费音频，避免静音 drain 后长期占用内存', async () => {
    vi.useFakeTimers()
    try {
      let aborted = false
      const synthesize = (_text: string, signal?: AbortSignal) => new Promise<Buffer>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          aborted = true
          reject(new Error('expired'))
        }, { once: true })
      })
      const prefetch = createVoicePrefetch({ synthesize }, 2, 1_000, 50)
      prefetch.prepare('s#5', '会过期')
      prefetch.authorize('s#5', 'event-5')
      await vi.advanceTimersByTimeAsync(51)
      expect(aborted).toBe(true)
      await expect(prefetch.consume('event-5', '会过期')).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
