/** 客户端 JSON API 错误协议兼容测试。 */
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rollbackProfile } from '../src/client/api.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Profile mutation API', () => {
  it('识别顶层 errorCode/message，不把 HTTP 400 误报为 NETWORK', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      protocolVersion: 1,
      ok: false,
      errorCode: 'NO_PREVIOUS',
      message: '没有可回滚的上一版本',
      active: null,
    }), { status: 400, headers: { 'content-type': 'application/json' } }))

    await expect(rollbackProfile('tab-a')).resolves.toEqual({
      ok: false,
      code: 'NO_PREVIOUS',
      message: '没有可回滚的上一版本',
    })
  })
})
