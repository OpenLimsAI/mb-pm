import { LoaderCircle } from 'lucide-react'
import type { RequestProgress } from './useAssistantRequests'
import MarkdownView from './MarkdownView'

const labels: Record<string, string> = {
  queued: '问题已保存，等待处理…',
  waiting_model: '正在等待模型响应…',
  generating: '正在生成回答…',
  saving: '正在保存完整回答…',
}
export default function RequestProgressView({ progress }: { progress: RequestProgress }) {
  const job = progress.job
  const failed = progress.phase === 'failed'
  const label = failed ? '本次生成未完成' : progress.message || (job ? labels[job.stage] || '正在处理问题…' : '正在检查回答进度…')
  return <section className={`aa-request-progress${failed ? ' is-failed' : ''}`} aria-label="本轮生成进度">
    <div className="aa-thinking" role="status">{!failed && <LoaderCircle size={16} className="aa-spin" />}<strong>{label}</strong></div>
    {job && <div className="aa-pending-question"><span>本轮提问</span><p>{job.question}</p>{job.context && <details className="aa-context-details"><summary>已保存的本轮资料 · {job.context.length.toLocaleString()} 字</summary><pre>{job.context}</pre></details>}</div>}
    {job?.partialContent && <div className="aa-partial-answer"><span>{failed ? '未完成的部分内容，不能作为完整回答' : '正在生成，以下内容尚未完成'}</span><MarkdownView>{job.partialContent}</MarkdownView></div>}
    {job && !failed && progress.phase !== 'auth' && <p className="aa-request-hint">可以离开此页面，稍后回到任务查看结果。</p>}
  </section>
}
