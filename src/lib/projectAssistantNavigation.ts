import type { PMAIScenario } from '../api/pmAI'

export type ProjectAssistantMode = PMAIScenario | 'agent' | 'schedule' | 'schedule-assist' | 'assessment' | 'finance' | 'settings' | 'proposal'

const modes: ProjectAssistantMode[] = ['agent', 'priorities', 'explain', 'weekly', 'meeting', 'followup', 'schedule', 'schedule-assist', 'assessment', 'finance', 'settings', 'proposal']

export function assistantMode(value: string | null): ProjectAssistantMode | null {
  return modes.includes(value as ProjectAssistantMode) ? value as ProjectAssistantMode : null
}

export function projectAssistantUrl(mode: ProjectAssistantMode = 'agent', projectId?: string) {
  const path = projectId ? `/projects/${encodeURIComponent(projectId)}` : '/project-assistant'
  return `${path}?${new URLSearchParams({ assistant: mode })}`
}
