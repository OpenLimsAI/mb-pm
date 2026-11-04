import { api } from './client'

export interface TemplateMapping { nodeId: string; taskId: string }
export interface TemplateSubMapping { nodeId: string; subProjectId: string }
export interface TemplateOwnerOverride { nodeId: string; ownerId: string }
export interface TemplateUpgradeCatalog {
  templateId: string | null; templateName: string | null; sourceVersion: string | null; editable: boolean
  versions: { version: string; summary: string | null; nodes: { nodeId: string; code: string; name: string; subNodeId: string }[]; subs: { nodeId: string; name: string }[] }[]
  mappings?: TemplateMapping[]; subMappings?: TemplateSubMapping[]; removedNodes?: string[]
  tasks: { id: string; code: string; name: string }[]; subProjects: { id: string; name: string }[]; members: { id: string; name: string }[]
}
export interface TemplateUpgradeRequest {
  sourceVersion: string; targetVersion: string; mappings: TemplateMapping[]; subMappings: TemplateSubMapping[]; ownerOverrides: TemplateOwnerOverride[]
}
export interface TemplateUpgradeChange {
  id: string; nodeId: string; name: string; kind: 'task' | 'sub'; field: string; label: string
  before: unknown; after: unknown; blocked: string | null; requires: string[]
}
export interface TemplateUpgradePreview {
  fingerprint: string; sourceVersion: string; targetVersion: string
  changes: TemplateUpgradeChange[]; unmapped: { nodeId: string; name: string; kind: string }[]
}
const base = (id: string) => `/projects/${encodeURIComponent(id)}/template-upgrade`
export const templateUpgradeApi = {
  catalog: async (id: string) => (await api.get<TemplateUpgradeCatalog>(base(id))).data,
  preview: async (id: string, value: TemplateUpgradeRequest) => (await api.post<TemplateUpgradePreview>(`${base(id)}/preview`, value)).data,
  apply: async (id: string, value: TemplateUpgradeRequest & { fingerprint: string; selectedIds: string[]; reason: string }) => (await api.post<{ applied: number; remaining: number; templateVersion: string }>(`${base(id)}/apply`, value)).data,
}
