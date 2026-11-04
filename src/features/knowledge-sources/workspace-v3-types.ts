export type ReadingState = 'unread' | 'reading' | 'done' | 'later'
export interface ReadingPosition { page?: number; offset?: number; section?: string }
export interface ReadingEntry { state: ReadingState; position?: ReadingPosition; versionId?: string; updatedAt?: string }
export interface CollectionQuery { text?: string; sourceIds?: string[]; folderIds?: string[]; scopes?: string[]; types?: string[]; tags?: string[]; readingStates?: ReadingState[]; updatedOnly?: boolean }
export interface SmartCollection { id: string; name: string; query: CollectionQuery }
export interface FilingRule extends SmartCollection { enabled: boolean; targetFolderIds: string[] }
export interface WorkspaceState {
  revision: number; collections: SmartCollection[]; rules: FilingRule[]; reading: Record<string, ReadingEntry>
  location: { folderId?: string; collectionId?: string; query?: string; paperId?: string; scrollTop?: number; offset?: number; updatedAt?: string }
}
export interface RuleResult { saved: boolean; partial?: boolean; count: number; total?: number; revision: number; undoTokens?: string[]; undoToken?: string | null; error?: string }
