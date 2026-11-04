import axios from 'axios'
import { api } from './client'

export interface ProjectExcelPreview {
  projectId: string
  rowCount: number
  changedCount: number
  canApply: boolean
  fingerprint: string
  errorLimit: number
  errors: { row: number; column: string; message: string }[]
  changes: {
    row: number
    taskId: string
    taskName: string
    resubmitAcceptance: boolean
    changes: { field: string; before: string | number | null; after: string | number | null }[]
  }[]
}

const path = (projectId: string) => `/project-exchange/projects/${encodeURIComponent(projectId)}`

export const projectExchange = {
  async export(projectId: string, signal?: AbortSignal): Promise<Blob> {
    try {
      return (await api.get(`${path(projectId)}/export`, { responseType: 'blob', signal, timeout: 60000 })).data
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.data instanceof Blob) {
        try {
          const body = JSON.parse(await error.response.data.text()) as { detail?: string }
          if (typeof body.detail === 'string') throw new Error(body.detail, { cause: error })
        } catch (parsed) { if (parsed instanceof Error && !(parsed instanceof SyntaxError)) throw parsed }
      }
      throw error
    }
  },
  async preview(projectId: string, file: File, signal?: AbortSignal): Promise<ProjectExcelPreview> {
    const form = new FormData()
    form.append('file', file)
    return (await api.post(`${path(projectId)}/preview`, form, { signal, timeout: 60000 })).data
  },
  async apply(projectId: string, file: File, fingerprint: string, reason: string): Promise<{ updatedCount: number }> {
    const form = new FormData()
    form.append('file', file)
    form.append('fingerprint', fingerprint)
    form.append('reason', reason)
    return (await api.post(`${path(projectId)}/apply`, form, { timeout: 60000 })).data
  },
}
