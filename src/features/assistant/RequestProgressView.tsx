import { useEffect, useState } from 'react'
import { Copy, LoaderCircle, Square } from 'lucide-react'
import type { RequestProgress } from './useAssistantRequests'
import MarkdownView from './MarkdownView'

const labels: Record<string, string> = { queued: '问题已保存，等待处理…', waiting_model: '正在等待模型响应…', recovering: '正在继续整理回答…', generating: '正在生成回答…', saving: '正在保存完整回答…' }
export default function RequestProgressView({ progress, onCancel, onRetry, onContinue, onCopyDraft, onCopyDiagnostic, onSettings, onEditQuestion, preview }: { progress: RequestProgress; onCancel?: () => void | Promise<void>; onRetry?: () => void; onContinue?: () => void; onCopyDraft?: (text: string) => void; onCopyDiagnostic?: (text: string) => void; onSettings?: () => void; onEditQuestion?: () => void; preview?: boolean }) {
  const [now, setNow] = useState(() => Date.now()), [cancelling, setCancelling] = useState(false)
  const job = progress.job, failed = progress.phase === 'failed', cancelled = job?.status === 'cancelled'
  useEffect(() => { if (failed) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [failed])
  const elapsed = job ? Math.max(0, Math.floor(((job.finishedAt ? Date.parse(job.finishedAt) : now) - Date.parse(job.createdAt)) / 1000)) : 0
  const label = cancelled ? '已停止生成' : failed ? '本次生成未完成' : progress.message || (job ? labels[job.stage] || '正在处理问题…' : '正在检查回答进度…')
  const code = job?.errorCode || ''
  const needsModel = ['model_auth', 'model_rejected', 'model_rate_limit'].includes(code)
  const needsScope = /^(web_|knowledge_|project_)/.test(code)
  const tooLong = ['output_limit', 'response_too_large'].includes(code)
  const rawFailureReason = job?.error || progress.message || '未能读取这次回答的状态，请重新打开任务核对。'
  const diagnosticSuffix = job?.diagnosticId ? `（诊断编号：${job.diagnosticId}）` : ''
  const failureReason = diagnosticSuffix && rawFailureReason.endsWith(diagnosticSuffix) ? rawFailureReason.slice(0, -diagnosticSuffix.length).trimEnd() : rawFailureReason
  const diagnostic = job ? `任务编号：${job.taskId}\n请求编号：${job.requestId}\n诊断编号：${job.diagnosticId || '尚未生成'}\n状态：${job.status}\n错误类型：${job.errorCode || '未提供'}\n提交时间：${job.createdAt}` : ''
  return <section className={`aa-request-progress${cancelled ? ' is-cancelled' : failed ? ' is-failed' : ''}`} aria-label="本轮生成进度">
    <div className="aa-thinking" role="status">{!failed && <LoaderCircle size={16} className="aa-spin" />}<strong>{label}</strong>{job && Number.isFinite(elapsed) && <span>已用时 {elapsed < 60 ? `${elapsed} 秒` : `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`}</span>}</div>
    {job && <div className="aa-pending-question"><span>本轮提问</span><p>{job.question}</p>{job.context && <details className="aa-context-details"><summary>已保存的本轮资料 · {job.context.length.toLocaleString()} 字</summary><pre>{job.context}</pre></details>}</div>}
    {job?.payloadExpired && <p>这次请求的临时输入已按保留策略清理，已保存的完整回答不受影响。可以重新输入问题发起新一轮。</p>}
    {failed && !cancelled && <div role="alert"><p>{failureReason}</p>{job && <details><summary>诊断信息</summary><pre>{diagnostic}</pre></details>}</div>}
    {job?.partialContent && <div className="aa-partial-answer"><span>{failed ? '未完成草稿 · 已保留正文，使用前请核对' : '正在生成，以下内容尚未完成'}</span><MarkdownView>{job.partialContent}</MarkdownView></div>}
    {failed && tooLong && <p className="aa-request-hint">可以先处理一个主题，再分步展开。编辑问题后，由你决定何时发送。</p>}
    <div className="aa-request-actions">
      {!failed && job && ['queued', 'running'].includes(job.status) && onCancel && <button type="button" className="aa-button" disabled={cancelling} onClick={() => { setCancelling(true); void Promise.resolve(onCancel()).finally(() => setCancelling(false)) }}><Square size={13} />{cancelling ? '正在确认停止…' : '停止生成'}</button>}
      {failed && needsModel && <a className="aa-button" href={`/model-settings${preview ? '?preview=1' : ''}`} target="_blank" rel="noreferrer">检查模型设置</a>}
      {failed && needsScope && onSettings && <button type="button" className="aa-button" onClick={onSettings}>检查数据与搜索设置</button>}
      {failed && tooLong && onEditQuestion && <button type="button" className="aa-button" onClick={onEditQuestion}>编辑问题</button>}
      {failed && !job?.payloadExpired && !!job?.question.trim() && onRetry && <button type="button" className="aa-button" onClick={onRetry}>重新生成</button>}
      {failed && !job?.payloadExpired && !!job?.question.trim() && job?.canContinue && onContinue && <button type="button" className="aa-button aa-primary" onClick={onContinue}>根据草稿重新整理</button>}
      {!!job?.partialContent && onCopyDraft && <button type="button" className="aa-button" onClick={() => onCopyDraft(job.partialContent)}><Copy size={13} />复制未完成草稿</button>}
      {failed && job && onCopyDiagnostic && <button type="button" className="aa-button" onClick={() => onCopyDiagnostic(diagnostic)}><Copy size={13} />复制诊断信息</button>}
    </div>
    {job && !failed && progress.phase !== 'auth' && <p className="aa-request-hint">可以离开此页面，稍后回到任务查看结果。停止后会保留已生成草稿。</p>}
  </section>
}
