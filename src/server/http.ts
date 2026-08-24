/**
 * Node HTTP 读写助手：有界 JSON body 读取、统一 JSON/错误/WAV 响应。
 * 所有响应带 Cache-Control: no-store；错误体只含稳定码与脱敏短消息。
 */
import { BODY_LIMIT_BYTES, PROTOCOL_VERSION } from '../shared/constants.ts'
import { ERROR_STATUS } from '../shared/protocol.ts'
import type { ErrorCode, ErrorResponse, StateResponse, LeaseResponse, DrainResponse } from '../shared/protocol.ts'

/** 读取 JSON body（上限 BODY_LIMIT_BYTES）；超限/坏 JSON 返回对应错误码。 */
export function readJsonBody(req: import('node:http').IncomingMessage):
  Promise<{ ok: true; value: unknown } | { ok: false; code: ErrorCode; message: string }> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const finish = (result: { ok: true; value: unknown } | { ok: false; code: ErrorCode; message: string }): void => {
      if (settled) return
      settled = true
      req.removeAllListeners('data')
      req.removeAllListeners('end')
      req.removeAllListeners('error')
      resolve(result)
    }
    req.on('error', () => finish({ ok: false, code: 'INVALID_JSON', message: '请求体读取失败' }))
    req.on('data', (chunk: Buffer) => {
      total += chunk.byteLength
      if (total > BODY_LIMIT_BYTES) {
        finish({ ok: false, code: 'BODY_TOO_LARGE', message: `请求体超过 ${BODY_LIMIT_BYTES} 字节上限` })
        // 继续排空 socket 中的剩余请求体，避免 keep-alive 连接悬住。
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim().length === 0) {
        finish({ ok: false, code: 'INVALID_JSON', message: '请求体为空或不是 JSON' })
        return
      }
      try {
        finish({ ok: true, value: JSON.parse(raw) as unknown })
      } catch {
        finish({ ok: false, code: 'INVALID_JSON', message: '请求体不是合法 JSON' })
      }
    })
  })
}

/** 统一 JSON 响应（自动携带协议版本与 no-store）。 */
export function sendJson(res: import('node:http').ServerResponse, status: number, payload: object): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/** 错误响应（状态码由 ERROR_STATUS 决定；405 附 Allow）。 */
export function sendError(res: import('node:http').ServerResponse, code: ErrorCode, message: string, allow?: string): void {
  if (code === 'BAD_METHOD' && allow) res.setHeader('Allow', allow)
  const body: ErrorResponse = { protocolVersion: PROTOCOL_VERSION, error: { code, message } }
  sendJson(res, ERROR_STATUS[code], body)
}

/** WAV 二进制响应（原样字节，绝不 Base64 化）。 */
export function sendWav(res: import('node:http').ServerResponse, audio: Buffer): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(200, {
    'content-type': 'audio/wav',
    'cache-control': 'no-store',
    'content-length': String(audio.byteLength),
  })
  res.end(audio)
}

/** 校验请求 content-type 为 JSON（POST 路由用）。 */
export function isJsonContentType(req: import('node:http').IncomingMessage): boolean {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  return type === 'application/json'
}

/** 从 URL query 取 clientId。 */
export function clientIdFromUrl(req: import('node:http').IncomingMessage, rawUrl: string): string | undefined {
  try {
    const value = new URL(rawUrl, 'http://x').searchParams.get('clientId')
    return value ?? undefined
  } catch {
    return undefined
  }
}

/** 类型收窄工具：把 unknown 断言为对象记录（不校验内部字段）。 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/** 导出类型引用，防止仅类型导入被构建裁剪时遗漏协议面。 */
export type ProtocolFaces = StateResponse | LeaseResponse | DrainResponse
