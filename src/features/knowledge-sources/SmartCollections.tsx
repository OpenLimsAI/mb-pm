import { useState } from 'react'
import { BookmarkPlus, FolderCheck, Play, Trash2 } from 'lucide-react'
import { knowledgeV3Post } from './v3-api'
import { sourceError } from './api'
import type { CollectionQuery, FilingRule, RuleResult, WorkspaceState } from './workspace-v3-types'
import './research-tools-v3.css'

export interface SmartCollectionsProps {
  state: WorkspaceState | null
  query?: CollectionQuery
  folders?: { id: string; name: string }[]
  canOrganize?: boolean
  onChoose: (query: CollectionQuery, id: string) => void
  onChanged: (state: WorkspaceState) => void
  onOrganized?: (result: RuleResult) => void
}
interface Preview { total: number; changeCount: number; papers: { id: string; title: string }[]; previewDigest: string }
export default function SmartCollections({ state, query = {}, folders = [], canOrganize = false, onChoose, onChanged, onOrganized }: SmartCollectionsProps) {
  const [name, setName] = useState(''), [target, setTarget] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{ rule: FilingRule; value: Preview } | null>(null)
  async function save(rule: boolean) {
    if (!state || !name.trim()) return
    setBusy(true); setMessage('')
    try {
      const next = await knowledgeV3Post<WorkspaceState>(`/workspace/${rule ? 'rules' : 'collections'}`, { name: name.trim(), query, revision: state.revision, ...(rule ? { targetFolderIds: [target], enabled: false } : {}) })
      onChanged(next); setName(''); setMessage(rule ? '规则已保存且自动执行关闭。预览匹配后可执行，也可明确启用后用于新下载资料。' : '智能集合已保存，内容随筛选条件动态更新。')
    } catch (error) { setMessage(sourceError(error)) } finally { setBusy(false) }
  }
  async function update(rule: FilingRule, change: { enabled?: boolean; deleted?: boolean }) {
    if (!state) return
    setBusy(true); setMessage('')
    try { onChanged(await knowledgeV3Post<WorkspaceState>('/workspace/rules', { id: rule.id, name: rule.name, query: rule.query, targetFolderIds: rule.targetFolderIds, enabled: rule.enabled, ...change, revision: state.revision })); setPreview(null) }
    catch (error) { setMessage(sourceError(error)) } finally { setBusy(false) }
  }
  async function check(rule: FilingRule) {
    setBusy(true); setMessage('')
    try { setPreview({ rule, value: await knowledgeV3Post<Preview>(`/workspace/rules/${encodeURIComponent(rule.id)}/preview`, {}) }) }
    catch (error) { setMessage(sourceError(error)) } finally { setBusy(false) }
  }
  async function apply() {
    if (!preview) return
    setBusy(true); setMessage('')
    try {
      const result = await knowledgeV3Post<RuleResult>(`/workspace/rules/${encodeURIComponent(preview.rule.id)}/apply`, { previewDigest: preview.value.previewDigest })
      setMessage(result.saved ? `已归档 ${result.count} 篇，保留原有分类及原件。` : `已归档 ${result.count} 篇，其余未完成：${result.error || '请刷新后重试'}。已完成部分仍可撤销。`)
      setPreview(null); onOrganized?.(result)
    } catch (error) { setMessage(sourceError(error)) } finally { setBusy(false) }
  }
  async function remove(id: string, title: string, value: CollectionQuery) {
    if (!state) return
    setBusy(true); setMessage('')
    try { onChanged(await knowledgeV3Post<WorkspaceState>('/workspace/collections', { id, name: title, query: value, deleted: true, revision: state.revision })); setMessage('已删除智能集合，论文及文件夹均保留。') }
    catch (error) { setMessage(sourceError(error)) } finally { setBusy(false) }
  }
  return <section className="kso-v3-section" aria-label="智能集合与归档规则">
    <details><summary><BookmarkPlus size={16} />智能集合与归档规则 <small>{state?.collections.length || 0} 个集合 · {state?.rules.filter(rule => rule.enabled).length || 0} 条自动规则</small></summary>
      <p className="kso-small">保存当前筛选为动态集合，或把相同条件设为归档规则。规则只增加文件夹关联，自动规则仅用于你发起的新下载资料。</p>
      <div className="kso-v3-collection-list">{state?.collections.map(collection => <div key={collection.id}><button className="kso-btn" onClick={() => onChoose(collection.query, collection.id)}>{collection.name}</button><button className="kso-icon-btn" aria-label={`删除智能集合 ${collection.name}`} disabled={busy} onClick={() => void remove(collection.id, collection.name, collection.query)}><Trash2 size={14} /></button></div>)}</div>
      <div className="kso-v3-row"><label>集合或规则名称<input aria-label="集合或规则名称" maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="例如：质量指南待读" /></label><button className="kso-btn" disabled={busy || !state || !name.trim()} onClick={() => void save(false)}><BookmarkPlus size={16} />保存当前筛选</button>
        {canOrganize && <><label>归档目标<select aria-label="规则归档目标" value={target} onChange={event => setTarget(event.target.value)}><option value="">选择文件夹</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label><button className="kso-btn" disabled={busy || !state || !name.trim() || !target} onClick={() => void save(true)}><FolderCheck size={16} />保存规则</button></>}
      </div>
      {state?.rules.map(rule => <article key={rule.id} className="kso-v3-rule"><div><strong>{rule.name}</strong><small>归入：{rule.targetFolderIds.map(id => folders.find(folder => folder.id === id)?.name || '文件夹已删除').join('、')}</small></div><label className="kso-check"><input type="checkbox" aria-label={`自动归档 ${rule.name}`} checked={rule.enabled} disabled={busy || !canOrganize} onChange={event => void update(rule, { enabled: event.target.checked })} />新下载时自动执行</label><button className="kso-btn" disabled={busy || !canOrganize} onClick={() => void check(rule)}>预览匹配</button><button className="kso-icon-btn" aria-label={`删除归档规则 ${rule.name}`} disabled={busy || !canOrganize} onClick={() => void update(rule, { deleted: true })}><Trash2 size={14} /></button></article>)}
      {preview && <div className="kso-v3-preview"><strong>{preview.rule.name}：匹配 {preview.value.total} 篇，需要归档 {preview.value.changeCount} 篇</strong><ul>{preview.value.papers.map(paper => <li key={paper.id}>{paper.title}</li>)}</ul>{preview.value.changeCount > preview.value.papers.length && <p>其余 {preview.value.changeCount - preview.value.papers.length} 篇也将按同一条件处理。</p>}<div className="kso-v3-row"><button className="kso-btn primary" disabled={busy || !preview.value.changeCount} onClick={() => void apply()}><Play size={16} />确认归档 {preview.value.changeCount} 篇</button><button className="kso-btn" disabled={busy} onClick={() => setPreview(null)}>关闭预览</button></div></div>}
      {message && <p role="status">{message}</p>}
    </details>
  </section>
}
