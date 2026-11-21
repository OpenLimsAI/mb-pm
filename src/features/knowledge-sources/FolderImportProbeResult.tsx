import { Check, TriangleAlert } from 'lucide-react'
import type { FolderImportProbe } from './folder-import-api'

export default function FolderImportProbeResult({ result }: { result: FolderImportProbe }) {
  const { fileCount, truncated, errors = [] } = result
  if (fileCount === null) return <p role="status" className="kso-small">目录可访问</p>
  if (fileCount === 0) return <p role="status" className="kso-small">此目录暂未发现 PDF。</p>

  const readable = fileCount - errors.length
  const summary = `发现 ${fileCount} 份 PDF${truncated ? '（本次检查范围）' : ''}`
  if (errors.length === 0) return <p role="status" className="kso-import-probe"><Check aria-hidden="true" />{summary}</p>

  const reasons = new Map<string, number>()
  for (const item of errors) {
    const reason = item.error || '未能读取文件'
    reasons.set(reason, (reasons.get(reason) || 0) + 1)
  }
  return <div role="status" className="kso-import-probe-issues">
    <p><TriangleAlert aria-hidden="true" />{summary}，可读取 {readable} 份。</p>
    <ul aria-label="文件读取失败原因">
      {Array.from(reasons, ([reason, count]) => <li key={reason}>{reason}（{count} 份）</li>)}
    </ul>
  </div>
}
