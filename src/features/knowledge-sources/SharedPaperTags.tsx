import { useState } from 'react'
import { knowledgeV3Post, type PaperDetail } from './v3-api'
import { sourceError } from './api'
export default function SharedPaperTags({ detail, onSaved }: { detail: PaperDetail; onSaved: () => void }) {
  const [value,setValue]=useState((detail.paper.tags || []).map(t=>t.name).join('；')),[busy,setBusy]=useState(false),[message,setMessage]=useState('')
  async function save() { setBusy(true);setMessage('');try{await knowledgeV3Post('/library/tags',{paperIds:[detail.paper.id],tags:value.split(/[;；\n]/).map(s=>s.trim()).filter(Boolean),revision:detail.insightRevision || 0});setMessage('共享标签已保存。');onSaved()}catch(e){setMessage(sourceError(e))}finally{setBusy(false)} }
  return <section className="ksv-card"><h3>知识库共享标签</h3>{detail.canWrite&&!detail.paper.id.startsWith('archive:')?<form className="ksv-metadata-form" onSubmit={e=>{e.preventDefault();void save()}}><label>标签（分号分隔，最多3个，每个最多16字）<input maxLength={100} value={value} onChange={e=>setValue(e.target.value)} placeholder="稳定性；生物制品"/></label><button className="kso-btn" disabled={busy}>保存共享标签</button></form>:<div className="kso-folders-cell">{detail.paper.tags?.length?detail.paper.tags.map(t=><span className="kso-chip" key={t.id}>{t.name}</span>):<small>尚无共享标签</small>}</div>}{message&&<p role="status">{message}</p>}</section>
}
