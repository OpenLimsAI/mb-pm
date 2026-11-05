import axios from 'axios'
import { API_BASE, camelize, snakeize } from '../../api/client'

export type NoteSource = 'manual' | 'solutions' | 'information' | 'knowledge'
export interface NoteInput { title: string; content: string; sourceApp: NoteSource; sourceTitle: string; sourceUrl: string }
export interface NoteWisdom { enabled: boolean; status: string; error: string }
export interface PersonalNote extends NoteInput { wisdom?: NoteWisdom; id: string; revision: number; createdAt: string; updatedAt: string; deletedAt: string | null }
export interface NoteQuery { search?: string; sourceApp?: NoteSource; trashed?: boolean; offset?: number }
export interface NotesClient {
  get?(id: string): Promise<PersonalNote>
  list(query?: NoteQuery): Promise<{ items: PersonalNote[]; total: number }>
  create(id: string, input: NoteInput): Promise<PersonalNote>
  save(note: PersonalNote, input: NoteInput): Promise<PersonalNote>
  trash(note: PersonalNote): Promise<PersonalNote>
  restore(note: PersonalNote): Promise<PersonalNote>
  share?(note: PersonalNote, enabled: boolean): Promise<PersonalNote>
}
export const noteSourceNames: Record<NoteSource, string> = { solutions: '研究报告', knowledge: '知识库', information: '行业信息', manual: '个人记录' }
export function noteSourceUrl(value: string): string | undefined {
  if (!value || value.includes('\\') || [...value].some(char => char.charCodeAt(0) < 32)) return undefined
  if (value.startsWith('/') && !value.startsWith('//')) return value
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined } catch { return undefined }
}
export function validateNote(input: NoteInput): void {
  if (!input.title.trim() || input.title.length > 200) throw new Error('请输入 1–200 字的笔记标题。')
  if (!input.content.trim() || input.content.length > 50000) throw new Error('请输入 1–50,000 字的笔记正文。')
  if (!Object.hasOwn(noteSourceNames, input.sourceApp) || input.sourceTitle.length > 500 || input.sourceUrl.length > 2000 || input.sourceUrl && !noteSourceUrl(input.sourceUrl)) throw new Error('笔记来源信息无效，请检查后重试。')
}
function createIdentityNotesApi(identityHeader: string, expectedIdentity: string, mismatchMessage: string): NotesClient {
  const http = axios.create({ baseURL: `${API_BASE}/notes`, withCredentials: true, timeout: 20000 })
  http.interceptors.request.use(config => {
    config.headers.set(identityHeader, expectedIdentity || 'invalid')
    if (config.data) config.data = snakeize(config.data)
    if (config.params) config.params = snakeize(config.params)
    return config
  })
  http.interceptors.response.use(response => { response.data = camelize(response.data); return response }, (error: unknown) => {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined
    if (status === 401) window.dispatchEvent(new Event('portal:unauthorized'))
    return Promise.reject(Object.assign(new Error(status === 409 ? '笔记已在其他页面更新，请保留当前内容并重新打开核对。' : status === 401 ? '登录已失效，请重新登录。' : status === 403 ? mismatchMessage : status === 422 ? '笔记未通过校验，请检查标题、正文长度及来源链接。' : '笔记操作未完成，请检查连接后重试。'), { status }))
  })
  return {
    get: async id => (await http.get(`/${encodeURIComponent(id)}`)).data,
    list: async query => (await http.get('', { params: query })).data,
    create: async (id, input) => { validateNote(input); return (await http.post('', { ...input, id })).data },
    save: async (note, input) => { validateNote(input); return (await http.put(`/${encodeURIComponent(note.id)}`, { ...input, revision: note.revision })).data },
    trash: async note => (await http.post(`/${encodeURIComponent(note.id)}/trash`, { revision: note.revision })).data,
    share: async (note, enabled) => (await http.post(`/${encodeURIComponent(note.id)}/wisdom`, { revision: note.revision, enabled })).data,
    restore: async note => (await http.post(`/${encodeURIComponent(note.id)}/restore`, { revision: note.revision })).data,
  }
}
export function createNotesApi(expectedIdentity: string): NotesClient {
  return createIdentityNotesApi('X-Notes-Identity', expectedIdentity, '工作台和知识库登录的账号不一致，请重新登录。')
}

