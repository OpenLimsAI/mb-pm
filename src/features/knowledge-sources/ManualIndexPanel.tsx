import { useEffect, useState } from 'react'
import { Database, RefreshCw } from 'lucide-react'
import { sourceError } from './api'
import { knowledgeV3Get, knowledgeV3Post } from './v3-api'

interface ManualStatus {jobId:string|null;status:string;indexStatus:string;error?:string|null;updatedAt?:string;canStart?:boolean;globalIncremental:boolean;originalSaved:boolean}
export default function ManualIndexPanel(props:{paperId:string;canManage:boolean;indexStatus?:string;onChanged?:()=>void}) {return <ManualIndexWorkspace key={props.paperId} {...props}/>}
function ManualIndexWorkspace({paperId,canManage,indexStatus,onChanged}:{paperId:string;canManage:boolean;indexStatus?:string;onChanged?:()=>void}) {
  const [status,setStatus]=useState<ManualStatus|null>(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[refresh,setRefresh]=useState(0)
  const running=status?.status==='queued'||status?.status==='running'
  useEffect(()=>{
    if(!canManage)return
    const controller=new AbortController();const timer=window.setTimeout(()=>{void knowledgeV3Get<ManualStatus>(`/library/manual-index/status?paperId=${encodeURIComponent(paperId)}`,controller.signal).then(next=>{if(!controller.signal.aborted){setStatus(next);setError('')}}).catch(e=>{if(!controller.signal.aborted)setError(sourceError(e))})},0)
    return()=>{controller.abort();window.clearTimeout(timer)}
  },[paperId,refresh,canManage])
  useEffect(()=>{if(!running)return;const timer=window.setTimeout(()=>setRefresh(n=>n+1),5000);return()=>window.clearTimeout(timer)},[running,status])
  async function start(){if(busy||!confirmed||!canManage||running)return;setBusy(true);setError('');try{const result=await knowledgeV3Post<ManualStatus>('/library/manual-index',{paperId,confirmed:true});setStatus(result);setConfirmed(false);onChanged?.()}catch(e){setError(sourceError(e))}finally{setBusy(false)}}
  const state=status?.indexStatus||indexStatus||'unknown'
  const ready=state==='ready'
  const enabled=canManage&&status?.canStart!==false
  return <section className="kso-inspector-section" aria-label="手动原件问答索引"><h3><Database size={16}/>手动原件问答索引</h3><p className="kso-small">原件已保存。{ready?'问答索引已确认可用。':state==='pending'?'正在等待知识库真实索引结果。':state==='failed'?'上次索引未完成，原件保留。':'问答索引尚未确认完成。'}</p>
    {running?<p role="status">{status?.status==='queued'?'索引任务已排队，尚未完成。':'正在跟踪知识库索引任务，关闭此页面仍会继续。'}</p>:!ready&&<><p className="kso-note">知识库当前仅提供全库级增量索引。确认后会处理知识库中所有尚待索引的资料，可能产生现有嵌入配置的调用费用；不会重新下载此 PDF。已有原件与问答可用状态分别保留。</p><label className="kso-check"><input type="checkbox" aria-label="确认处理知识库全部待索引资料" checked={confirmed} disabled={!enabled||busy} onChange={e=>setConfirmed(e.target.checked)}/>我确认处理知识库全部待索引资料</label><button type="button" className="kso-btn" disabled={!enabled||busy||!confirmed||!status} onClick={()=>void start()}>{busy?'正在提交…':status?.status==='paused'?'确认并继续跟踪索引':'确认并开始知识库增量索引'}</button></>}
    {!enabled&&<p className="kso-small">只有当前有效的知识库负责人可以主动发起索引。</p>}{status?.error&&<p className="kso-error">{status.error}</p>}{error&&<p role="alert" className="kso-error">{error}</p>}<button type="button" className="kso-btn quiet" disabled={busy} onClick={()=>{setRefresh(n=>n+1);onChanged?.()}}><RefreshCw size={14}/>核对索引状态</button><small className="kso-small">关闭页面后已提交的知识库索引任务仍会继续；结果确认后才显示可问答。</small>
  </section>
}
