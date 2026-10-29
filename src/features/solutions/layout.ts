export type WorkspaceModule = 'editor' | 'knowledge' | 'ai'
export type WorkspaceArrangement = 'columns' | 'left-main' | 'right-main' | 'top-pair'
export type WorkspaceLayout = {
  arrangement: WorkspaceArrangement
  order: [WorkspaceModule, WorkspaceModule, WorkspaceModule]
}

export const moduleLabels: Record<WorkspaceModule, string> = {
  editor: '撰写报告',
  knowledge: '知识库资料',
  ai: 'AI 研究助手',
}

export const arrangementLabels: Record<WorkspaceArrangement, string> = {
  columns: '横向三个',
  'left-main': '左一右上下',
  'right-main': '左上下右一',
  'top-pair': '上二下一',
}

export const defaultWorkspaceLayout: WorkspaceLayout = {
  arrangement: 'left-main',
  order: ['editor', 'knowledge', 'ai'],
}

export const WORKSPACE_LAYOUT_STORAGE_KEY = 'ks-workspace-layout'

const modules: WorkspaceModule[] = ['editor', 'knowledge', 'ai']
const arrangements: WorkspaceArrangement[] = ['columns', 'left-main', 'right-main', 'top-pair']

export function isWorkspaceLayout(value: unknown): value is WorkspaceLayout {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.arrangement === 'string'
    && arrangements.some(arrangement => arrangement === candidate.arrangement)
    && Array.isArray(candidate.order)
    && candidate.order.length === modules.length
    && modules.every(module => (candidate.order as unknown[]).includes(module))
}

function copyLayout(layout: WorkspaceLayout): WorkspaceLayout {
  return { arrangement: layout.arrangement, order: [...layout.order] }
}

export function readWorkspaceLayout(): WorkspaceLayout {
  try {
    const stored = window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)
    if (stored !== null) {
      const parsed: unknown = JSON.parse(stored)
      if (isWorkspaceLayout(parsed)) return copyLayout(parsed)
    }
  } catch {
    // Private browsing or unavailable storage should not prevent opening the workspace.
  }
  return copyLayout(defaultWorkspaceLayout)
}

// Short alias used by the workspace persistence effect.
export const WORKSPACE_LAYOUT_KEY = WORKSPACE_LAYOUT_STORAGE_KEY
