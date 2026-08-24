/**
 * 语音模型提示 section：长任务优先调用 voice_prepare 预合成；无需预取时仍可
 * 在完成回合末尾使用 @voice 标记作为兼容路径。
 */

export const VOICE_PROMPT_SECTION_NAME = 'voice-companion:marker'

/** 提示 order：位于工具指导区（order≈100–116）之后、subagent 区（190）之前。 */
export const VOICE_PROMPT_ORDER = 130

export const VOICE_PROMPT_TEXT = 'Voice companion is available. For a long task or whenever the human asks for '
  + 'a spoken completion, call `voice_prepare` with the short spoken summary immediately before writing the final '
  + 'user-visible answer. This lets speech synthesize while the answer streams; call it only after the claimed '
  + 'outcome is already verified. Do not also add an `@voice` line after a successful `voice_prepare` call. For a '
  + 'short answer where prefetch is not useful, you may instead add exactly one separate final line beginning with '
  + '`@voice ` followed by a natural spoken summary. Keep speech under 80 Chinese characters. Never include secrets, '
  + 'file paths, code, raw diagnostics, or Markdown. Omit speech for silent/internal work or when it adds no value.'
