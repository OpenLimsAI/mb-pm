import axios from 'axios'
import {
  createKnowledgeClient,
  decodeKnowledgePayload,
  encodeKnowledgeBody,
  safeExternalHref,
} from './http'
import {
  SCOPE_NAMES,
  findInboxFolder,
  isInboxFolder,
  type ImportedReference,
  type KnowledgeSourceSnapshot,
  type ReferenceOrigin,
  type SourceDefinition,
  type SourceDocument,
  type SourceEvent,
  type SourceFolder,
  type SourceJob,
  type SourceJobItem,
  type SourcePaper,
  type SourceScopeStatus,
  type SourceVersionSummary,
} from './types'

export {
  SCOPE_NAMES,
  findInboxFolder,
  isInboxFolder,
  safeExternalHref,
  type ImportedReference,
  type KnowledgeSourceSnapshot,
  type ReferenceOrigin,
  type SourceDefinition,
  type SourceDocument,
  type SourceEvent,
  type SourceFolder,
  type SourceJob,
  type SourceJobItem,
  type SourcePaper,
  type SourceScopeStatus,
  type SourceVersionSummary,
}

const client = createKnowledgeClient('', 30000)

export const getKnowledgeSources = (signal?: AbortSignal) =>
  client
    .get('/snapshot', { signal, params: { summary: true } })
    .then(r => decodeKnowledgePayload<KnowledgeSourceSnapshot>(r.data))

export const getKnowledgeSourceJobs = (signal?: AbortSignal) =>
  client
    .get('/jobs/status', { signal })
    .then(r => decodeKnowledgePayload<{ jobs: SourceJob[]; refreshedAt: string }>(r.data))

export const mutateKnowledgeSources = (method: 'post' | 'patch', path: string, value: unknown) =>
  client
    .request({
      method,
      url: path,
      data: encodeKnowledgeBody(value),
      ...(path === '/folders/inbox' ? { timeout: 60000 } : {}),
    })
    .then(r => decodeKnowledgePayload(r.data))

export function sourceError(error: unknown, readTarget?: string): string {
  const explain = (message: string) => (readTarget ? `${readTarget}未能刷新。${message}` : message)
  const retryRead = readTarget && `${readTarget}未能刷新，请重试。`
  if (axios.isAxiosError(error)) {
    const detail = error.response?.data?.detail
    const message =
      typeof detail === 'string'
        ? detail
        : detail && typeof detail === 'object'
          ? detail.message
          : undefined
    if (
      typeof message === 'string' &&
      message.trim() &&
      message.length <= 1000 &&
      !/<[!/a-z][^>]*>/i.test(message) &&
      !/(?:Traceback\b|(?:^|\n)\s*(?:File ".+?", line \d+|at \S+))/m.test(message)
    ) {
      return explain(message)
    }
    const status = error.response?.status
    if (status === 413) return explain('请求内容过大，请减少本次提交的内容后重试。')
    if (status === 409) return explain('资料或任务状态已更新，请刷新后重试。')
    if (status === 403) return explain('当前账号没有此操作权限，请检查知识库角色。')
    if (status === 429) return explain('来源请求过于频繁，请稍后重试。')
    if (status === 422) return explain('操作参数未通过校验，请检查选择数量与设置。')
    if (
      status === 408 ||
      status === 504 ||
      error.code === 'ECONNABORTED' ||
      error.code === 'ETIMEDOUT'
    ) {
      return retryRead || '响应超时，已加载资料仍保留，请核对保存结果后重试。'
    }
    if (status === 502 || status === 503) {
      return explain('知识源或知识库服务暂不可用，请稍后重试。')
    }
    if (status !== undefined && status >= 500) {
      return explain('知识源服务处理失败，请稍后重试。')
    }
    return retryRead || '暂时无法连接知识源，已加载资料仍保留，请重试连接。'
  }
  return retryRead || '暂时无法完成操作，请刷新后重试。'
}

export const importKnowledgeReference = (
  input: ReferenceOrigin & { referenceId: string; download: boolean },
) =>
  client
    .post('/references', encodeKnowledgeBody(input))
    .then(r => decodeKnowledgePayload<ImportedReference>(r.data))
