export type AnswerMode = 'auto' | 'general' | 'knowledge' | 'web'
export type ActualAnswerMode = Exclude<AnswerMode, 'auto'> | 'application'
export interface WebReference {
  id: string; title: string; url: string; publishedAt: string | null; retrievedAt: string; excerpt: string
}
export interface AnswerProvenance {
  answerMode?: ActualAnswerMode; requestedMode?: AnswerMode; modeReason?: string; webReferences?: WebReference[]; usedSources?: ('projects' | 'knowledge')[]
}
export interface AnswerCapabilities {
  webSearch: { configured: boolean; provider: 'tavily' | null; message: string }
  modes: AnswerMode[]
}
