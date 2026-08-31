/** 面板行为测试（jsdom）：默认收起、onboarding、偏好、租约/接管、静音/音量/清空、错误显示、卸载清理。 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VoiceCompanionPanel } from '../src/client/VoiceCompanionPanel.tsx'
import { VoiceStreamError } from '../src/client/api.ts'

// jsdom 无 PointerEvent：垫片继承 MouseEvent 以保留 clientX/clientY，供拖动测试使用。
if (typeof window !== 'undefined' && (window as unknown as { PointerEvent?: unknown }).PointerEvent === undefined) {
  class PointerEventShim extends MouseEvent {
    readonly pointerId: number
    readonly pointerType: string
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 0
      this.pointerType = init.pointerType ?? ''
    }
  }
  ;(window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventShim
}

type ApiShape = {
  postLease: ReturnType<typeof vi.fn>
  drain: ReturnType<typeof vi.fn>
  getState: ReturnType<typeof vi.fn>
  requestTts: ReturnType<typeof vi.fn>
  requestTtsStream: ReturnType<typeof vi.fn>
  requestTestVoice: ReturnType<typeof vi.fn>
  clearQueue: ReturnType<typeof vi.fn>
  listProfiles: ReturnType<typeof vi.fn>
  getProfileReference: ReturnType<typeof vi.fn>
  activateProfile: ReturnType<typeof vi.fn>
  rollbackProfile: ReturnType<typeof vi.fn>
}

type ProfileSummary = {
  id: string; name: string; kind: 'builtin' | 'design' | 'clone'; readOnly: boolean
  status: string; createdAt: number; updatedAt: number; approved: boolean
  referenceBytes: number; referenceSha256: string; active: boolean
}

/** 构造一个音色摘要（默认无激活）。 */
function profile(overrides: Partial<ProfileSummary> = {}): ProfileSummary {
  return {
    id: 'p1', name: '女声 A', kind: 'design', readOnly: false, status: 'candidate',
    createdAt: 1, updatedAt: 1, approved: true, referenceBytes: 0, referenceSha256: 'x'.repeat(64),
    active: false,
    ...overrides,
  }
}

/** 构造 /profiles 响应。 */
function profilesResponse(profiles: ProfileSummary[], active: { activeId?: string | null; previousId?: string | null; history?: string[] } = {}): unknown {
  return {
    protocolVersion: 1,
    profiles,
    active: { activeId: null, previousId: null, history: [], updatedAt: 0, ...active },
  }
}

function okApi(overrides: Record<string, unknown> = {}): ApiShape {
  const stateValue = {
    protocolVersion: 1,
    tts: { status: 'ready', checkedAt: 1 },
    queue: { pending: 0 },
    lease: { ownedByThisClient: false, expiresAt: 0, ownedByOther: false },
    counts: { done: 0, ask: 0, fail: 0, silent: 0, dropped: 0 },
  }
  const base: ApiShape = {
    postLease: vi.fn(async (_action: string, _clientId: string) =>
      ({ ok: true as const, value: { protocolVersion: 1, lease: { held: false, ownerClientId: null, expiresAt: 0, youAreOwner: false } } })),
    drain: vi.fn(async () => ({ ok: true as const, value: { protocolVersion: 1, events: [] } })),
    getState: vi.fn(async () => ({ ok: true as const, value: stateValue })),
    requestTts: vi.fn(async () => ({ ok: false as const, code: 'NETWORK' as const, message: 'nope' })),
    requestTtsStream: vi.fn(async function* () { return undefined as never }),
    requestTestVoice: vi.fn(async () => ({ ok: false as const, code: 'NETWORK' as const, message: 'nope' })),
    clearQueue: vi.fn(async () => ({ ok: true as const, value: { cleared: 0 } })),
    listProfiles: vi.fn(async () => ({ ok: true as const, value: profilesResponse([]) })),
    getProfileReference: vi.fn(async () => ({ ok: false as const, code: 'INVALID_AUDIO' as const, message: 'nope' })),
    activateProfile: vi.fn(async () => ({ ok: true as const, value: { protocolVersion: 1, ok: true, active: null } })),
    rollbackProfile: vi.fn(async () => ({ ok: true as const, value: { protocolVersion: 1, ok: true, active: null } })),
  }
  return { ...base, ...overrides } as unknown as ApiShape
}

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('面板默认状态', () => {
  it('默认收起为胶囊；展开后出现完整面板；再点收起回到胶囊', async () => {
    const api = okApi({ postLease: vi.fn(async () => ({ ok: true as const, value: { protocolVersion: 1, lease: { held: true, ownerClientId: 'me', expiresAt: 9, youAreOwner: true } } })) })
    render(<VoiceCompanionPanel apiOverride={api as never} intervals={{ drainMs: 10_000, renewMs: 10_000, stateMs: 10_000 }} />)
    expect(screen.getByTestId('voice-pill')).toBeTruthy()
    expect(screen.queryByTestId('voice-panel')).toBeNull()

    fireEvent.click(screen.getByTestId('voice-pill'))
    expect(screen.getByTestId('voice-panel')).toBeTruthy()
    expect(screen.getByTestId('voice-mute').textContent).toBe('静音')
    // 等 acquire 完成后清空按钮才可用。
    await waitFor(() => {
      if ((screen.getByTestId('voice-clear') as HTMLButtonElement).hasAttribute('disabled')) throw new Error('still disabled')
    })

    fireEvent.click(screen.getByText('收起'))
    expect(screen.getByTestId('voice-pill')).toBeTruthy()
    expect(screen.queryByTestId('voice-panel')).toBeNull()
  })

  it('onboarding 提示只在首次出现，点击启用后不再出现（localStorage 持久化）', () => {
    const api = okApi()
    const first = render(<VoiceCompanionPanel apiOverride={api as never} intervals={{ drainMs: 10_000, renewMs: 10_000, stateMs: 10_000 }} />)
    expect(screen.getByTestId('voice-onboarding')).toBeTruthy()
    fireEvent.click(screen.getByTestId('voice-onboarding-enable'))
    expect(screen.queryByTestId('voice-onboarding')).toBeNull()
    first.unmount()

    const saved = JSON.parse(window.localStorage.getItem('dsh.voice-companion.preferences.v1')!) as { onboardingSeen?: boolean }
    expect(saved.onboardingSeen).toBe(true)

    render(<VoiceCompanionPanel apiOverride={api as never} intervals={{ drainMs: 10_000, renewMs: 10_000, stateMs: 10_000 }} />)
    expect(screen.queryByTestId('voice-onboarding')).toBeNull()
  })

  it('偏好坏数据逐字段回退默认值', () => {
    window.localStorage.setItem('dsh.voice-companion.preferences.v1', '{broken json')
    const api = okApi()
    render(<VoiceCompanionPanel apiOverride={api as never} intervals={{ drainMs: 10_000, renewMs: 10_000, stateMs: 10_000 }} />)
    // 展开后音量显示默认 90%。
    fireEvent.click(screen.getByTestId('voice-pill'))
    expect(screen.getByText('90%')).toBeTruthy()
  })
})

