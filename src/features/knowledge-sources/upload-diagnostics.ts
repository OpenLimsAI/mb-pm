import axios from 'axios'

const CODES = new Set(['ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT', 'ERR_CANCELED', 'ERR_BAD_REQUEST', 'ERR_BAD_RESPONSE', 'ERR_INVALID_URL', 'ERR_FR_TOO_MANY_REDIRECTS', 'ERR_NOT_SUPPORT'])
export interface UploadAttempt {
  trace: string
  stage: 'uploading' | 'processing'
  loadedBytes: number | null
  totalBytes: number | null
}
export interface UploadDiagnostic extends UploadAttempt {
  elapsedSeconds: number
  code: string
  status: number | null
}

export function uploadByteCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

export function summarizeUploadFailure(error: unknown, attempt: UploadAttempt, elapsedMilliseconds: number): UploadDiagnostic {
  const result: UploadDiagnostic = {
    trace: /^[0-9a-f]{32}$/.test(attempt.trace) ? attempt.trace : '',
    stage: attempt.stage === 'processing' ? 'processing' : 'uploading',
    loadedBytes: uploadByteCount(attempt.loadedBytes),
    totalBytes: uploadByteCount(attempt.totalBytes),
    elapsedSeconds: Number.isFinite(elapsedMilliseconds) ? Math.max(0, Math.round(elapsedMilliseconds / 1000)) : 0,
    code: 'UPLOAD_FAILED', status: null,
  }
  if (axios.isAxiosError(error)) {
    if (error.code && CODES.has(error.code)) result.code = error.code
    const status = error.response?.status
    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) result.status = status
  }
  return result
}
