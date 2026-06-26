// Templates API + Excel 导入导出
//
// 注意：拦截器会把请求体转 snake_case，但 multipart FormData 直接透传 —
// 字段名需要在 FormData 里手动用 snake_case。

import { api, camelize } from './client'
import type {
  ImportResultDTO,
  TemplateCreateRequest,
  TemplateDTO,
  TemplateVersionCreateRequest,
  TemplateVersionDTO,
} from './types'

// ============= CRUD =============

export interface TemplatesListParams {
  productType?: string
  isActive?: boolean
}

export async function listTemplates(params: TemplatesListParams = {}): Promise<TemplateDTO[]> {
  const { data } = await api.get<TemplateDTO[]>('/templates', { params })
  return data
}

export async function getTemplate(id: string): Promise<TemplateDTO> {
  const { data } = await api.get<TemplateDTO>(`/templates/${id}`)
  return data
}

export async function createTemplate(payload: TemplateCreateRequest): Promise<TemplateDTO> {
  const { data } = await api.post<TemplateDTO>('/templates', payload)
  return data
}

export interface TemplateUpdateRequest {
  name?: string
  description?: string | null
  isActive?: boolean
}

export async function updateTemplate(id: string, payload: TemplateUpdateRequest): Promise<TemplateDTO> {
  const { data } = await api.patch<TemplateDTO>(`/templates/${id}`, payload)
  return data
}

export async function deleteTemplate(id: string): Promise<void> {
  await api.delete(`/templates/${id}`)
}

export async function addTemplateVersion(
  id: string,
  payload: TemplateVersionCreateRequest,
): Promise<TemplateVersionDTO> {
  const { data } = await api.post<TemplateVersionDTO>(`/templates/${id}/versions`, payload)
  return data
}

// ============= Excel =============

/** 触发浏览器下载 — 给定模板的 xlsx 导出。 */
export async function exportTemplateXlsx(id: string, versionId?: string): Promise<Blob> {
  const { data } = await api.get(`/templates/${id}/export`, {
    params: versionId ? { versionId } : {},
    responseType: 'blob',
  })
  return data as unknown as Blob
}

/** 下载空白导入模板（含说明 + 字典 + 示例 sheet）。 */
export async function downloadImportFormat(): Promise<Blob> {
  const { data } = await api.get('/templates/excel-format', { responseType: 'blob' })
  return data as unknown as Blob
}

export interface ImportExcelOptions {
  file: File
  mode: 'create' | 'overwrite'
  newName?: string
  productType?: string
  templateId?: string
}

export async function importExcel(opts: ImportExcelOptions): Promise<ImportResultDTO> {
  // multipart 不走 axios 的 snake 转换；手动用 snake 字段名
  const form = new FormData()
  form.append('file', opts.file)
  form.append('mode', opts.mode)
  if (opts.newName) form.append('new_name', opts.newName)
  if (opts.productType) form.append('product_type', opts.productType)
  if (opts.templateId) form.append('template_id', opts.templateId)

  const { data } = await api.post('/templates/import', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    // 响应仍走 camelize 拦截器
  })
  return camelize<ImportResultDTO>(data)
}

/** 浏览器侧助手：触发下载一个 Blob。 */
export function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
