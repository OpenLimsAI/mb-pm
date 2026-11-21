const FILE_LIMIT = 25 * 1024 * 1024
const READ_CODES = new Set(['NotReadableError', 'NotFoundError', 'SecurityError', 'FILE_SIZE_CHANGED', 'FILE_TOO_LARGE'])
export class LocalFileReadFailure extends Error {
  code: string
  constructor(code?: string) {
    super('无法读取此 PDF。请先下载到本机，再重新选择。')
    this.name = 'LocalFileReadFailure'
    this.code = code && READ_CODES.has(code) ? code : 'FILE_READ_FAILED'
  }
}

export function snapshotLocalPdf(file: File, signal: AbortSignal): Promise<File> {
  if (signal.aborted) return Promise.reject(new DOMException('', 'AbortError'))
  if (file.size > FILE_LIMIT) return Promise.reject(new LocalFileReadFailure('FILE_TOO_LARGE'))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const finish = (action: () => void) => {
      signal.removeEventListener('abort', abort)
      reader.onload = reader.onerror = reader.onabort = null
      action()
    }
    const rejectAbort = () => finish(() => reject(new DOMException('', 'AbortError')))
    function abort() {
      if (reader.readyState === FileReader.LOADING) reader.abort()
      else rejectAbort()
    }
    reader.onabort = rejectAbort
    reader.onerror = () => finish(() => reject(new LocalFileReadFailure(reader.error?.name)))
    reader.onload = () => {
      if (signal.aborted) { rejectAbort(); return }
      const buffer = reader.result
      if (!(buffer instanceof ArrayBuffer)) { finish(() => reject(new LocalFileReadFailure())); return }
      if (buffer.byteLength !== file.size) { finish(() => reject(new LocalFileReadFailure('FILE_SIZE_CHANGED'))); return }
      try {
        const snapshot = new File([buffer], file.name, { type: file.type, lastModified: file.lastModified })
        finish(() => resolve(snapshot))
      } catch { finish(() => reject(new LocalFileReadFailure())) }
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    try { reader.readAsArrayBuffer(file) }
    catch (error) { finish(() => reject(new LocalFileReadFailure(error instanceof DOMException ? error.name : undefined))) }
  })
}
