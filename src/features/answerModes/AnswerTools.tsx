import { BookOpen, Check, ChevronDown, ExternalLink, FolderOpen, Globe, Sparkles } from 'lucide-react'
import type { AnswerCapabilities, AnswerMode, AnswerProvenance } from './types'
import { safeWebSourceUrl } from './sourceUrl'
import './answerTools.css'

const answerModeLabels = { auto: '自动', general: '通用回答', knowledge: '知识库回答', web: '联网检索', application: '应用数据回答' }
export function AnswerModeControl({ value, onChange, disabled = false }: { value: AnswerMode; onChange: (value: AnswerMode) => void; disabled?: boolean }) {
  return <label className="qa-mode-control"><Sparkles size={13} /><span>回答方式</span><select aria-label="回答方式" value={value} disabled={disabled} onChange={event => onChange(event.target.value as AnswerMode)}><option value="auto">自动 · 按问题判断</option><option value="general">通用回答 · 不联网</option><option value="knowledge">仅知识库</option><option value="web">联网检索</option></select><ChevronDown size={12} /></label>
}
export function SearchCapability({ value, preview = false }: { value: AnswerCapabilities | null; preview?: boolean }) {
  const ready = !preview && value?.webSearch.configured
  const title = preview ? '联网搜索界面演示' : ready ? value.webSearch.provider === 'deepseek' ? 'DeepSeek 官方搜索已就绪' : '联网搜索已就绪' : value ? '联网搜索暂不可用' : '联网搜索状态待确认'
  return <div className={`qa-capability${ready ? ' is-ready' : ''}`}><Globe size={15} /><div><strong>{title}</strong><p>{preview ? '当前可预览自动判断、检索流程和来源展示；演示不会实际联网。' : value?.webSearch.message || '自动模式会按问题选择回答方式；联网可用状态暂未确认。'}</p></div></div>
}
function dateLabel(value?: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return '未提供日期'
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  return new Date(value).toLocaleDateString('zh-CN')
}
export function AnswerEvidence({ answer, preview = false, part = 'all' }: { answer: AnswerProvenance; preview?: boolean; part?: 'all' | 'status' | 'sources' }) {
  const web = answer.webReferences || []
  const usedSources = ['projects', 'knowledge'].filter(source => answer.usedSources?.includes(source as 'projects' | 'knowledge')).map(source => source === 'projects' ? '项目管理' : '知识库')
  if (!answer.answerMode && !preview && !web.length || part === 'sources' && !web.length) return null
  const Icon = answer.answerMode === 'web' ? Globe : answer.answerMode === 'knowledge' ? BookOpen : answer.answerMode === 'application' ? FolderOpen : Sparkles
  return <div className="qa-evidence">{part !== 'sources' && <><div className="qa-answer-status"><span className={`qa-mode-badge qa-mode-${answer.answerMode || 'general'}`}><Icon size={12} />{answer.answerMode === 'web' ? preview ? '联网检索流程演示' : '已联网检索' : answer.answerMode ? answerModeLabels[answer.answerMode] : '回答演示'}</span>{preview && <strong className="qa-demo-label">{answer.answerMode === 'application' ? '界面演示 · 未读取真实项目数据' : '界面演示 · 未实际联网'}</strong>}{answer.usedSources && <span className="qa-used-sources">{usedSources.length ? `${preview ? '本轮演示范围' : '本轮应用数据'}：${usedSources.join('、')}` : '本轮未读取应用数据'}</span>}</div>{answer.modeReason && <p className="qa-mode-reason">{answer.modeReason}</p>}{preview && answer.answerMode === 'web' && <ol className="qa-demo-steps" aria-label="演示搜索流程">{['判断需要新资料', '搜索并阅读来源', '整理带引用的回答'].map(step => <li key={step}><Check size={12} />{step}</li>)}</ol>}</>}{part !== 'status' && web.length > 0 && <section className="qa-web-sources" aria-label={preview ? '演示来源卡片' : '本轮网络来源'}><h4>{preview ? '来源卡片示例' : `本轮检索来源 · ${web.length} 项`}</h4><div>{web.map((source, index) => {
    const href = safeWebSourceUrl(source.url)
    return <article className="qa-source-card" key={source.id}><div className="qa-source-title"><span>{index + 1}</span>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{source.title}<ExternalLink size={12} /></a> : <strong>{source.title}</strong>}</div>{href && <small className="qa-source-host">{new URL(href).hostname}</small>}{source.excerpt && <><p>{source.excerpt.slice(0, 400)}{source.excerpt.length > 400 ? '…' : ''}</p>{source.excerpt.length > 400 && <details className="qa-source-more"><summary>展开来源摘要</summary><p>{source.excerpt.slice(400)}</p></details>}</>}<small>发表：{dateLabel(source.publishedAt)}<span> · {preview ? '演示记录' : '检索'}：{dateLabel(source.retrievedAt)}</span></small></article>
  })}</div></section>}</div>
}
