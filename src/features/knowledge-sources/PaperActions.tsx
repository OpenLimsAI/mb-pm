import { useState } from 'react'
import { notesApi } from '../notes/client'
import NoteEditor from '../notes/NoteEditor'
import { newNote, type NoteDraft } from '../notes/draft'
import { solutionApi } from '../solutions/api'
import type { Solution, SolutionInput } from '../solutions/types'
import type { SourcePaper } from './api'
export default function PaperActions({ paper, quote = '', quoteOffset }: { paper: SourcePaper; quote?: string; quoteOffset?: number }) {
  const [note,setNote]=useState<NoteDraft | null>(null), [reports,setReports]=useState<Solution[] | null>(null), [target,setTarget]=useState('new'), [busy,setBusy]=useState(false), [message,setMessage]=useState(''), [link,setLink]=useState('')
  const url=paper.originalUrl || paper.kbUrl || '', version=paper.versionId || '知识库当前版本，未提供原件版本号'
  const citation=`资料：${paper.title}\n来源：${paper.sourceName || '知识库'}\n原文：${url}\n原件版本：${version}\n收录时间：${paper.createdAt || '未提供'}\n\n`
  const excerpt=quote ? `原文选段${quoteOffset !== undefined ? `（提取正文第 ${quoteOffset+1} 字符起）` : ''}：\n${quote}\n\n` : ''
  async function chooseReport() {setBusy(true);setMessage('');try {setReports((await solutionApi.list()).filter(r=>r.canEdit && r.status==='draft'))} catch(e) {setMessage(e instanceof Error ? e.message : '报告列表暂不可用')} finally{setBusy(false)}}
  async function addReport() {
    setBusy(true);setMessage('')
    try {
      const section={id:crypto.randomUUID(),title:paper.title.slice(0,120),content:citation+excerpt+'研究观察：\n'}
      let result:Solution
      if(target==='new') {const input:SolutionInput={title:`研究报告：${paper.title}`.slice(0,200),projectName:'',productName:'',sections:[section],formula:[],references:[]}; result=await solutionApi.create(input)}
      else {const current=await solutionApi.get(target); if(!current.canEdit || current.status!=='draft') throw new Error('报告状态已变化，请重新选择可编辑草稿。');result=await solutionApi.save(current.id,{title:current.title,projectName:current.projectName,productName:current.productName,sections:[...current.sections,section],formula:current.formula,references:current.references,revision:current.revision})}
      setReports(null);setMessage('已加入研究报告，原文链接和版本已保留。');setLink(`/solutions?report=${encodeURIComponent(result.id)}`)
    } catch(e){setMessage(e instanceof Error ? e.message : '报告保存失败，请重试')} finally{setBusy(false)}
  }
  return <section className="kso-inspector-section"><h3>继续研究</h3><div className="kso-actions"><button className="kso-btn" disabled={busy} onClick={()=>setNote(newNote({title:`阅读笔记：${paper.title}`.slice(0,200),content:citation+excerpt+'我的笔记：\n',sourceApp:'knowledge',sourceTitle:paper.title.slice(0,500),sourceUrl:url}))}>{quote ? '将选段写入笔记' : '基于此资料写笔记'}</button><button className="kso-btn" disabled={busy} onClick={()=>void chooseReport()}>添加到研究报告</button></div>{reports && <div className="kso-field"><label>目标研究报告<select value={target} onChange={e=>setTarget(e.target.value)}><option value="new">新建研究报告草稿</option>{reports.map(r=><option key={r.id} value={r.id}>{r.title}</option>)}</select></label><button className="kso-btn primary" disabled={busy} onClick={()=>void addReport()}>加入资料与版本链接</button><button className="kso-btn quiet" disabled={busy} onClick={()=>setReports(null)}>取消</button></div>}{message && <p role="status">{message}{link && <a href={link}>打开研究报告</a>}</p>}{note && <NoteEditor client={notesApi} draft={note} onClose={()=>setNote(null)} onSaved={()=>{setNote(null);setLink('');setMessage('已保存到我的笔记。')}}/>}</section>
}
