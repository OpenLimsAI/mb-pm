import { useCallback, useEffect, useState } from 'react'
import { Bell, Check, ExternalLink, RefreshCw } from 'lucide-react'
import { knowledgeV3Get, knowledgeV3Post } from './v3-api'
import { sourceError } from './api'
import './acquisition-v3.css'

interface Watch {id:string;name:string;sourceIds:string[];keywords:string;codes:string;kinds:string[];muted:boolean}
interface DigestEvent {id:string;documentId?:string;title:string;kind:string;createdAt:string;read:boolean}
function watchBody(w:Watch,extra:Record<string,unknown>){return {id:w.id,name:w.name,sourceIds:w.sourceIds,keywords:w.keywords,codes:w.codes,kinds:w.kinds,muted:w.muted,...extra}}
interface Digest {groups:{day:string;sourceId:string;count:number;unread:number;events:DigestEvent[]}[];days:number;watchCount:number;truncated:boolean}
export default function SourceWatchPanel({sources,onDocument}:{sources:{id:string;name:string}[];onDocument?:(id:string)=>void}) {
  const [watches,setWatches]=useState<Watch[]>([]),[digest,setDigest]=useState<Digest|null>(null)
  const [name,setName]=useState(''),[sourceId,setSourceId]=useState(''),[codes,setCodes]=useState(''),[keywords,setKeywords]=useState(''),[kind,setKind]=useState('')
  const [days,setDays]=useState('7'),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const reload=useCallback(async(signal?:AbortSignal)=>{const [w,d]=await Promise.all([knowledgeV3Get<{items:Watch[]}>('/watches',signal),knowledgeV3Get<Digest>(`/digest?days=${days}`,signal)]);if(signal?.aborted)return;setWatches(w.items);setDigest(d)},[days])
  useEffect(()=>{const controller=new AbortController();void Promise.resolve().then(()=>reload(controller.signal)).catch(e=>{if(!controller.signal.aborted)setError(sourceError(e))});return()=>controller.abort()},[reload])
  async function action(path:string,body:unknown){if(busy)return false;setBusy(true);setError('');try{await knowledgeV3Post(path,body);await reload();return true}catch(e){setError(sourceError(e));return false}finally{setBusy(false)}}
  return <section className="kso-v3-acquire" aria-label="个人关注与更新摘要"><div className="kso-v3-heading"><div><h2><Bell size={19}/>个人关注与更新摘要</h2><p>按指南编号、来源或主题聚合更新。复用来源检查结果，提醒在本应用内展示。</p></div><button type="button" className="kso-btn" disabled={busy} onClick={()=>{setError('');void reload().catch(e=>setError(sourceError(e)))}}><RefreshCw size={16}/>刷新摘要</button></div>
    {error&&<p role="alert" className="kso-error">{error}</p>}
    <form className="kso-v3-watch-form" onSubmit={e=>{e.preventDefault();void action('/watches',{name:name.trim(),sourceIds:sourceId?[sourceId]:[],keywords,codes,kinds:kind?[kind]:[],muted:false}).then(ok=>{if(ok){setName('');setKeywords('');setCodes('')}})}}>
      <label className="kso-field">关注名称<input value={name} maxLength={100} disabled={busy} onChange={e=>setName(e.target.value)} placeholder="例如：生物制品指南" required aria-label="关注规则名称"/></label>
      <label className="kso-field">来源<select value={sourceId} disabled={busy} onChange={e=>setSourceId(e.target.value)}><option value="">全部来源</option>{sources.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label className="kso-field">指南编号<input value={codes} disabled={busy} onChange={e=>setCodes(e.target.value)} placeholder="Q5C, Q7" maxLength={200}/></label>
      <label className="kso-field">主题关键词<input value={keywords} disabled={busy} onChange={e=>setKeywords(e.target.value)} placeholder="多个词用空格分隔" maxLength={300}/></label>
      <label className="kso-field">变化类型<select value={kind} disabled={busy} onChange={e=>setKind(e.target.value)}><option value="">全部变化</option>{['新资料','正文修订','官方状态变化','原文件变化'].map(v=><option key={v}>{v}</option>)}</select></label>
      <button type="submit" className="kso-btn primary" disabled={busy||!name.trim()}>添加关注</button>
    </form>
    <div className="kso-v3-watch-list">{watches.map(w=><div className="kso-v3-watch" key={w.id}><div><strong>{w.name}{w.muted?' · 已暂停':''}</strong><small>{[w.codes,w.keywords,w.sourceIds.length?w.sourceIds.map(id=>sources.find(s=>s.id===id)?.name||'来源').join('、'):'全部来源',w.kinds.join('、')].filter(Boolean).join(' · ')}</small></div><div className="kso-actions"><button type="button" className="kso-btn" disabled={busy} onClick={()=>void action('/watches',watchBody(w,{muted:!w.muted}))}>{w.muted?'恢复关注':'暂停关注'}</button><button type="button" className="kso-btn quiet" disabled={busy} onClick={()=>void action('/watches',watchBody(w,{delete:true}))}>移除关注</button></div></div>)}</div>
    <div className="kso-v3-heading"><h3>更新摘要</h3><label className="kso-field">时间范围<select aria-label="关注摘要时间范围" value={days} onChange={e=>setDays(e.target.value)}><option value="7">近 7 天</option><option value="30">近 30 天</option><option value="90">近 90 天</option></select></label></div>
    {digest?.groups.map(group=><article className="kso-v3-digest" key={`${group.day}-${group.sourceId}`}><div className="kso-v3-heading"><strong>{group.day} · {sources.find(s=>s.id===group.sourceId)?.name||'来源更新'} · {group.count} 项</strong>{group.unread>0&&<button type="button" className="kso-btn" disabled={busy} onClick={()=>void action('/digest/read',{eventIds:group.events.filter(e=>!e.read).map(e=>e.id)})}><Check size={14}/>标记本组已查看</button>}</div>{group.events.map(event=><div className="kso-v3-update" key={event.id}><span className="kso-chip">{event.kind}</span><span>{event.title}{!event.read&&<span className="kso-chip blue">未查看</span>}</span>{event.documentId&&onDocument&&<button type="button" className="kso-btn quiet" onClick={()=>onDocument(event.documentId!)}>查看资料</button>}</div>)}</article>)}
    {digest&&!digest.groups.length&&<p className="kso-note">{watches.length?'当前时间范围内没有匹配关注条件的更新。可检查来源定期检查设置，或手动再次搜索。':'添加一条关注规则后，匹配的新增与修订会按日期、来源合并展示。'}</p>}
    {digest?.truncated&&<p className="kso-small">仅展示最近 100 组摘要，可缩短时间范围查看。</p>}
  </section>
}

interface Version {id:string;createdAt?:string;sha256?:string}
interface DiffResult {available:boolean;reason?:string;basis?:string;truncated:boolean;changeCount?:number;blocks:{kind:string;beforeLine:number;afterLine:number;before:string;after:string;textTruncated?:boolean}[]}
interface Usage {items:{id:string;kind:string;title:string;url:string;versionIds:string[];olderVersion:boolean;versionUnknown:boolean}[];truncated:boolean;scope:string}
export function VersionChangePanel(props:{documentId:string;versions:Version[]}) {return <VersionChangeWorkspace key={props.documentId+':'+props.versions.map(v=>v.id).join(':')} {...props}/> }
function VersionChangeWorkspace({documentId,versions}:{documentId:string;versions:Version[]}) {
  const [beforeId,setBeforeId]=useState(versions.at(-2)?.id||''),[afterId,setAfterId]=useState(versions.at(-1)?.id||'')
  const [diff,setDiff]=useState<DiffResult|null>(null),[usage,setUsage]=useState<Usage|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('')
  async function compare(){if(busy||!beforeId||!afterId)return;setBusy(true);setError('');try{const [d,u]=await Promise.all([knowledgeV3Post<DiffResult>('/versions/diff',{documentId,beforeId,afterId}),knowledgeV3Get<Usage>(`/documents/${encodeURIComponent(documentId)}/usage`)]);setDiff(d);setUsage(u)}catch(e){setError(sourceError(e))}finally{setBusy(false)}}
  async function usages(){if(busy)return;setBusy(true);setError('');try{setUsage(await knowledgeV3Get<Usage>(`/documents/${encodeURIComponent(documentId)}/usage`))}catch(e){setError(sourceError(e))}finally{setBusy(false)}}
  return <section className="kso-inspector-section kso-v3-version" aria-label="正文对比与引用影响"><h3>正文对比与引用影响</h3>{versions.length>1?<><div className="kso-v3-version-select">{[['旧版本',beforeId,setBeforeId],['新版本',afterId,setAfterId]].map(([label,value,setter])=><label className="kso-field" key={label as string}>{label as string}<select value={value as string} onChange={e=>(setter as (v:string)=>void)(e.target.value)}>{versions.map((v,i)=><option key={v.id} value={v.id}>版本 {i+1} · {v.createdAt?new Date(v.createdAt).toLocaleDateString('zh-CN'):v.id.slice(0,8)}</option>)}</select></label>)}</div><button type="button" className="kso-btn" disabled={busy||!beforeId||!afterId||beforeId===afterId} onClick={()=>void compare()}>比较正文并检查引用</button></>:<p className="kso-small">保存至少两个版本后可比较提取正文。</p>}<button type="button" className="kso-btn quiet" disabled={busy} onClick={()=>void usages()}>查看我的笔记与报告引用</button>{error&&<p role="alert" className="kso-error">{error}</p>}
    {diff&&(diff.available?<div className="kso-v3-diff"><p>{diff.changeCount} 处正文变化。{diff.basis}</p>{diff.truncated&&<p className="kso-small">正文或差异较长，仅展示限定范围；完整内容请查看两个原件。</p>}{diff.blocks.map((b,i)=><article key={i}><strong>{b.kind==='insert'?'新增':b.kind==='delete'?'删除':'修订'} · 旧正文第 {b.beforeLine} 行 / 新正文第 {b.afterLine} 行</strong><div><pre className="kso-v3-diff-before">{b.before||'此版本无对应内容'}</pre><pre className="kso-v3-diff-after">{b.after||'此版本已删除对应内容'}</pre></div>{b.textTruncated&&<small>此段较长，已截断。</small>}</article>)}{!diff.blocks.length&&<p>当前比较范围的提取正文一致。</p>}</div>:<p className="kso-note">{diff.reason}</p>)}
    {usage&&<div><p className="kso-small">{usage.scope}</p>{usage.items.map(item=><a className="kso-v3-usage" key={`${item.kind}-${item.id}`} href={item.url}><span>{item.kind==='note'?'笔记':'报告'} · {item.title}<small>{item.olderVersion?'引用旧版本，请核对更新':item.versionUnknown?'引用版本未明确，需人工核对':'引用已保存版本'}</small></span><ExternalLink size={14}/></a>)}{!usage.items.length&&<p className="kso-small">尚未找到本人笔记或报告中的明确引用。</p>}{usage.truncated&&<p className="kso-small">结果较多，已截断。</p>}</div>}
  </section>
}
