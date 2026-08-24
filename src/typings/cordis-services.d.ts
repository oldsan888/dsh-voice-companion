/**
 * 宿主 services 类型 shim：把 dsh-voice-companion 用到的宿主能力（webServer、
 * systemPrompt、tools、slots、session 事件）注入 cordis 的声明合并面。运行期这些服务由
 * 宿主 DSH 提供（cordis 服务注册表按名取用），此处仅供类型检查；
 * 类型只描述插件实际使用的最小公共接口。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** 插件内部使用的事件形状（与宿主 SessionEventMap 对齐的最小投影）。 */
export interface VoiceSessionEvent {
  type: string
  seq: number
  time: number
  data: {
    turn?: number
    step?: number
    reason?: {
      kind: string
      reason?: { kind: string }
      error?: { message?: unknown; code?: unknown; status?: unknown }
    }
    message?: {
      role?: string
      content?: Array<{ type?: string; text?: string } | unknown>
    }
    interrupted?: true
  }
}

/** 会话最小投影：id 用于 sourceKey，events 只在测试里直接构造。 */
export interface VoiceSessionLike {
  id: string | number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** host：浏览器 HTTP 载体服务（注册 exact 路由）。 */
    webServer: {
      register(options: {
        kind: 'prefix' | 'exact'
        path: string
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
      }): () => void
    }
    /** host：系统提示词装配服务。 */
    systemPrompt: {
      section(section: { name: string; order: number; text: string }): () => void
    }
    /** host：模型工具注册表。 */
    tools: {
      register(tool: ToolDefinition): () => void
    }
    /** client：视图环插槽服务（shell.overlay 注册）。 */
    slots: {
      inject(name: string, register: () => unknown): unknown
      register(opts: {
        name: string
        id: string
        order?: number
        label?: string
      }, component: unknown): unknown
    }
    effect(fn: () => unknown, label?: string): unknown
    on(event: string, listener: (...args: never[]) => unknown, options?: { global?: boolean }): () => boolean
    /** 日志面（cordis 注入）；debug 可选。 */
    logger: {
      info(...args: unknown[]): void
      warn(...args: unknown[]): void
      error(...args: unknown[]): void
      debug?(...args: unknown[]): void
    }
  }
}

export {}
