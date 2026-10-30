import axios from 'axios'
import { API_BASE, camelize, snakeize } from '../../api/client'
import type { SolutionClient } from './types'

const http = axios.create({ baseURL: `${API_BASE}/solutions`, withCredentials: true, timeout: 70000 })
http.interceptors.request.use(config => {
  if (config.data) config.data = snakeize(config.data)
  if (config.params) config.params = snakeize(config.params)
  return config
})
http.interceptors.response.use(response => {
  if (!(response.data instanceof Blob)) response.data = camelize(response.data)
  return response
}, (error: unknown) => {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status
    if (status === 401) window.dispatchEvent(new Event('solutions:unauthorized'))
    const detail = error.response?.data?.detail
    const message = typeof detail === 'string' ? detail
      : status === 422 ? '内容未通过校验，请检查必填项、内容长度和引用关联。当前草稿仍保留。'
      : status === 409 ? '其他页面已更新此报告。请保留当前草稿，重新载入后比较。'
        : error.code === 'ECONNABORTED' ? '服务响应超时，请稍后重试。当前内容仍保留。'
          : '暂时无法连接服务，请检查网络后重试。'
    return Promise.reject(Object.assign(new Error(message), { status }))
  }
  return Promise.reject(error)
})

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url; link.download = filename; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const solutionApi: SolutionClient = {
  list: async () => (await http.get('')).data,
  trash: async () => (await http.get('/trash')).data,
  remove: async (id, revision) => { await http.post(`/${encodeURIComponent(id)}/trash`, { revision }) },
  restore: async (id, revision) => (await http.post(`/trash/${encodeURIComponent(id)}/restore`, { revision })).data,
  create: async input => (await http.post('', input)).data,
  get: async id => (await http.get(`/${encodeURIComponent(id)}`)).data,
  save: async (id, input) => (await http.put(`/${encodeURIComponent(id)}`, input)).data,
  review: async (id, input) => (await http.post(`/${encodeURIComponent(id)}/review`, input)).data,
  versions: async id => (await http.get(`/${encodeURIComponent(id)}/versions`)).data,
  reviewers: async () => (await http.get('/reviewers')).data,
  sources: async (query = '', projectName = '') => (await http.get('/sources', { params: { query, projectName } })).data,
  getSource: async (id, solutionId) => (await http.get(`/sources/${encodeURIComponent(id)}`, { params: { solutionId } })).data,
  knowledgeStatus: async () => (await http.get('/knowledge/status')).data,
  addSource: async input => (await http.post('/sources', input)).data,
  ask: async (id, input) => (await http.post(`/${encodeURIComponent(id)}/ask`, input, { timeout: 300000 })).data,
  polish: async (id, input) => (await http.post(`/${encodeURIComponent(id)}/polish`, input, { timeout: 300000 })).data,
  history: async id => (await http.get(`/${encodeURIComponent(id)}/history`)).data,
  exportWord: async id => {
    const { data } = await http.get(`/${encodeURIComponent(id)}/export`, { responseType: 'blob' })
    downloadBlob(data, `研究报告-${id}.docx`)
  },
  publish: async id => (await http.post(`/${encodeURIComponent(id)}/publish`)).data,
}