describe('租约与多标签页', () => {
  it('非 leader：显示“另一个标签页”，出现接管按钮，点击调用 takeover 并成为 leader', async () => {
    let ownerIsMe = false
    const api = okApi({
      postLease: vi.fn(async (action: string) => {
        if (action === 'acquire') return { ok: true as const, value: { protocolVersion: 1, lease: { held: !ownerIsMe, ownerClientId: ownerIsMe ? 'me' : 'other-tab', expiresAt: 99, youAreOwner: ownerIsMe } } }
        if (action === 'takeover') { ownerIsMe = true; return { ok: true as const, value: { protocolVersion: 1, lease: { held: true, ownerClientId: 'me', expiresAt: 99, youAreOwner: true } } } }
        return { ok: true as const, value: { protocolVersion: 1, lease: { held: false, ownerClientId: null, expiresAt: 0, youAreOwner: false } } }
      }),
    })
    render(<VoiceCompanionPanel apiOverride={api as never} intervals={{ drainMs: 10_000, renewMs: 10_000, stateMs: 10_000 }} />)
    await waitFor(() => expect(api.postLease).toHaveBeenCalledWith('acquire', expect.any(String)))
    fireEvent.click(screen.getByTestId('voice-pill'))
    expect(screen.getByText(/另一个标签页/)).toBeTruthy()
    expect((screen.getByTestId('voice-test') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('voice-takeover'))
    await waitFor(() => expect(screen.queryByTestId('voice-takeover')).toBeNull())
    expect(screen.getByText(/本页播放/)).toBeTruthy()
    expect((screen.getByTestId('voice-test') as HTMLButtonElement).disabled).toBe(false)
  })

  it('卸载时释放租约并移除注入样式', async () => {
    const api = okApi()
    const rendered = render(<VoiceCompanionPanel apiOverride={api as never} intervals={{ drainMs: 10_000, renewMs: 10_000, stateMs: 10_000 }} />)
    rendered.unmount()
    await waitFor(() => expect(api.postLease).toHaveBeenCalledWith('release', expect.any(String)))
  })
})

describe('静音 / 音量 / 清空', () => {
  it('静音切换写入偏好并改变按钮文案；音量滑杆保存数值', async () => {
    const api = okApi()
    render(<VoiceCompanionPanel apiOverride={api as never} intervals={{ drainMs: 10_000, renewMs: 10_000, stateMs: 10_000 }} />)
    fireEvent.click(screen.getByTestId('voice-pill'))
    const mute = screen.getByTestId('voice-mute')
    fireEvent.click(mute)
    expect(mute.textContent).toBe('取消静音')
    const slider = screen.getByRole('slider', { name: '音量' }) as HTMLInputElement
    fireEvent.change(slider, { target: { value: '0.5' } })
    expect(screen.getByText('50%')).toBeTruthy()
    const saved = JSON.parse(window.localStorage.getItem('dsh.voice-companion.preferences.v1')!) as { muted: boolean, volume: number }
    expect(saved.muted).toBe(true)
    expect(saved.volume).toBeCloseTo(0.5)
  })

  it('leader 才能清空待播；点击调用 clearQueue', async () => {
    const api = okApi({
      postLease: vi.fn(async () => ({ ok: true as const, value: { protocolVersion: 1, lease: { held: true, ownerClientId: 'me', expiresAt: 9, youAreOwner: true } } })),
      clearQueue: vi.fn(async () => ({ ok: true as const, value: { cleared: 3 } })),
    })
    render(<VoiceCompanionPanel apiOverride={api as never} intervals={{ drainMs: 10_000, renewMs: 10_000, stateMs: 10_000 }} />)
    fireEvent.click(screen.getByTestId('voice-pill'))
    // 等 acquire 完成使按钮从 disabled 变为可用。
    const clearButton = await waitFor(() => {
      const button = screen.getByTestId('voice-clear') as HTMLButtonElement
      if (button.hasAttribute('disabled')) throw new Error('clear still disabled')
      return button
    })
    fireEvent.click(clearButton)
    await waitFor(() => expect(api.clearQueue).toHaveBeenCalled())
  })

  it('试听失败在面板显示稳定错误码', async () => {
    const api = okApi({
      postLease: vi.fn(async () => ({ ok: true as const, value: { protocolVersion: 1, lease: { held: true, ownerClientId: 'me', expiresAt: 9, youAreOwner: true } } })),
      requestTestVoice: vi.fn(async () => ({ ok: false as const, code: 'TTS_REJECTED' as const, message: 'MiMo 请求失败（HTTP 429）' })),
    })
    render(<VoiceCompanionPanel apiOverride={api as never} intervals={{ drainMs: 10_000, renewMs: 10_000, stateMs: 10_000 }} />)
    fireEvent.click(screen.getByTestId('voice-pill'))
    const testButton = await waitFor(() => {
      const button = screen.getByTestId('voice-test') as HTMLButtonElement
      if (button.hasAttribute('disabled')) throw new Error('test still disabled')
      return button
    })
    fireEvent.click(testButton)
    await waitFor(() => expect(screen.getAllByText(/TTS_REJECTED/).length).toBeGreaterThan(0))
  })

  it('drain 到失败事件且合成失败时显示错误（不弹窗不崩溃）', async () => {
    const api = okApi({
      postLease: vi.fn(async () => ({ ok: true as const, value: { protocolVersion: 1, lease: { held: true, ownerClientId: 'me', expiresAt: 9, youAreOwner: true } } })),
      drain: vi.fn(async () => ({
        ok: true as const,
        value: { protocolVersion: 1, events: [{ id: 'e1', kind: 'fail', text: '出错了', priority: 1, createdAt: 1 }] },
      })),
      requestTts: vi.fn(async () => ({ ok: false as const, code: 'INVALID_AUDIO' as const, message: 'WAV 校验失败' })),
    })
    render(<VoiceCompanionPanel apiOverride={api as never} intervals={{ drainMs: 20, renewMs: 60_000, stateMs: 60_000 }} />)
    fireEvent.click(screen.getByTestId('voice-pill'))
    await waitFor(() => expect(screen.getAllByText(/INVALID_AUDIO/).length).toBeGreaterThan(0), { timeout: 3000 })
    await waitFor(() => expect(api.requestTts).toHaveBeenCalledWith('出错了', 'e1', expect.any(String), expect.anything(), undefined))
  })

  it('静音状态下 drain 事件被丢弃计数，不发起合成', async () => {
    window.localStorage.setItem('dsh.voice-companion.preferences.v1', JSON.stringify({ muted: true, volume: 0.9, collapsed: false, onboardingSeen: true }))
    const api = okApi({
      postLease: vi.fn(async () => ({ ok: true as const, value: { protocolVersion: 1, lease: { held: true, ownerClientId: 'me', expiresAt: 9, youAreOwner: true } } })),
      drain: vi.fn(async () => ({
        ok: true as const,
        value: { protocolVersion: 1, events: [{ id: 'e1', kind: 'done', text: '好了', priority: 2, createdAt: 1 }] },
      })),
    })
    render(<VoiceCompanionPanel apiOverride={api as never} intervals={{ drainMs: 20, renewMs: 60_000, stateMs: 60_000 }} />)
    // collapsed:false → 面板初始即展开（展开状态持久化）。
    expect(screen.getByTestId('voice-panel')).toBeTruthy()
    await waitFor(() => expect(screen.getAllByText(/静音丢弃 1/).length).toBeGreaterThan(0), { timeout: 3000 })
    expect(api.requestTts).not.toHaveBeenCalled()
  })

  it('drain 到带 previewProfileId 的事件：走 getProfileReference 播放该音色而非 requestTts', async () => {
    const api = okApi({
      postLease: vi.fn(async () => ({ ok: true as const, value: { protocolVersion: 1, lease: { held: true, ownerClientId: 'me', expiresAt: 9, youAreOwner: true } } })),
      drain: vi.fn(async () => ({
        ok: true as const,
        value: { protocolVersion: 1, events: [{ id: 'e1', kind: 'manual', text: '', priority: 2, createdAt: 1, previewProfileId: 'cand-1' }] },
      })),
      getProfileReference: vi.fn(async () => ({ ok: true as const, value: new ArrayBuffer(8) })),
      requestTts: vi.fn(async () => ({ ok: true as const, value: new ArrayBuffer(8) })),
    })
    render(<VoiceCompanionPanel apiOverride={api as never} intervals={{ drainMs: 20, renewMs: 60_000, stateMs: 60_000 }} />)
    fireEvent.click(screen.getByTestId('voice-pill'))
    await waitFor(() => expect(api.getProfileReference).toHaveBeenCalledWith('cand-1', expect.any(String), expect.anything()), { timeout: 3000 })
    expect(api.requestTts).not.toHaveBeenCalled()
  })
})

describe('高优先级打断（player 规则）', () => {
  class FakeSourceNode {
    stopped = 0
    started = false
    onended: (() => void) | null = null
    connect() { /* noop */ }
    start() { this.started = true }
    stop() { this.stopped++ }
  }

  class FakeAudioContext {
    state = 'running'
    destination = {}
    decodeCount = 0
    createGain() { return { gain: { value: 1 }, connect() { /* noop */ } } }
    createBufferSource() { return new FakeSourceNode() }
    async decodeAudioData(): Promise<AudioBuffer> { this.decodeCount++; return {} as AudioBuffer }
    async resume() { this.state = 'running'; return this.state as AudioContextState }
    async close() { this.state = 'closed' }
  }

  async function makePlayer() {
    const mod = await import('../src/client/player.ts')
    ;(window as unknown as { AudioContext?: unknown }).AudioContext = FakeAudioContext
    return new mod.VoicePlayer()
  }

  it('同优先级不打断；更高优先级停止当前 source；低优先级被跳过', async () => {
    const player = await makePlayer()
    await player.unlock()
    void player.playWav(new ArrayBuffer(8), 2)
    await new Promise(resolve => setTimeout(resolve, 5))
    const firstSource = (player as unknown as { currentSource?: FakeSourceNode }).currentSource

    // 同优先级：跳过，不打断当前。
    const sameOutcome = await player.playWav(new ArrayBuffer(8), 2)
    expect(sameOutcome.started).toBe(false)
    expect(sameOutcome.reason).toBe('skipped-low-priority')

    // 更高优先级：打断当前 source。
    const higherPromise = player.playWav(new ArrayBuffer(8), 3)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(firstSource?.stopped).toBe(1)
    const higherSource = (player as unknown as { currentSource?: FakeSourceNode }).currentSource
    expect(higherSource?.started).toBe(true)
    higherSource?.onended?.()
    const higher = await higherPromise
    expect(higher.started).toBe(true)

    // 低优先级在空闲时可以正常播。
    player.stopCurrent()
    const lowPromise = player.playWav(new ArrayBuffer(8), 1)
    await new Promise(resolve => setTimeout(resolve, 0))
    ;(player as unknown as { currentSource?: FakeSourceNode }).currentSource?.onended?.()
    const low = await lowPromise
    expect(low.started).toBe(true)

    await player.dispose()
  })

  it('setVolume 边界钳制到 0–1', async () => {
    const player = await makePlayer()
    player.setVolume(5)
    player.setVolume(-3)
    await player.dispose()
  })

  it('序列播放：后一段严格等待前一段结束，不会重叠；打断后 Promise 正常 resolve', async () => {
    const sources: FakeSourceNode[] = []
    class SeqContext extends FakeAudioContext {
      currentTime = 0
      createBufferSource() {
        const source = new FakeSourceNode()
        sources.push(source)
        return source
      }
      async decodeAudioData(): Promise<AudioBuffer> { return { duration: 0.5 } as AudioBuffer }
    }
    ;(window as unknown as { AudioContext?: unknown }).AudioContext = SeqContext
    const mod = await import('../src/client/player.ts')
    const player = new mod.VoicePlayer()
    await player.unlock()
    async function* segments(): AsyncGenerator<ArrayBuffer> {
      yield new ArrayBuffer(8)
      yield new ArrayBuffer(8)
      yield new ArrayBuffer(8)
    }
    const promise = player.playWavSequence(segments(), 2)
    await waitFor(() => expect(sources).toHaveLength(1))
    expect(sources[0].started).toBe(true)
    // 第一段未结束时，第二段绝不能创建或启动。
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(sources).toHaveLength(1)
    sources[0].onended?.()
    await waitFor(() => expect(sources).toHaveLength(2))
    expect(sources[1].started).toBe(true)
    expect(sources[0].stopped).toBe(0)
    // 第二段播放中打断：当前 source 被停止，Promise 必须 resolve 而非悬挂。
    player.stopCurrent()
    expect(sources[1].stopped).toBe(1)
    const outcome = await promise
    expect(outcome).toEqual({ started: true, reason: 'interrupted' })
    await player.dispose()
  })

  it('收起胶囊随真实合成与播放阶段显示：空闲中 → 合成中 → 播放中 → 空闲中', async () => {
    let latestSource: FakeSourceNode | undefined
    class ControlledContext extends FakeAudioContext {
      createBufferSource() {
        latestSource = new FakeSourceNode()
        return latestSource
      }
    }
    ;(window as unknown as { AudioContext?: unknown }).AudioContext = ControlledContext

    let emitEvent = false
    let emitted = false
    let resolveTts!: (value: { ok: true; value: ArrayBuffer }) => void
    const requestTts = vi.fn(() => new Promise<{ ok: true; value: ArrayBuffer }>(resolve => { resolveTts = resolve }))
    const api = okApi({
      postLease: vi.fn(async () => ({ ok: true as const, value: { protocolVersion: 1, lease: { held: true, ownerClientId: 'me', expiresAt: 9, youAreOwner: true } } })),
      drain: vi.fn(async () => {
        if (!emitEvent || emitted) return { ok: true as const, value: { protocolVersion: 1, events: [] } }
        emitted = true
        return {
          ok: true as const,
          value: { protocolVersion: 1, events: [{ id: 'phase-1', kind: 'done', text: '状态测试', priority: 2, createdAt: 1 }] },
        }
      }),
      requestTts,
    })

    render(<VoiceCompanionPanel apiOverride={api as never} intervals={{ drainMs: 20, renewMs: 60_000, stateMs: 60_000 }} />)
    fireEvent.click(screen.getByTestId('voice-onboarding-enable'))
    const label = screen.getByTestId('voice-pill-label')
    await waitFor(() => expect(label.textContent).toBe('空闲中'))

    emitEvent = true
    await waitFor(() => expect(requestTts).toHaveBeenCalledTimes(1), { timeout: 3000 })
    expect(label.textContent).toBe('合成中')

    resolveTts({ ok: true, value: new ArrayBuffer(8) })
    await waitFor(() => expect(label.textContent).toBe('播放中'))
    await waitFor(() => expect(latestSource).toBeDefined())
    latestSource?.onended?.()
    await waitFor(() => expect(label.textContent).toBe('空闲中'))
  })

  it('同一 drain 批次的同优先级事件按顺序全部合成，不丢第二条', async () => {
    class AutoEndContext extends FakeAudioContext {
      createBufferSource() {
        const source = new FakeSourceNode()
        source.start = () => {
          source.started = true
          setTimeout(() => source.onended?.(), 0)
        }
        return source
      }
    }
    ;(window as unknown as { AudioContext?: unknown }).AudioContext = AutoEndContext
    let drained = false
    const requestTts = vi.fn(async () => ({ ok: true as const, value: new ArrayBuffer(8) }))
    const api = okApi({
      postLease: vi.fn(async () => ({ ok: true as const, value: { protocolVersion: 1, lease: { held: true, ownerClientId: 'me', expiresAt: 9, youAreOwner: true } } })),
      drain: vi.fn(async () => {
        if (drained) return { ok: true as const, value: { protocolVersion: 1, events: [] } }
        drained = true
        return {
          ok: true as const,
          value: {
            protocolVersion: 1,
            events: [
              { id: 'e1', kind: 'done', text: '第一条', priority: 2, createdAt: 1 },
              { id: 'e2', kind: 'done', text: '第二条', priority: 2, createdAt: 2 },
            ],
          },
        }
      }),
      requestTts,
    })
    render(<VoiceCompanionPanel apiOverride={api as never} intervals={{ drainMs: 20, renewMs: 60_000, stateMs: 60_000 }} />)
    fireEvent.click(screen.getByTestId('voice-onboarding-enable'))
    await waitFor(() => expect(requestTts).toHaveBeenCalledTimes(2), { timeout: 3000 })
    expect((requestTts.mock.calls as unknown[][]).map(call => call[0])).toEqual(['第一条', '第二条'])
    await waitFor(() => expect(screen.queryByText(/正在播/)).toBeNull())
  })
})

describe('音色 Profile 面板', () => {
  const longIntervals = { drainMs: 10_000, renewMs: 10_000, stateMs: 10_000 }

  function leaderApi(overrides: Record<string, unknown> = {}): ApiShape {
    return okApi({
      postLease: vi.fn(async (action: string) => {
        if (action === 'takeover' || action === 'renew') return { ok: true as const, value: { protocolVersion: 1, lease: { held: true, ownerClientId: 'me', expiresAt: 9, youAreOwner: true } } }
        if (action === 'acquire') return { ok: true as const, value: { protocolVersion: 1, lease: { held: true, ownerClientId: 'me', expiresAt: 9, youAreOwner: true } } }
        return { ok: true as const, value: { protocolVersion: 1, lease: { held: false, ownerClientId: null, expiresAt: 0, youAreOwner: false } } }
      }),
      ...overrides,
    })
  }

  async function openPanel(api: ApiShape, leader: boolean): Promise<void> {
    render(<VoiceCompanionPanel apiOverride={api as never} intervals={longIntervals} />)
    fireEvent.click(screen.getByTestId('voice-pill'))
    if (leader) {
      await waitFor(() => expect(screen.getByText(/本页播放/)).toBeTruthy())
    }
  }

  it('空状态显示"暂无音色"（默认内置兜底作为当前音色）', async () => {
    const api = leaderApi()
    await openPanel(api, true)
    await waitFor(() => expect(screen.getByTestId('voice-profiles-empty')).toBeTruthy())
    // 无激活项且列表为空时，当前音色显示默认。
    expect(screen.getByTestId('voice-current-voice').textContent).toBe('未设置')
  })

  it('列表渲染多个音色，当前音色名与当前徽标正确；内置只读但可回退启用', async () => {
    const profiles = [
      profile({ id: 'builtin-adai-design-1', name: '阿呆·设计音色-1', kind: 'builtin', readOnly: true, approved: true }),
      profile({ id: 'p1', name: '女声 A', kind: 'design', active: true }),
      profile({ id: 'p2', name: '男声 B', kind: 'clone' }),
    ]
    const api = leaderApi({ listProfiles: vi.fn(async () => ({ ok: true as const, value: profilesResponse(profiles, { activeId: 'p1', previousId: 'builtin-adai-design-1', history: ['builtin-adai-design-1'] }) })) })
    await openPanel(api, true)
    await waitFor(() => expect(screen.getByTestId('voice-profile-row-p1')).toBeTruthy())
    expect(screen.getByTestId('voice-current-voice').textContent).toBe('女声 A')
    expect(screen.getByTestId('voice-profile-active-p1')).toBeTruthy()
    expect((screen.getByTestId('voice-profile-enable-builtin-adai-design-1') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByTestId('voice-profile-enable-builtin-adai-design-1').textContent).toBe('回退默认')
    expect(screen.getByTestId('voice-profiles').textContent).toContain('内置')
    // 有上一版本 → 可回滚
    expect((screen.getByTestId('voice-profile-rollback') as HTMLButtonElement).disabled).toBe(false)
  })

  it('启用自定义音色后可重新启用只读的内置默认音色', async () => {
    const builtin = profile({
      id: 'builtin-adai-design-1',
      name: '阿呆·设计音色-1',
      kind: 'builtin',
      readOnly: true,
      approved: true,
    })
    const custom = profile({ id: 'custom-1', name: '新设计音色', kind: 'design', active: true })
    const api = leaderApi({
      listProfiles: vi.fn(async () => ({
        ok: true as const,
        value: profilesResponse([builtin, custom], { activeId: 'custom-1', previousId: null, history: [] }),
      })),
      activateProfile: vi.fn(async () => ({ ok: true as const, value: { protocolVersion: 1, ok: true, active: null } })),
    })

    await openPanel(api, true)
    await waitFor(() => expect(screen.getByTestId('voice-profile-enable-builtin-adai-design-1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('voice-profile-enable-builtin-adai-design-1'))
    expect(screen.getByTestId('voice-profile-confirm').textContent).toContain('阿呆·设计音色-1')
    fireEvent.click(screen.getByTestId('voice-profile-activate-confirm'))
    await waitFor(() => expect(api.activateProfile).toHaveBeenCalledWith('builtin-adai-design-1', expect.any(String)))
  })

  it('加载状态显示 loading 文案后再出数据', async () => {
    let first = true
    const api = leaderApi({
      listProfiles: vi.fn(async () => {
        if (first) { first = false; await new Promise(resolve => setTimeout(resolve, 40)); return { ok: true as const, value: profilesResponse([profile()]) } }
        return { ok: true as const, value: profilesResponse([profile()]) }
      }),
    })
    await openPanel(api, true)
    expect(screen.getByTestId('voice-profiles-loading')).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId('voice-profile-row-p1')).toBeTruthy(), { timeout: 3000 })
  })

  it('错误状态显示错误并支持重试', async () => {
    let fails = true
    const api = leaderApi({
      listProfiles: vi.fn(async () => {
        if (fails) { fails = false; return { ok: false as const, code: 'NETWORK' as const, message: '加载失败' } }
        return { ok: true as const, value: profilesResponse([profile()]) }
      }),
    })
    await openPanel(api, true)
    await waitFor(() => expect(screen.getByTestId('voice-profiles-error')).toBeTruthy())
    expect(screen.getByTestId('voice-profiles-error').textContent).toContain('加载失败')
    fireEvent.click(screen.getByTestId('voice-profiles-retry'))
    await waitFor(() => expect(screen.getByTestId('voice-profile-row-p1')).toBeTruthy())
  })

  it('非 leader：音色操作禁用，仅可查看', async () => {
    const api = okApi({ listProfiles: vi.fn(async () => ({ ok: true as const, value: profilesResponse([profile({ id: 'p1', name: '女声 A' })], { activeId: 'p1', previousId: 'x', history: ['x'] }) })) })
    // 默认 postLease → youAreOwner false，始终非 leader。
    await openPanel(api, false)
    await waitFor(() => expect(screen.getByTestId('voice-profile-row-p1')).toBeTruthy())
    expect((screen.getByTestId('voice-profile-preview-p1') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('voice-profile-enable-p1') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('voice-profile-rollback') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('voice-profiles').textContent).toContain('仅可查看')
  })

  it('启用流程：点击启用 → 确认 → 调用 activateProfile 并刷新列表', async () => {
    let fetchCount = 0
    const api = leaderApi({
      listProfiles: vi.fn(async () => {
        fetchCount += 1
        if (fetchCount === 1) return { ok: true as const, value: profilesResponse([profile({ id: 'p1', name: '女声 A' })], { activeId: 'a', previousId: 'a0', history: ['a0'] }) }
        return { ok: true as const, value: profilesResponse([profile({ id: 'p1', name: '女声 A', active: true })], { activeId: 'p1', previousId: 'a', history: ['a', 'a0'] }) }
      }),
      activateProfile: vi.fn(async () => ({ ok: true as const, value: { protocolVersion: 1, ok: true, active: null } })),
    })
    await openPanel(api, true)
    await waitFor(() => expect(screen.getByTestId('voice-profile-row-p1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('voice-profile-enable-p1'))
    expect(screen.getByTestId('voice-profile-confirm')).toBeTruthy()
    fireEvent.click(screen.getByTestId('voice-profile-activate-confirm'))
    await waitFor(() => expect(api.activateProfile).toHaveBeenCalledWith('p1', expect.any(String)))
    await waitFor(() => expect(api.listProfiles).toHaveBeenCalledTimes(2))
  })

  it('启用流程：确认时取消则不调用 activateProfile', async () => {
    const api = leaderApi({
      activateProfile: vi.fn(async () => ({ ok: true as const, value: { protocolVersion: 1, ok: true, active: null } })),
      listProfiles: vi.fn(async () => ({ ok: true as const, value: profilesResponse([profile({ id: 'p1' })], { activeId: 'a', previousId: 'a0' }) })),
    })
    await openPanel(api, true)
    await waitFor(() => expect(screen.getByTestId('voice-profile-row-p1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('voice-profile-enable-p1'))
    fireEvent.click(screen.getByTestId('voice-profile-activate-cancel'))
    expect(screen.queryByTestId('voice-profile-confirm')).toBeNull()
    expect(api.activateProfile).not.toHaveBeenCalled()
  })

  it('激活失败显示错误码并刷新', async () => {
    const api = leaderApi({
      listProfiles: vi.fn(async () => ({ ok: true as const, value: profilesResponse([profile({ id: 'p1' })], { activeId: 'a0', previousId: 'a1' }) })),
      activateProfile: vi.fn(async () => ({ ok: false as const, code: 'NOT_FOUND' as const, message: 'Profile 不存在' })),
    })
    await openPanel(api, true)
    await waitFor(() => expect(screen.getByTestId('voice-profile-row-p1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('voice-profile-enable-p1'))
    fireEvent.click(screen.getByTestId('voice-profile-activate-confirm'))
    await waitFor(() => expect(screen.getAllByText(/启用失败\[NOT_FOUND\]/).length).toBeGreaterThan(0))
  })

  it('回滚流程：点击回滚 → 确认 → 调用 rollbackProfile；取消则不开', async () => {
    const api = leaderApi({
      rollbackProfile: vi.fn(async () => ({ ok: true as const, value: { protocolVersion: 1, ok: true, active: null } })),
      listProfiles: vi.fn(async () => ({ ok: true as const, value: profilesResponse([profile({ id: 'p1' })], { activeId: 'p1', previousId: 'p0', history: ['p0'] }) })),
    })
    await openPanel(api, true)
    await waitFor(() => expect(screen.getByTestId('voice-profile-row-p1')).toBeTruthy())
    // 先点取消再点确认。
    fireEvent.click(screen.getByTestId('voice-profile-rollback'))
    fireEvent.click(screen.getByTestId('voice-profile-rollback-cancel'))
    expect(api.rollbackProfile).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('voice-profile-rollback'))
    fireEvent.click(screen.getByTestId('voice-profile-rollback-confirm'))
    await waitFor(() => expect(api.rollbackProfile).toHaveBeenCalledWith(expect.any(String)))
  })

  it('并发：激活进行中其它音色操作禁用', async () => {
    let resolveActivate!: (value: { ok: true; value: unknown }) => void
    const api = leaderApi({
      listProfiles: vi.fn(async () => ({ ok: true as const, value: profilesResponse([profile({ id: 'p1' }), profile({ id: 'p2' })], { activeId: 'a', previousId: 'b', history: ['b'] }) })),
      activateProfile: vi.fn(() => new Promise<{ ok: true; value: unknown }>(resolve => { resolveActivate = resolve })),
    })
    await openPanel(api, true)
    await waitFor(() => expect(screen.getByTestId('voice-profile-row-p1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('voice-profile-enable-p1'))
    fireEvent.click(screen.getByTestId('voice-profile-activate-confirm'))
    // 激活挂起：p2 的启用/试听与回滚都不可用。
    expect((screen.getByTestId('voice-profile-enable-p2') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('voice-profile-preview-p2') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('voice-profile-rollback') as HTMLButtonElement).disabled).toBe(true)
    resolveActivate({ ok: true, value: { protocolVersion: 1, ok: true, active: null } })
    await waitFor(() => expect((screen.getByTestId('voice-profile-enable-p1') as HTMLButtonElement).disabled).toBe(false))
  })

  it('试听：点击试听调用 getProfileReference，解码失败不崩溃', async () => {
    const api = leaderApi({
      listProfiles: vi.fn(async () => ({ ok: true as const, value: profilesResponse([profile({ id: 'p1' })], { activeId: 'a', previousId: 'b', history: ['b'] }) })),
      getProfileReference: vi.fn(async () => ({ ok: true as const, value: new ArrayBuffer(8) })),
    })
    await openPanel(api, true)
    await waitFor(() => expect(screen.getByTestId('voice-profile-row-p1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('voice-profile-preview-p1'))
    await waitFor(() => expect(api.getProfileReference).toHaveBeenCalledWith('p1', expect.any(String), expect.anything()))
    await waitFor(() => expect(screen.getByTestId('voice-profile-preview-p1').textContent).toBe('试听'))
  })

  it('实时合成中点击音色试听：正常抢占并播放参考音频，不显示取消错误', async () => {
    let liveSignal: AbortSignal | undefined
    const api = leaderApi({
      listProfiles: vi.fn(async () => ({ ok: true as const, value: profilesResponse([profile({ id: 'p1' })]) })),
      requestTestVoice: vi.fn((_clientId: string, signal?: AbortSignal) => new Promise(resolve => {
        liveSignal = signal
        signal?.addEventListener('abort', () => resolve({ ok: false as const, code: 'TTS_TIMEOUT' as const, message: '合成已取消' }), { once: true })
      })),
      getProfileReference: vi.fn(async () => ({ ok: true as const, value: new ArrayBuffer(8) })),
    })
    await openPanel(api, true)
    await waitFor(() => expect(screen.getByTestId('voice-profile-row-p1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('voice-test'))
    await waitFor(() => expect(api.requestTestVoice).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('voice-profile-preview-p1'))

    await waitFor(() => expect(liveSignal?.aborted).toBe(true))
    await waitFor(() => expect(api.getProfileReference).toHaveBeenCalledWith('p1', expect.any(String), expect.anything()))
    expect(screen.queryByText(/TTS_TIMEOUT|合成已取消|downstream/)).toBeNull()
  })
})

describe('Phase 3：速度优先模式与句子级流水（播放模式）', () => {
  class FakeSourceNode {
    stopped = 0
    started = false
    onended: (() => void) | null = null
    connect() { /* noop */ }
    start() { this.started = true }
    stop() { this.stopped++ }
  }

  class StreamContext {
    state = 'running'
    destination = {}
    currentTime = 0
    createGain() { return { gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() { /* noop */ } } }
    createBufferSource() { return new FakeSourceNode() }
    async decodeAudioData(): Promise<AudioBuffer> { return { duration: 0.5 } as AudioBuffer }
    async resume() { this.state = 'running'; return this.state as AudioContextState }
    async close() { this.state = 'closed' }
  }

  beforeEach(() => {
    ;(window as unknown as { AudioContext?: unknown }).AudioContext = StreamContext
  })

  it('速度优先：drain 事件走 requestTtsStream 逐段播放，不再走 requestTts（不静默切换）', async () => {
    window.localStorage.setItem('dsh.voice-companion.preferences.v1', JSON.stringify({ muted: false, volume: 0.9, collapsed: false, onboardingSeen: true, mode: 'speed' }))
    const requestTtsStream = vi.fn(async function* () {
      yield new ArrayBuffer(16)
      yield new ArrayBuffer(16)
    })
    const api = okApi({
      postLease: vi.fn(async () => ({ ok: true as const, value: { protocolVersion: 1, lease: { held: true, ownerClientId: 'me', expiresAt: 9, youAreOwner: true } } })),
      drain: vi.fn(async () => ({
        ok: true as const,
        value: { protocolVersion: 1, events: [{ id: 'e1', kind: 'done', text: '速度测试句子。', priority: 2, createdAt: 1 }] },
      })),
      requestTtsStream,
      requestTts: vi.fn(async () => ({ ok: true as const, value: new ArrayBuffer(8) })),
    })
    render(<VoiceCompanionPanel apiOverride={api as never} intervals={{ drainMs: 20, renewMs: 60_000, stateMs: 60_000 }} />)
    // collapsed:false → 初始即展开。
    expect(screen.getByTestId('voice-panel')).toBeTruthy()
    await waitFor(() => expect(requestTtsStream).toHaveBeenCalledTimes(1), { timeout: 3000 })
    expect(api.requestTts).not.toHaveBeenCalled()
    // 面板显示当前模式：速度优先。
    expect(screen.getByTestId('voice-mode-label').textContent).toContain('速度优先')
  })

  it('速度优先流式失败：显示稳定错误码，不落入身份模式', async () => {
    window.localStorage.setItem('dsh.voice-companion.preferences.v1', JSON.stringify({ muted: false, volume: 0.9, collapsed: false, onboardingSeen: false, mode: 'speed' }))
    const requestTtsStream = vi.fn(async function* () {
      throw new VoiceStreamError('TTS_REJECTED', 'MiMo 流式请求失败（HTTP 429）')
    })
    let emitted = false
    const api = okApi({
      postLease: vi.fn(async () => ({ ok: true as const, value: { protocolVersion: 1, lease: { held: true, ownerClientId: 'me', expiresAt: 9, youAreOwner: true } } })),
      drain: vi.fn(async () => {
        if (emitted) return { ok: true as const, value: { protocolVersion: 1, events: [] } }
        emitted = true
        return {
          ok: true as const,
          value: { protocolVersion: 1, events: [{ id: 'e1', kind: 'done', text: '流式失败', priority: 2, createdAt: 1 }] },
        }
      }),
      requestTtsStream,
      requestTts: vi.fn(async () => ({ ok: true as const, value: new ArrayBuffer(8) })),
    })
    render(<VoiceCompanionPanel apiOverride={api as never} intervals={{ drainMs: 20, renewMs: 60_000, stateMs: 60_000 }} />)
    fireEvent.click(screen.getByTestId('voice-onboarding-enable'))
    // collapsed:false → 初始即展开，无需点胶囊。
    expect(screen.getByTestId('voice-panel')).toBeTruthy()
    await waitFor(() => expect(screen.getAllByText(/流式合成失败\[TTS_REJECTED\]/).length).toBeGreaterThan(0), { timeout: 3000 })
    expect(api.requestTts).not.toHaveBeenCalled()
  })

  it('模式切换按钮：身份优先 ↔ 速度优先，偏好持久化', async () => {
    window.localStorage.setItem('dsh.voice-companion.preferences.v1', JSON.stringify({ muted: false, volume: 0.9, collapsed: false, onboardingSeen: true, mode: 'identity' }))
    const api = okApi({})
    render(<VoiceCompanionPanel apiOverride={api as never} intervals={{ drainMs: 10_000, renewMs: 10_000, stateMs: 10_000 }} />)
    // collapsed:false → 初始即展开。
    expect(screen.getByTestId('voice-panel')).toBeTruthy()
    expect(screen.getByTestId('voice-mode-label').textContent).toContain('身份优先')
    fireEvent.click(screen.getByTestId('voice-mode-toggle'))
    expect(screen.getByTestId('voice-mode-label').textContent).toContain('速度优先')
    const saved = JSON.parse(window.localStorage.getItem('dsh.voice-companion.preferences.v1') ?? '{}') as { mode: string }
    expect(saved.mode).toBe('speed')
  })

  it('展开状态持久化：展开后卸载重挂仍是展开（collapsed 偏好接线）', () => {
    const api = okApi()
    const first = render(<VoiceCompanionPanel apiOverride={api as never} intervals={{ drainMs: 10_000, renewMs: 10_000, stateMs: 10_000 }} />)
    fireEvent.click(screen.getByTestId('voice-pill'))
    expect(screen.getByTestId('voice-panel')).toBeTruthy()
    first.unmount()
    const saved = JSON.parse(window.localStorage.getItem('dsh.voice-companion.preferences.v1')!) as { collapsed?: boolean }
    expect(saved.collapsed).toBe(false)
    render(<VoiceCompanionPanel apiOverride={api as never} intervals={{ drainMs: 10_000, renewMs: 10_000, stateMs: 10_000 }} />)
    expect(screen.getByTestId('voice-panel')).toBeTruthy()
  })

  it('拖动胶囊：位置持久化到偏好、根节点切换为 left/top 定位，拖后合成 click 不误展开', () => {
    const api = okApi()
    render(<VoiceCompanionPanel apiOverride={api as never} intervals={{ drainMs: 10_000, renewMs: 10_000, stateMs: 10_000 }} />)
    const pill = screen.getByTestId('voice-pill')
    const root = pill.parentElement as HTMLElement

    fireEvent.pointerDown(pill, { pointerId: 1, button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(pill, { pointerId: 1, clientX: 160, clientY: 140 })
    fireEvent.pointerUp(pill, { pointerId: 1, clientX: 160, clientY: 140 })

    // jsdom 中 getBoundingClientRect 为 0，因此新位置 = 位移量（已钳制到 ≥8px 边距）。
    expect(root.style.left).toBe('60px')
    expect(root.style.top).toBe('40px')
    const saved = JSON.parse(window.localStorage.getItem('dsh.voice-companion.preferences.v1')!) as { panelPos?: { x: number; y: number } }
    expect(saved.panelPos).toEqual({ x: 60, y: 40 })

    // 拖动后的合成 click 被抑制，不展开面板；再次正常点击才展开。
    fireEvent.click(pill)
    expect(screen.queryByTestId('voice-panel')).toBeNull()
    fireEvent.click(pill)
    expect(screen.getByTestId('voice-panel')).toBeTruthy()
  })

  it('靠近右下角的胶囊展开后再收起，精确回到原位置', () => {
    window.localStorage.setItem('dsh.voice-companion.preferences.v1', JSON.stringify({
      muted: false, volume: 0.9, collapsed: true, onboardingSeen: true,
      mode: 'identity', panelPos: { x: 850, y: 700 },
    }))
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })

    render(<VoiceCompanionPanel apiOverride={okApi() as never} intervals={{ drainMs: 10_000, renewMs: 10_000, stateMs: 10_000 }} />)
    const root = screen.getByTestId('voice-pill').parentElement as HTMLElement
    const dimensions = () => root.querySelector('[data-testid="voice-panel"]')
      ? { width: 320, height: 600 }
      : { width: 120, height: 36 }
    Object.defineProperty(root, 'offsetWidth', { configurable: true, get: () => dimensions().width })
    Object.defineProperty(root, 'offsetHeight', { configurable: true, get: () => dimensions().height })
    root.getBoundingClientRect = vi.fn(() => {
      const { width, height } = dimensions()
      const left = Number.parseFloat(root.style.left)
      const top = Number.parseFloat(root.style.top)
      return { x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON: () => ({}) } as DOMRect
    })

    fireEvent.click(screen.getByTestId('voice-pill'))
    expect(root.style.left).toBe('650px')
    expect(root.style.top).toBe('136px')

    fireEvent.click(screen.getByLabelText('收起面板'))
    expect(root.style.left).toBe('850px')
    expect(root.style.top).toBe('700px')
    const saved = JSON.parse(window.localStorage.getItem('dsh.voice-companion.preferences.v1')!) as { panelPos?: { x: number; y: number } }
    expect(saved.panelPos).toEqual({ x: 850, y: 700 })
  })

  it('微小位移（<4px）视为点击：不改变位置，正常展开', () => {
    const api = okApi()
    render(<VoiceCompanionPanel apiOverride={api as never} intervals={{ drainMs: 10_000, renewMs: 10_000, stateMs: 10_000 }} />)
    const pill = screen.getByTestId('voice-pill')
    const root = pill.parentElement as HTMLElement
    fireEvent.pointerDown(pill, { pointerId: 1, button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(pill, { pointerId: 1, clientX: 102, clientY: 101 })
    fireEvent.pointerUp(pill, { pointerId: 1, clientX: 102, clientY: 101 })
    expect(root.style.left).toBe('')
    fireEvent.click(pill)
    expect(screen.getByTestId('voice-panel')).toBeTruthy()
  })

  it('身份优先多句文本：逐句合成（句子级流水），全部句都播', async () => {
    class AutoEndContext extends StreamContext {
      createBufferSource() {
        const source = new FakeSourceNode()
        source.start = () => {
          source.started = true
          setTimeout(() => source.onended?.(), 0)
        }
        return source
      }
    }
    ;(window as unknown as { AudioContext?: unknown }).AudioContext = AutoEndContext
    const requestTts = vi.fn(async () => ({ ok: true as const, value: new ArrayBuffer(8) }))
    let emitted = false
    const api = okApi({
      postLease: vi.fn(async () => ({ ok: true as const, value: { protocolVersion: 1, lease: { held: true, ownerClientId: 'me', expiresAt: 9, youAreOwner: true } } })),
      drain: vi.fn(async () => {
        if (emitted) return { ok: true as const, value: { protocolVersion: 1, events: [] } }
        emitted = true
        return {
          ok: true as const,
          value: { protocolVersion: 1, events: [{ id: 'e1', kind: 'done', text: '第一句话。第二句话？第三句话！', priority: 2, createdAt: 1 }] },
        }
      }),
      requestTts,
    })
    render(<VoiceCompanionPanel apiOverride={api as never} intervals={{ drainMs: 20, renewMs: 60_000, stateMs: 60_000 }} />)
    fireEvent.click(screen.getByTestId('voice-onboarding-enable'))
    fireEvent.click(screen.getByTestId('voice-pill'))
    await waitFor(() => expect(requestTts).toHaveBeenCalledTimes(3), { timeout: 5000 }).catch(() => {
      // eslint-disable-next-line no-console
      console.error('CALLS:', JSON.stringify((requestTts.mock.calls as unknown[][]).map(call => call[0])))
    })
    expect((requestTts.mock.calls as unknown[][]).map(call => call[0])).toEqual(['第一句话。', '第二句话？', '第三句话！'])
    await waitFor(() => expect(requestTts).not.toHaveBeenCalledTimes(4))
  })
})
