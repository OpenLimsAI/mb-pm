import type { AnswerCapabilities, AnswerMode, AnswerProvenance } from '../answerModes/types'
export type SolutionStatus = 'draft' | 'in_review' | 'final' | 'archived'
export interface Section { id: string; title: string; content: string; parentId?: string | null }
export interface FormulaRow {
  id: string; material: string; purpose: string; specification: string; amount: string
  unit: string; basis: string; range: string; rationale: string; evidenceIds: string[]
  verification: 'pending' | 'confirmed'
}
export interface Reference {
  id: string; sourceId: string; title: string; excerpt: string; locator: string
  sourceVersion: string; sectionId: string
}
export interface Solution {
  id: string; title: string; projectName: string; productName: string; pinned?: boolean; tags?: string[]
  ownerId: string; ownerName: string; status: SolutionStatus; revision: number; version: number
  updatedAt: string; sections: Section[]; formula: FormulaRow[]; references: Reference[]
  reviewerId: string | null; reviewerName: string; reviewNotes: string; canEdit: boolean
}
export interface SolutionInput {
  title: string; projectName: string; productName: string; sections: Section[]; pinned?: boolean; tags?: string[]
  formula: FormulaRow[]; references: Reference[]
}
export type SourceKind = 'paper' | 'practice' | 'note' | 'solution' | 'web'
export interface KnowledgeSource {
  id: string; title: string; kind: SourceKind; authors: string; date: string
  projectName: string; tags: string[]; content: string; locator: string; version: string
  url: string; updatedAt: string
}
export type SourceInput = Omit<KnowledgeSource, 'id' | 'version' | 'updatedAt'>
export interface Answer extends AnswerProvenance {
  conversationId?: string | null
  id: string; question: string; content: string; createdAt: string; mode: 'ai' | 'retrieval'
  references: Reference[]; context: string; scope: string; model?: string
}
export interface AskInput { question: string; context: string; sourceIds: string[]; projectName: string; sectionId: string; modelProfileId?: string; conversationId?: string; answerMode?: AnswerMode }
export interface PolishInput { text: string; instruction: string; sectionId: string; modelProfileId?: string }
export interface PolishResult { content: string; model: string; mode: 'ai' | 'preview' }
export interface Version {
  id: string; version: number; status: SolutionStatus; createdAt: string; actorName: string
  note: string; snapshot: Solution
}
export interface ReviewAction {
  action: 'submit' | 'withdraw' | 'approve' | 'return' | 'revise' | 'archive' | 'restore'
  revision: number; note: string; reviewerId?: string; versionId?: string
}
export interface Reviewer { id: string; name: string }
export interface TrashedSolution { id: string; title: string; revision: number; deletedAt: string }
export interface ReportTemplate { id: string; name: string; sections: Omit<Section, 'content'>[]; createdAt: string }
export interface TopicMetadata { id: string; title: string; archived: boolean; revision: number }
export interface SolutionClient {
  snapshot?(id: string, revision: number, name: string): Promise<Version>
  restoreSection?(id: string, versionId: string, revision: number, sectionId: string): Promise<Solution>
  templates?(): Promise<ReportTemplate[]>
  createTemplate?(name: string, sections: Omit<Section, 'content'>[]): Promise<ReportTemplate>
  deleteTemplate?(id: string): Promise<void>
  topics?(id: string): Promise<TopicMetadata[]>
  saveTopic?(id: string, topic: TopicMetadata): Promise<TopicMetadata>
  deleteTopic?(id: string, topicId: string, revision: number): Promise<void>
  capabilities?(modelProfileId?: string): Promise<AnswerCapabilities>
  trash(): Promise<TrashedSolution[]>
  remove(id: string, revision: number): Promise<void>
  restore(id: string, revision: number): Promise<Solution>
  list(): Promise<Solution[]>
  create(input: SolutionInput): Promise<Solution>
  get(id: string): Promise<Solution>
  save(id: string, input: SolutionInput & { revision: number }): Promise<Solution>
  review(id: string, input: ReviewAction): Promise<Solution>
  versions(id: string): Promise<Version[]>
  reviewers(): Promise<Reviewer[]>
  sources(query?: string, projectName?: string): Promise<KnowledgeSource[]>
  getSource(id: string, solutionId?: string): Promise<KnowledgeSource>
  knowledgeStatus(): Promise<{ configured: boolean; available: boolean; message: string }>
  addSource(input: SourceInput): Promise<KnowledgeSource>
  ask(id: string, input: AskInput, signal?: AbortSignal): Promise<Answer>
  polish?(id: string, input: PolishInput): Promise<PolishResult>
  history(id: string): Promise<Answer[]>
  exportWord(id: string): Promise<void>
  publish(id: string): Promise<KnowledgeSource>
}
