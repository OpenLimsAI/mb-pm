export type WritingTool = 'outline' | 'knowledge' | 'ai' | 'references' | 'info'
export const WRITING_MODE_KEY = 'ks-writing-mode'

export function readFocusWriting(): boolean {
  try { return localStorage.getItem(WRITING_MODE_KEY) === 'focus' } catch { return false }
}
