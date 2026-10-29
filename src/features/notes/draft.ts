import type { NoteInput } from './client'
export interface NoteDraft extends NoteInput { id: string }
export const newNote = (patch: Partial<NoteInput> = {}): NoteDraft => ({ id: crypto.randomUUID(), title: '', content: '', sourceApp: 'manual', sourceTitle: '', sourceUrl: '', ...patch })