export function createPortalNotesApi(identityNamespace: string | undefined): NotesClient {
  return createIdentityNotesApi('X-Notes-Portal-Identity', identityNamespace || 'invalid', '登录账号已变化，请保留当前草稿并使用原账号重新登录。')
}

export function createPreviewNotesClient(namespace: string, storage: Storage = localStorage): NotesClient {
  const key = `mberp:personal-notes:preview:v1:${encodeURIComponent(namespace)}`
  const read = (): PersonalNote[] => {
    const raw = storage.getItem(key)
    if (!raw) return []
    try {
      const rows = JSON.parse(raw) as PersonalNote[]
      if (!Array.isArray(rows) || rows.some(row => !row || typeof row.id !== 'string' || typeof row.title !== 'string' || typeof row.content !== 'string' || !Number.isSafeInteger(row.revision) || row.revision < 1 || !Number.isFinite(Date.parse(row.updatedAt)) || !Number.isFinite(Date.parse(row.createdAt)) || row.deletedAt !== null && !Number.isFinite(Date.parse(row.deletedAt)))) throw new Error('invalid')
      rows.forEach(validateNote)
      return rows
    } catch { throw new Error('无法读取本机笔记，已有数据未被覆盖。请保留浏览器数据后重试。') }
  }
  const write = (rows: PersonalNote[]) => { try { storage.setItem(key, JSON.stringify(rows)) } catch { throw new Error('浏览器无法保存笔记，请保留当前正文后重试。') } }
  const change = (note: PersonalNote, patch: Partial<PersonalNote>, expectTrashed: boolean) => {
    const rows = read(), current = rows.find(row => row.id === note.id)
    if (!current) throw new Error('笔记不存在。')
    if (current.revision !== note.revision || !!current.deletedAt !== expectTrashed) throw new Error('笔记已在其他页面更新，请保留当前内容并重新打开核对。')
    const next = { ...current, ...patch, revision: current.revision + 1, updatedAt: new Date().toISOString() }
    write(rows.map(row => row.id === current.id ? next : row)); return structuredClone(next)
  }
  return {
    get: async id => { const note = read().find(row => row.id === id && !row.deletedAt); if (!note) throw new Error('笔记不存在或已移至回收站。'); return structuredClone(note) },
    list: async (query = {}) => {
      const search = query.search?.trim().toLocaleLowerCase() || ''
      const rows = read().filter(note => !!note.deletedAt === !!query.trashed && (!query.sourceApp || note.sourceApp === query.sourceApp) && (!search || `${note.title}\n${note.content}`.toLocaleLowerCase().includes(search))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
      return { items: structuredClone(rows.slice(query.offset || 0, (query.offset || 0) + 50)), total: rows.length }
    },
    create: async (id, input) => {
      validateNote(input)
      const rows = read(), existing = rows.find(row => row.id === id)
      if (existing) {
        if (!existing.deletedAt && Object.keys(input).every(key => existing[key as keyof NoteInput] === input[key as keyof NoteInput])) return structuredClone(existing)
        throw new Error('笔记已创建，请刷新笔记列表后核对。')
      }
      const now = new Date().toISOString(), note = { ...input, id, revision: 1, createdAt: now, updatedAt: now, deletedAt: null }
      write([note, ...rows]); return structuredClone(note)
    },
    save: async (note, input) => { validateNote(input); return change(note, input, false) },
    trash: async note => change(note, { deletedAt: new Date().toISOString() }, false),
    restore: async note => change(note, { deletedAt: null }, true),
  }
}
