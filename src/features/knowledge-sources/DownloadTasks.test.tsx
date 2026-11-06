import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import DownloadTasks from './DownloadTasks'
import type { KnowledgeSourceSnapshot, SourceJob } from './api'

const data = (): KnowledgeSourceSnapshot => ({
  papers: [], folders: [], sources: [{id:'refs',name:'个人AI助手参考资料',adapter:'reference',url:'/assistant',scopes:[],folderId:null,frequency:'manual',enabled:false,status:'ok',scopeStatus:{}}],
  documents: [{id:'news',sourceId:'refs',title:'普通新闻页面',url:'https://example.org/news',scopes:[],folderIds:[],format:'待核验',language:'',documentType:'参考资料',discoveredAt:'2026-11-06T11:47:31Z',status:'discovered',versions:[]}],
  jobs: [], catalogRevision:0,canManage:true,canOrganize:true,starred:[],integration:{status:'ready',message:''},
})
const job = (extra:Partial<SourceJob>={}):SourceJob => ({id:'failed-job',sourceId:'refs',folderId:'',kind:'import',parse:true,status:'failed',createdAt:'2026-11-06T11:47:31Z',updatedAt:'2026-11-06T11:47:31Z',total:1,processed:1,saved:0,failed:1,pending:0,items:[{documentId:'news',status:'failed',phase:'download',failurePhase:'download',errorCode:'no_pdf',retryable:false,error:'无法下载：未找到可公开下载的 PDF，已保留来源链接。'}],...extra})

it('opens failed tasks and per-file reasons by default, without confusing processed count with downloaded files',()=>{
  const snapshot=data(); snapshot.jobs=[job()]
  render(<DownloadTasks data={snapshot} busy={false} mutate={vi.fn()} go={vi.fn()} />)
  const error=screen.getByText('无法下载：未找到可公开下载的 PDF，已保留来源链接。')
  expect(error).toBeVisible()
  expect(screen.getByText('无法下载',{exact:true})).toBeVisible()
  expect(screen.getByText('原件已保存 0 · 失败 1')).toBeVisible()
  expect(screen.getByText(/已处理 1 \/ 1/)).toBeVisible()
  const link=screen.getByRole('link',{name:'查看原始链接'})
  expect(link).toBeVisible()
  expect(link).toHaveAttribute('href','https://example.org/news')
  expect(link).toHaveAttribute('rel','noopener noreferrer')
  expect(screen.queryByRole('button',{name:'查看本次文件'})).not.toBeInTheDocument()
  expect(screen.getByText('本次未保存原件，来源链接仍保留。')).toBeVisible()
})

it('keeps a saved original available when only parsing or indexing failed',()=>{
  const snapshot=data();snapshot.jobs=[job({status:'partial',saved:1,items:[{documentId:'news',status:'failed',versionId:'version',phase:'index',failurePhase:'index',error:'索引服务暂不可用'}]})]
  render(<DownloadTasks data={snapshot} busy={false} mutate={vi.fn()} go={vi.fn()} />)
  expect(screen.getByText('原件已保存 1 · 失败 1')).toBeVisible()
  expect(screen.getByText('索引失败',{exact:true})).toBeVisible()
  expect(screen.getByText('原件已保存，无需重新下载；仅需重试索引。')).toBeVisible()
  expect(screen.queryByText('无法下载',{exact:true})).not.toBeInTheDocument()
})

it('retains a user-collapsed failed task during polling and still allows reopening it',()=>{
  const snapshot=data();snapshot.jobs=[job()]
  const view=render(<DownloadTasks data={snapshot} busy={false} mutate={vi.fn()} go={vi.fn()} />)
  const details=document.querySelector('details.kso-job') as HTMLDetailsElement
  expect(details.open).toBe(true)
  // The browser updates the native details element when its summary is clicked.
  details.open=false;fireEvent(details,new Event('toggle'))
  view.rerender(<DownloadTasks data={{...snapshot,jobs:[{...snapshot.jobs[0],updatedAt:'2026-11-06T11:47:35Z'}]}} busy={false} mutate={vi.fn()} go={vi.fn()} />)
  expect(details.open).toBe(false)
  expect(screen.getByText(/未找到可公开下载的 PDF/)).not.toBeVisible()
  details.open=true;fireEvent(details,new Event('toggle'))
  expect(screen.getByText(/未找到可公开下载的 PDF/)).toBeVisible()
})

it('does not expose unsafe source links or mutation controls to readers',()=>{
  const snapshot=data();snapshot.documents[0].url='https://127.0.0.1/internal';snapshot.jobs=[job()];snapshot.canManage=false
  render(<DownloadTasks data={snapshot} busy={false} mutate={vi.fn()} go={vi.fn()} />)
  expect(screen.queryByRole('link',{name:'查看原始链接'})).not.toBeInTheDocument()
  expect(screen.queryByRole('button',{name:'仅重试失败项'})).not.toBeInTheDocument()
  expect(screen.getByText(/未找到可公开下载的 PDF/)).toBeVisible()
})

it('filters per-file failures without hiding saved originals from task totals',()=>{
  const snapshot=data();snapshot.documents.push({...snapshot.documents[0],id:'saved',title:'PDF 原件'})
  snapshot.jobs=[job({total:2,processed:2,saved:1,status:'partial',items:[...job().items,{documentId:'saved',status:'saved',versionId:'version',phase:'done'}]})]
  render(<DownloadTasks data={snapshot} busy={false} mutate={vi.fn()} go={vi.fn()} />)
  fireEvent.click(screen.getByRole('checkbox',{name:'逐项仅看失败'}))
  const section=document.querySelector('details.kso-job') as HTMLElement
  expect(within(section).queryByText('PDF 原件')).not.toBeInTheDocument()
  expect(screen.getByText('原件已保存 1 · 失败 1')).toBeVisible()
  expect(screen.getByText(/未找到可公开下载的 PDF/)).toBeVisible()
})
