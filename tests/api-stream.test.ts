/** 客户端流式 API 解析测试（Phase 3 §5.2）：NDJSON 增量 → WAV 段；错误行抛 VoiceStreamError。 */
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { VoiceStreamError, requestTtsStream } from '../src/client/api.ts'

function ndjsonResponse(lines: string[], status = 200): Response {
  const encoder = new TextEncoder()
  const chunks = lines.map(line => encoder.encode(`${line}\n`))
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  }), { status })
}

function wavBase64(fill: number, bytes: number): string {
  return Buffer.alloc(bytes, fill).toString('base64')
}

describe('requestTtsStream', () => {
  it('meta → audio 段 → end：按行 yield 完整小 WAV', async () => {
    const meta = JSON.stringify({ t: 'meta', format: 'pcm16', sampleRate: 24000, channels: 1 })
    const audio1 = JSON.stringify({ t: 'audio', s: 0, wav: wavBase64(1, 64) })
    const audio2 = JSON.stringify({ t: 'audio', s: 1, wav: wavBase64(2, 128) })
    const end = JSON.stringify({ t: 'end', chunks: 2 })
    const response = ndjsonResponse([meta, audio1, audio2, end])
    const fetchImpl = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
    try {
      const buffers: ArrayBuffer[] = []
      for await (const segment of requestTtsStream('你好', 'tab-a')) buffers.push(segment)
      expect(buffers).toHaveLength(2)
      expect(buffers[0].byteLength).toBe(64)
      expect(buffers[1].byteLength).toBe(128)
      expect(fetchImpl).toHaveBeenCalledWith(
        '/api/dsh-voice/tts/stream',
        expect.objectContaining({ method: 'POST' }),
      )
    } finally {
      fetchImpl.mockRestore()
    }
  })

  it('error 行 → throw VoiceStreamError（稳定 code）', async () => {
    const meta = JSON.stringify({ t: 'meta' })
    const error = JSON.stringify({ t: 'error', code: 'TTS_REJECTED', message: 'MiMo 流式请求失败（HTTP 429）' })
    const response = ndjsonResponse([meta, error])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
    try {
      const gen = requestTtsStream('x', 'tab-a')
      // 首个 next 即遇到 error 行 → 抛 VoiceStreamError（随后生成器终止）。
      const first = await gen.next().catch(error => error)
      expect(first).toBeInstanceOf(VoiceStreamError)
      expect(first).toMatchObject({ code: 'TTS_REJECTED' })
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('非 2xx → VoiceStreamError（解析错误体 code）', async () => {
    const response = new Response(JSON.stringify({ error: { code: 'NOT_LEADER', message: 'another tab owns' } }), { status: 409 })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
    try {
      await expect(requestTtsStream('x', 'tab-a').next()).rejects.toMatchObject({ code: 'NOT_LEADER' })
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('元数据行与噪音行被忽略；无 end 直接 EOF 也正常结束', async () => {
    const audio = JSON.stringify({ t: 'audio', s: 0, wav: wavBase64(3, 32) })
    const response = ndjsonResponse(['not-json', 'data: keepalive', audio])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
    try {
      const buffers: ArrayBuffer[] = []
      for await (const segment of requestTtsStream('x', 'tab-a')) buffers.push(segment)
      expect(buffers).toHaveLength(1)
      expect(buffers[0].byteLength).toBe(32)
    } finally {
      vi.restoreAllMocks()
    }
  })
})