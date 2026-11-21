import axios, { type AxiosInstance } from 'axios'
import { API_BASE, camelize, snakeize } from '../../api/client'
import type { SourceDefinition } from './types'

/**
 * Shared portal-cookie HTTP client factory for Knowledge Sources.
 * Never attaches Core credentials or PM localStorage tokens.
 */
export function createKnowledgeClient(subpath = '', timeout = 30000): AxiosInstance {
  const instance = axios.create({
    baseURL: `${API_BASE}/knowledge-sources${subpath}`,
    withCredentials: true,
    timeout,
  })
  instance.interceptors.response.use(
    response => response,
    error => {
      if (error.response?.status === 401) {
        window.dispatchEvent(new Event('portal:unauthorized'))
      }
      return Promise.reject(error)
    },
  )
  return instance
}

/**
 * Decode JSON payloads while preserving dynamic dictionary keys (`folderCounts`,
 * `scopeStatus`, `reading`) so IDs/paths containing underscores are never mutated.
 */
export function decodeKnowledgePayload<T>(raw: unknown): T {
  const result = camelize<Record<string, unknown>>(raw)
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>
    if ('reading' in record) {
      const reading = record.reading
      if (reading && typeof reading === 'object' && !Array.isArray(reading)) {
        result.reading = Object.fromEntries(
          Object.entries(reading as Record<string, unknown>).map(([path, entry]) => [
            path,
            camelize(entry),
          ]),
        )
      }
    }
    const rawCounts = record.folderCounts ?? record.folder_counts
    if (rawCounts && typeof rawCounts === 'object' && !Array.isArray(rawCounts)) {
      result.folderCounts = Object.fromEntries(
        Object.entries(rawCounts as Record<string, unknown>).map(([id, count]) => [
          id,
          Number(count) || 0,
        ]),
      )
    }
    const rawSources = record.sources
    if (Array.isArray(rawSources) && Array.isArray(result.sources)) {
      result.sources = (result.sources as SourceDefinition[]).map((src, idx) => {
        const rawSrc = rawSources[idx] as Record<string, unknown> | undefined
        const rawScopeStatus = rawSrc?.scopeStatus ?? rawSrc?.scope_status
        if (rawScopeStatus && typeof rawScopeStatus === 'object' && !Array.isArray(rawScopeStatus)) {
          return {
            ...src,
            scopeStatus: Object.fromEntries(
              Object.entries(rawScopeStatus as Record<string, unknown>).map(([key, val]) => [
                key,
                camelize(val),
              ]),
            ),
          } as SourceDefinition
        }
        return src
      })
    }
  }
  return result as T
}

/**
 * Encode request bodies while preserving user-defined `metadata` keys verbatim.
 */
export function encodeKnowledgeBody(body: unknown): unknown {
  const encoded = snakeize(body)
  if (
    body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    'metadata' in body &&
    encoded &&
    typeof encoded === 'object' &&
    !Array.isArray(encoded)
  ) {
    const rawMetadata = (body as { metadata?: unknown }).metadata
    if (rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)) {
      ;(encoded as Record<string, unknown>).metadata = rawMetadata
    }
  }
  return encoded
}

export function readErrorBlobText(payload: unknown): Promise<string | null> {
  if (!payload || typeof payload !== 'object') return Promise.resolve(null)
  if (typeof (payload as { text?: unknown }).text === 'function') {
    return (payload as Blob).text()
  }
  if (payload instanceof Blob || Object.prototype.toString.call(payload) === '[object Blob]') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => reject(reader.error)
      reader.readAsText(payload as Blob)
    })
  }
  return Promise.resolve(null)
}

export function safeExternalHref(url?: string | null): string | undefined {
  if (!url) return undefined
  const trimmed = url.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? trimmed : undefined
  } catch {
    return undefined
  }
}
