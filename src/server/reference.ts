/**
 * 随包参考音频加载：从插件自身安装位置（import.meta.url 相对向上）解析
 * assets/voice-reference.wav，绝不依赖 cwd、绝不回读任何外部本地服务目录。
 * 初始化时验证存在、非空、≤10 MiB、RIFF/WAVE PCM16；Buffer 与 data URL
 * 只缓存于 Host 内存。
 */
import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ReferenceAudio } from './tts.ts'
import { validateReferenceWav } from './tts.ts'

/** 参考音频大小上限（字节）。 */
export const REFERENCE_MAX_BYTES = 10 * 1024 * 1024

/**
 * 从编译产物（lib/*.js）或源码（src/server）位置向上查找插件包根的 assets 目录。
 * @param fromUrl - 调用方 import.meta.url。
 */
export function resolveReferencePath(fromUrl: string): string | undefined {
  let dir = dirname(fileURLToPath(fromUrl))
  for (let i = 0; i < 12; i++) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        const metadata = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }
        if (metadata.name === '@oldsan888/dsh-voice-companion') {
          const candidate = join(dir, 'assets', 'voice-reference.wav')
          return existsSync(candidate) ? candidate : undefined
        }
      } catch {
        // 非本插件或损坏的上级 manifest 继续向上定位；不会读取其中其他字段。
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

export type ReferenceLoadResult =
  | { ok: true; reference: ReferenceAudio }
  | { ok: false; detail: string }

/** 加载并验证随包参考音频。失败结果为脱敏短语。 */
export function loadReferenceAudio(fromUrl: string, maxBytes = REFERENCE_MAX_BYTES): ReferenceLoadResult {
  const path = resolveReferencePath(fromUrl)
  if (path === undefined) return { ok: false, detail: '参考音频文件缺失（安装产物应包含 assets/voice-reference.wav）' }
  try {
    const buffer = readFileSync(path)
    if (buffer.length === 0) return { ok: false, detail: '参考音频文件为空' }
    if (buffer.length > maxBytes) return { ok: false, detail: '参考音频超过 10MiB 上限' }
    const inspection = validateReferenceWav(buffer)
    if (!inspection.ok) return { ok: false, detail: inspection.error ?? '参考音频不是有效 WAV' }
    return {
      ok: true,
      reference: {
        buffer,
        bytes: buffer.length,
        dataUrl: `data:audio/wav;base64,${buffer.toString('base64')}`,
      },
    }
  } catch {
    return { ok: false, detail: '参考音频读取失败' }
  }
}
