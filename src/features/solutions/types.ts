export type SolutionStatus = 'draft' | 'in_review' | 'final' | 'archived'
export interface Section { id: string; title: string; content: string }
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
  id: string; title: string; projectName: string; productName: string
  ownerId: string; ownerName: string; status: SolutionStatus; revision: number; version: number
  updatedAt: string; sections: Section[]; formula: FormulaRow[]; references: Reference[]
  reviewerId: string | null; reviewerName: string; reviewNotes: string; canEdit: boolean
}
export interface SolutionInput {
  title: string; projectName: string; productName: string; sections: Section[]
  formula: FormulaRow[]; references: Reference[]
}
export type SourceKind = 'paper' | 'practice' | 'note' | 'solution'
export interface KnowledgeSource {
  id: string; title: string; kind: SourceKind; authors: string; date: string
  projectName: string; tags: string[]; content: string; locator: string; version: string
  url: string; updatedAt: string
}
export type SourceInput = Omit<KnowledgeSource, 'id' | 'version' | 'updatedAt'>
export interface Answer {
  id: string; question: string; content: string; createdAt: string; mode: 'ai' | 'retrieval'
  references: Reference[]; context: string; scope: string; model?: string
}
export interface AskInput { question: string; context: string; sourceIds: string[]; projectName: string; sectionId: string }
export interface Version {
  id: string; version: number; status: SolutionStatus; createdAt: string; actorName: string
  note: string; snapshot: Solution
}
export interface ReviewAction {
  action: 'submit' | 'withdraw' | 'approve' | 'return' | 'revise' | 'archive' | 'restore'
  revision: number; note: string; reviewerId?: string; versionId?: string
}
export interface Reviewer { id: string; name: string }
export interface SolutionClient {
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
  ask(id: string, input: AskInput): Promise<Answer>
  history(id: string): Promise<Answer[]>
  exportWord(id: string): Promise<void>
  publish(id: string): Promise<KnowledgeSource>
}
