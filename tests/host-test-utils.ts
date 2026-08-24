/** 共享测试工具：假时钟、mock req/res、fake cordis ctx。 */
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** 可推进的假时钟。 */
export class FakeClock {
  private nowMs = 1_000_000

  now = (): number => this.nowMs

  advance(ms: number): void {
    this.nowMs += ms
  }
}

export interface RecordedListener {
  name: string
  listener: (...args: never[]) => unknown
  options?: { global?: boolean }
}

export interface FakeRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export interface RecordedEffect {
  label?: string
  disposed: boolean
  disposer: () => unknown
  /** 外层 effect 的卸载函数（调用后 disposed=true 且执行 disposer）。 */
  dispose: () => void
}

export interface FakeCtxOptions {
  webServerRoutes?: Map<string, FakeRoute>
  listeners?: RecordedListener[]
  sections?: Array<{ name: string; order: number; text: string }>
  effects?: RecordedEffect[]
  tools?: unknown[]
  config?: unknown
}

/**
 * Host 测试用 fake ctx：实现 voice 插件 apply 用到的最小面
 * （on / effect / inject / systemPrompt / webServer / logger）。
 */
export function makeFakeHostCtx(options: FakeCtxOptions = {}) {
  const routes = options.webServerRoutes ?? new Map<string, FakeRoute>()
  const listeners = options.listeners ?? []
  const sections = options.sections ?? []
  const effects: RecordedEffect[] = options.effects ?? []
  const tools = options.tools ?? []

  const infos: string[] = []
  const warns: string[] = []
  const ctx = {
    logger: {
      infos,
      warns,
      info: (...args: unknown[]) => { infos.push(args.map(String).join(' ')) },
      warn: (...args: unknown[]) => { warns.push(args.map(String).join(' ')) },
      error: () => undefined,
      debug: () => undefined,
    },
    systemPrompt: {
      section: (section: { name: string; order: number; text: string }) => {
        sections.push(section)
        return () => {
          const at = sections.findIndex(item => item.name === section.name)
          if (at >= 0) sections.splice(at, 1)
        }
      },
    },
    tools: {
      register: (tool: unknown) => {
        tools.push(tool)
        return () => {
          const at = tools.indexOf(tool)
          if (at >= 0) tools.splice(at, 1)
        }
      },
    },
    webServer: {
      register: (route: FakeRoute) => {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
    effect: (fn: () => unknown, label?: string) => {
      const record: RecordedEffect = {
        label,
        disposed: false,
        disposer: () => undefined,
        dispose: () => undefined,
      }
      record.disposer = (fn() as (() => unknown) | undefined) ?? (() => undefined)
      record.dispose = () => {
        if (record.disposed) return
        record.disposed = true
        void record.disposer()
      }
      effects.push(record)
      return record.dispose
    },
    on: (name: string, listener: (...args: never[]) => unknown, opts?: { global?: boolean }) => {
      listeners.push({ name, listener, options: opts })
      return () => true
    },
    inject: (deps: string[], callback: (inner: object) => void) => {
      void deps
      callback(ctx)
    },
  }
  return { ctx, routes, listeners, sections, effects, tools }
}

/** 极简 mock request：body 分片由调用方在 handler 启动后手动发射。 */
export function makeMockRequest(input: { method?: string; url?: string; headers?: Record<string, string>; bodyChunks?: Buffer[] }):
  IncomingMessage & { emitBody: () => void } {
  const emitter = new EventEmitter() as unknown as IncomingMessage & { headers: Record<string, string | undefined>, emitBody: () => void }
  emitter.method = input.method ?? 'GET'
  emitter.url = input.url ?? '/'
  emitter.headers = input.headers ?? {}
  emitter.emitBody = () => {
    for (const chunk of input.bodyChunks ?? []) emitter.emit('data', chunk)
    emitter.emit('end')
  }
  return emitter
}

export interface MockResponseResult {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
  text: string
  json: () => Record<string, unknown>
  /** end() 是否已调用。 */
  readonly ok: boolean
}

/** 极简 mock response：收集 writeHead/end 结果。 */
export function makeMockResponse(): ServerResponse & { result: MockResponseResult } {
  const emitter = new EventEmitter() as unknown as ServerResponse & { result: MockResponseResult }
  const headers: Record<string, string | string[] | undefined> = {}
  const chunks: Buffer[] = []
  let statusCode = 0
  let finished = false
  const response = emitter as unknown as {
    statusCode: number
    headersSent: boolean
    writableEnded: boolean
    closed: boolean
    destroyed: boolean
    setHeader: (name: string, value: string) => void
    writeHead: (status: number, head?: Record<string, string | string[]>) => unknown
    write: (payload?: Buffer | string) => boolean
    end: (payload?: Buffer | string) => unknown
    on: EventEmitter['on']
    off: EventEmitter['off']
    once: EventEmitter['once']
    removeEventListener?: never
    result: MockResponseResult
  }
  response.statusCode = 0
  response.headersSent = false
  response.writableEnded = false
  response.closed = false
  response.destroyed = false
  response.setHeader = (name, value) => { headers[name.toLowerCase()] = value }
  response.writeHead = (status, head) => {
    statusCode = status
    response.headersSent = true
    for (const [key, value] of Object.entries(head ?? {})) headers[key.toLowerCase()] = value
    return response
  }
  response.write = (payload) => {
    if (typeof payload === 'string') chunks.push(Buffer.from(payload))
    else if (payload !== undefined) chunks.push(payload)
    return true
  }
  response.end = (payload) => {
    if (typeof payload === 'string') chunks.push(Buffer.from(payload))
    else if (payload !== undefined) chunks.push(payload)
    response.writableEnded = true
    finished = true
    emitter.emit('finish')
    return response
  }
  Object.assign(response as unknown as Record<string, unknown>, {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    once: emitter.once.bind(emitter),
  })
  response.result = {
    get status() { return statusCode || 200 },
    get headers() { return headers },
    get body() { return Buffer.concat(chunks) },
    get text() { return Buffer.concat(chunks).toString('utf8') },
    json() { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> },
    get ok() { return finished },
  }
  return response as unknown as ServerResponse & { result: MockResponseResult }
}

/** 调用一个已注册路由并等待响应完成（handler 启动后再注入 body）。 */
export async function invokeRoute(
  route: FakeRoute,
  init: { method?: string; url?: string; headers?: Record<string, string>; body?: unknown; rawBody?: Buffer },
): Promise<MockResponseResult> {
  const bodyChunks = init.rawBody !== undefined ? [init.rawBody]
    : init.body !== undefined ? [Buffer.from(JSON.stringify(init.body))] : []
  const headers = { ...init.headers }
  if (init.body !== undefined && headers['content-type'] === undefined) headers['content-type'] = 'application/json'
  const req = makeMockRequest({ method: init.method ?? 'GET', url: init.url ?? '/', headers, bodyChunks })
  const res = makeMockResponse()
  const handled = route.handler(req, res)
  // handler 已同步挂上 data/end 监听器后再发射 body。
  ;(req as unknown as { emitBody: () => void }).emitBody()
  await handled
  await new Promise(resolve => setTimeout(resolve, 0))
  return res.result
}

/** 构造最小 WAV 字节（fmt + data；可注入非法头）。 */
export function makeWav(options: { sampleRate?: number; bits?: number; format?: number; dataBytes?: number; riff?: string; wave?: string }): Buffer {
  const sampleRate = options.sampleRate ?? 24000
  const bits = options.bits ?? 16
  const format = options.format ?? 1
  const dataBytes = options.dataBytes ?? 8
  const channels = 2
  const header = Buffer.alloc(44)
  header.write(options.riff ?? 'RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write(options.wave ?? 'WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(format, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(Math.floor(sampleRate * channels * bits / 8), 28)
  header.writeUInt16LE(Math.floor(channels * bits / 8), 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)
  return Buffer.concat([header, Buffer.alloc(dataBytes)])
}
