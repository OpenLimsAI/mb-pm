import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AxiosProgressEvent } from 'axios'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AcquisitionWorkspace from './AcquisitionWorkspace'
import SourceWatchPanel, { VersionChangePanel } from './SourceWatchPanel'

const api=vi.hoisted(()=>({get:vi.fn(),post:vi.fn(),upload:vi.fn()}))
vi.mock('./v3-api',()=>({knowledgeV3Get:api.get,knowledgeV3Post:api.post,knowledgeV3Upload:api.upload}))
const templates=[{id:'pubmed',name:'PubMed 文献',url:'https://pubmed.ncbi.nlm.nih.gov/',capabilities:['PMID 元数据'],coverage:'元数据不是免费 PDF'}]
const folders=[{id:'topic',name:'稳定性研究'}]
const imported={items:[{documentId:'doc',title:'Study',alreadyImported:false}],jobs:[],errors:[],downloadRequested:false,indexRequested:false}
const progressEvent=(loaded:number,total?:number):AxiosProgressEvent=>({loaded,total,bytes:loaded,lengthComputable:total!==undefined})
beforeEach(()=>{api.get.mockReset();api.post.mockReset();api.upload.mockReset();api.get.mockImplementation(async(path:string)=>path==='/templates'?{items:templates}:path==='/watches'?{items:[]}:path.startsWith('/digest')?{groups:[],watchCount:0,days:7,truncated:false}:{items:[],scope:'仅本人引用',truncated:false});api.post.mockResolvedValue(imported);api.upload.mockResolvedValue({saved:true})})

describe('knowledge source unified intake',()=>{
 it('keeps DOI intake metadata-only unless user explicitly requests download and index',async()=>{
  const refresh=vi.fn();render(<AcquisitionWorkspace folders={folders} canManage onImported={refresh}/>)
  fireEvent.change(screen.getByLabelText('待收录的标识符与链接'),{target:{value:'10.1234/study\nPMID: 1234'}})
  fireEvent.click(screen.getByRole('button',{name:'收录 2 项资料'}))
  await waitFor(()=>expect(api.post).toHaveBeenCalledWith('/acquisition/import',{items:[{input:'10.1234/study'},{input:'PMID: 1234'}],folderId:null,download:false,parse:false},expect.any(AbortSignal)))
  expect(await screen.findByText('当前只保存资料链接及元数据，未将其标记为已下载。')).toBeInTheDocument()
  expect(refresh).toHaveBeenCalledOnce()
 })
 it('commits only selected official results with server preview receipt and temporary destination',async()=>{
  api.post.mockImplementation(async(path:string)=>path.endsWith('/search')?{items:[{id:'one',title:'Protein Study',url:'https://pubmed.ncbi.nlm.nih.gov/1234/',metadata:{year:'2026',pmid:'1234'}}],total:1,truncated:false,coverage:'Metadata',officialUrl:'https://pubmed.ncbi.nlm.nih.gov/',previewToken:'receipt'}:{...imported,jobs:[{jobId:'j1'}],downloadRequested:true})
  render(<AcquisitionWorkspace folders={folders} canManage/>)
  fireEvent.click(screen.getByRole('tab',{name:'官方来源检索'}));await screen.findByRole('option',{name:'PubMed 文献'})
  fireEvent.change(screen.getByLabelText('官方来源检索词'),{target:{value:'protein'}});fireEvent.click(screen.getByRole('button',{name:'检索来源'}))
  fireEvent.click(await screen.findByRole('checkbox',{name:/Protein Study/}));fireEvent.change(screen.getByLabelText('收录目标文件夹'),{target:{value:'topic'}})
  fireEvent.click(screen.getByRole('checkbox',{name:'同时下载可公开获取的原件'}));fireEvent.click(screen.getByRole('checkbox',{name:'建立问答索引'}));fireEvent.click(screen.getByRole('button',{name:'收录并下载 1 项'}))
  await waitFor(()=>expect(api.post).toHaveBeenCalledWith('/acquisition/import',{previewToken:'receipt',documentIds:['one'],folderId:'topic',download:true,parse:true},expect.any(AbortSignal)))
  expect(await screen.findByText(/已创建 1 个下载任务/)).toBeInTheDocument()
 })
 it('retains unsuccessful manual inputs and shows partial outcomes honestly',async()=>{
  api.post.mockResolvedValue({...imported,errors:[{input:'bad',error:'无法解析此标识符'}]});render(<AcquisitionWorkspace folders={folders} canManage/>)
  const input=screen.getByLabelText('待收录的标识符与链接');fireEvent.change(input,{target:{value:'10.1234/study\nbad'}});fireEvent.click(screen.getByRole('button',{name:'收录 2 项资料'}))
  expect(await screen.findByText('bad：无法解析此标识符')).toBeInTheDocument();expect(input).toHaveValue('10.1234/study\nbad')
 })
 it('uses the shared upload bridge and leaves indexing off by default',async()=>{
  const refresh=vi.fn();const {container}=render(<AcquisitionWorkspace folders={folders} canManage onImported={refresh}/>);fireEvent.click(screen.getByRole('tab',{name:'上传 PDF'}))
  const input=container.querySelector('input[type=file]')!;const file=new File(['%PDF-1.7'],'study.pdf',{type:'application/pdf'});fireEvent.change(input,{target:{files:[file]}})
  fireEvent.change(screen.getByLabelText('收录目标文件夹'),{target:{value:'topic'}});fireEvent.click(screen.getByRole('button',{name:'上传 1 份 PDF'}))
  await waitFor(()=>expect(api.upload).toHaveBeenCalledOnce());const [path,body]=api.upload.mock.calls[0] as [string,FormData]
  expect(path).toMatch(/^\/upload\?upload_trace=[0-9a-f]{32}$/);expect(body.get('file')).toBe(file);expect(body.get('folderId')).toBe('topic');expect(body.get('parse')).toBe('false')
  await waitFor(()=>expect(refresh).toHaveBeenCalledOnce())
 })
 it('preserves a confirmed upload and its undo receipt when the next upload fails, refreshing once',async()=>{
  const refresh=vi.fn(),undo=vi.fn()
  api.upload.mockResolvedValueOnce({saved:true,registered:false,indexStatus:'not_requested',ruleFiling:[{undoTokens:['undo-first']}]}).mockRejectedValueOnce({isAxiosError:true,response:{status:500,data:'Internal Server Error'}})
  const {container}=render(<AcquisitionWorkspace folders={folders} canManage onImported={refresh} onUndoTokens={undo}/>);fireEvent.click(screen.getByRole('tab',{name:'上传 PDF'}))
  const first=new File(['%PDF-1.7 first'],'first.pdf',{type:'application/pdf'}),second=new File(['%PDF-1.7 second'],'second.pdf',{type:'application/pdf'})
  fireEvent.change(container.querySelector('input[type=file]')!,{target:{files:[first,second]}});fireEvent.click(screen.getByRole('button',{name:'上传 2 份 PDF'}))
  expect(await screen.findByRole('alert')).toHaveTextContent('已确认成功 1 份；当前文件保存结果未确认，请核对后重试。知识源服务处理失败')
  expect(screen.getByText('first.pdf',{selector:'strong'})).toBeInTheDocument();expect(screen.getByText(/原件已保存 · 待知识库注册/)).toBeInTheDocument()
  expect(screen.getByText('second.pdf',{selector:'.kso-v3-drop span'})).toBeInTheDocument();expect(screen.getAllByRole('button',{name:'移除'})).toHaveLength(1)
  expect(screen.getByRole('button',{name:'上传 1 份 PDF'})).toBeEnabled();expect(refresh).toHaveBeenCalledOnce();expect(undo).toHaveBeenCalledExactlyOnceWith(['undo-first'])
  expect(api.upload.mock.calls.map(([,body])=>(body as FormData).get('parse'))).toEqual(['false','false'])
 })
 it('retains the first failed file without implying it was not saved or refreshing a confirmed success',async()=>{
  const refresh=vi.fn();api.upload.mockRejectedValueOnce({isAxiosError:true,code:'ETIMEDOUT'})
  const {container}=render(<AcquisitionWorkspace folders={folders} canManage onImported={refresh}/>);fireEvent.click(screen.getByRole('tab',{name:'上传 PDF'}))
  const file=new File(['%PDF-1.7'],'uncertain.pdf',{type:'application/pdf'});fireEvent.change(container.querySelector('input[type=file]')!,{target:{files:[file]}});fireEvent.click(screen.getByRole('button',{name:'上传 1 份 PDF'}))
  expect(await screen.findByRole('alert')).toHaveTextContent('已确认成功 0 份；当前文件保存结果未确认，请核对后重试。响应超时')
  expect(screen.getByText('uncertain.pdf',{selector:'.kso-v3-drop span'})).toBeInTheDocument();expect(screen.getByRole('button',{name:'上传 1 份 PDF'})).toBeEnabled();expect(refresh).not.toHaveBeenCalled()
 })
 it('shows real network upload progress, then waits for the save receipt instead of declaring success at 100%',async()=>{
  const refresh=vi.fn();let progress!:(event:AxiosProgressEvent)=>void,resolve!:(value:unknown)=>void
  api.upload.mockImplementation((_path,_body,_signal,onProgress)=>{progress=onProgress;return new Promise(done=>{resolve=done})})
  const {container}=render(<AcquisitionWorkspace folders={folders} canManage onImported={refresh}/>);fireEvent.click(screen.getByRole('tab',{name:'上传 PDF'}))
  fireEvent.change(container.querySelector('input[type=file]')!,{target:{files:[new File(['%PDF-1.7'],'progress.pdf',{type:'application/pdf'})]}});fireEvent.click(screen.getByRole('button',{name:'上传 1 份 PDF'}))
  await waitFor(()=>expect(api.upload).toHaveBeenCalledOnce())
  const bar=screen.getByRole('progressbar',{name:'当前文件网络上传进度'})
  expect(bar).not.toHaveAttribute('value');expect(screen.getByText('第 1 / 1 份 · 已确认保存 0 份')).toBeInTheDocument()
  act(()=>progress(progressEvent(25,100)));expect(bar).toHaveAttribute('value','25');expect(screen.getByText('正在上传文件 · 25%')).toBeInTheDocument()
  act(()=>progress(progressEvent(100,100)));expect(screen.getByText('文件传输完成，正在解析并保存…')).toBeInTheDocument();expect(refresh).not.toHaveBeenCalled();expect(screen.queryByText('上传完成，原件保存已确认。')).not.toBeInTheDocument()
  await act(async()=>resolve({registered:false,indexStatus:'not_requested'}))
  expect(screen.getByText('上传完成，原件保存已确认。')).toBeInTheDocument();expect(screen.getByText('第 1 / 1 份 · 已确认保存 1 份')).toBeInTheDocument();expect(refresh).toHaveBeenCalledOnce()
  act(()=>progress(progressEvent(50,100)));expect(screen.getByText('上传完成，原件保存已确认。')).toBeInTheDocument();expect(bar).toHaveAttribute('value','100')
 })
 it('resets progress for each file, ignores late events, and keeps partial receipts after a later failure',async()=>{
  const refresh=vi.fn(),undo=vi.fn(),requests:{progress:(e:AxiosProgressEvent)=>void;resolve:(value:unknown)=>void;reject:(error:unknown)=>void}[]=[]
  api.upload.mockImplementation((_path,_body,_signal,onProgress)=>new Promise((resolve,reject)=>requests.push({progress:onProgress,resolve,reject})))
  const {container}=render(<AcquisitionWorkspace folders={folders} canManage onImported={refresh} onUndoTokens={undo}/>);fireEvent.click(screen.getByRole('tab',{name:'上传 PDF'}))
  fireEvent.change(container.querySelector('input[type=file]')!,{target:{files:[new File(['%PDF-1.7'],'first-progress.pdf'),new File(['%PDF-1.7'],'second-progress.pdf')]}});fireEvent.click(screen.getByRole('button',{name:'上传 2 份 PDF'}))
  await waitFor(()=>expect(requests).toHaveLength(1));await act(async()=>requests[0].resolve({registered:false,ruleFiling:[{undoTokens:['progress-undo']}]}));await waitFor(()=>expect(requests).toHaveLength(2))
  expect(screen.getByText('第 2 / 2 份 · 已确认保存 1 份')).toBeInTheDocument();const bar=screen.getByRole('progressbar',{name:'当前文件网络上传进度'});expect(bar).not.toHaveAttribute('value')
  act(()=>requests[0].progress(progressEvent(100,100)));expect(bar).not.toHaveAttribute('value')
  act(()=>requests[1].progress(progressEvent(30)));expect(bar).not.toHaveAttribute('value');expect(screen.getByText('正在上传文件，等待网络进度…')).toBeInTheDocument()
  act(()=>requests[1].progress(progressEvent(40,100)));expect(bar).toHaveAttribute('value','40')
  await act(async()=>requests[1].reject({isAxiosError:true,code:'ETIMEDOUT'}))
  expect(screen.getByRole('alert')).toHaveTextContent('已确认成功 1 份');expect(screen.getByText('本次请求未完成，当前文件保存结果待核对。')).toBeInTheDocument();expect(screen.getByRole('button',{name:'上传 1 份 PDF'})).toBeEnabled();expect(screen.getByText('first-progress.pdf',{selector:'strong'})).toBeInTheDocument();expect(refresh).toHaveBeenCalledOnce();expect(undo).toHaveBeenCalledExactlyOnceWith(['progress-undo'])
  act(()=>requests[1].progress(progressEvent(100,100)));expect(bar).toHaveAttribute('value','40')
 })
 it('aborts the current upload on close without starting another file or confirming a save',async()=>{
  const refresh=vi.fn();let signal!:AbortSignal,progress!:(event:AxiosProgressEvent)=>void
  api.upload.mockImplementation((_path,_body,currentSignal,onProgress)=>{signal=currentSignal;progress=onProgress;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject({isAxiosError:true,code:'ERR_CANCELED'}),{once:true}))})
  const {container,unmount}=render(<AcquisitionWorkspace folders={folders} canManage onImported={refresh}/>);fireEvent.click(screen.getByRole('tab',{name:'上传 PDF'}))
  fireEvent.change(container.querySelector('input[type=file]')!,{target:{files:[new File(['%PDF-1.7'],'cancel-first.pdf'),new File(['%PDF-1.7'],'cancel-second.pdf')]}});fireEvent.click(screen.getByRole('button',{name:'上传 2 份 PDF'}));await waitFor(()=>expect(api.upload).toHaveBeenCalledOnce())
  await act(async()=>unmount());expect(signal.aborted).toBe(true);act(()=>progress(progressEvent(100,100)));expect(api.upload).toHaveBeenCalledOnce();expect(refresh).not.toHaveBeenCalled()
 })
 it('provides a trace with no HTTP reply or progress, without exposing raw errors or file information',async()=>{
  api.upload.mockRejectedValueOnce({isAxiosError:true,code:'ERR_NETWORK',message:'private/file.pdf',config:{headers:{Cookie:'private-cookie'},url:'private-url'},request:{private:'private-request'}})
  const {container}=render(<AcquisitionWorkspace folders={folders} canManage/>);fireEvent.click(screen.getByRole('tab',{name:'上传 PDF'}));const file=new File(['%PDF-1.7'],'local-name.pdf');fireEvent.change(container.querySelector('input[type=file]')!,{target:{files:[file]}});fireEvent.click(screen.getByRole('button',{name:'上传 1 份 PDF'}))
  await screen.findByRole('alert');const [path,body]=api.upload.mock.calls[0] as [string,FormData],trace=new URL(path,'https://example.test').searchParams.get('upload_trace')!
  expect(trace).toMatch(/^[0-9a-f]{32}$/);expect(body.get('file')).toBe(file)
  const details=screen.getByText('查看技术摘要').parentElement!;expect(details).not.toHaveAttribute('open');fireEvent.click(screen.getByText('查看技术摘要'))
  expect(details).toHaveTextContent(trace);expect(details).toHaveTextContent('ERR_NETWORK');expect(details).toHaveTextContent('未收到HTTP回执');expect(details).toHaveTextContent('未报告');expect(details).not.toHaveTextContent('local-name.pdf');expect(details).not.toHaveTextContent('private')
 })
 it('uses a new trace for each file and records the last browser byte progress while waiting for a reply',async()=>{
  let progress!:(event:AxiosProgressEvent)=>void,reject!:(error:unknown)=>void
  api.upload.mockResolvedValueOnce({registered:false}).mockImplementationOnce((_path,_body,_signal,onProgress)=>{progress=onProgress;return new Promise((_resolve,no)=>{reject=no})})
  const {container}=render(<AcquisitionWorkspace folders={folders} canManage/>);fireEvent.click(screen.getByRole('tab',{name:'上传 PDF'}));fireEvent.change(container.querySelector('input[type=file]')!,{target:{files:[new File(['%PDF-1.7'],'first.pdf'),new File(['%PDF-1.7'],'second.pdf')]}});fireEvent.click(screen.getByRole('button',{name:'上传 2 份 PDF'}));await waitFor(()=>expect(api.upload).toHaveBeenCalledTimes(2))
  const traces=api.upload.mock.calls.map(([path])=>new URL(path,'https://example.test').searchParams.get('upload_trace'));expect(traces.every(trace=>/^[0-9a-f]{32}$/.test(trace!))).toBe(true);expect(new Set(traces).size).toBe(2)
  act(()=>progress(progressEvent(1024,1024)));await act(async()=>reject({isAxiosError:true,code:'ERR_NETWORK'}))
  const details=screen.getByText('查看技术摘要').parentElement!;expect(details).toHaveTextContent(traces[1]!);expect(details).toHaveTextContent('等待服务器回执');expect(details.querySelectorAll('dd')).toHaveLength(7);expect(details).toHaveTextContent('1024 B');expect(screen.getByText('first.pdf',{selector:'strong'})).toBeInTheDocument();expect(screen.getByRole('button',{name:'上传 1 份 PDF'})).toBeEnabled()
 })
 it('disables writes for a read-only user',()=>{render(<AcquisitionWorkspace folders={folders} canManage={false}/>);expect(screen.getByLabelText('待收录的标识符与链接')).toBeDisabled();expect(screen.getByRole('button',{name:'收录 0 项资料'})).toBeDisabled()})
})

it('updates only editable watch fields and never echoes server-only updatedAt',async()=>{
 api.get.mockImplementation(async(path:string)=>path==='/watches'?{items:[{id:'w1',name:'关注 Q5C',sourceIds:['ich'],keywords:'',codes:'Q5C',kinds:[],muted:false,updatedAt:'today'}]}:{groups:[],watchCount:1,days:7,truncated:false})
 render(<SourceWatchPanel sources={[{id:'ich',name:'ICH'}]}/>);fireEvent.click(await screen.findByRole('button',{name:'暂停关注'}))
 await waitFor(()=>expect(api.post).toHaveBeenCalledWith('/watches',{id:'w1',name:'关注 Q5C',sourceIds:['ich'],keywords:'',codes:'Q5C',kinds:[],muted:true}))
})

it('shows deterministic old/new text with original line positions and private usage links',async()=>{
 api.post.mockResolvedValue({available:true,basis:'行号不是 PDF 页码',truncated:false,changeCount:1,blocks:[{kind:'replace',beforeLine:2,afterLine:2,before:'Old limit',after:'New limit'}]});api.get.mockResolvedValue({items:[{id:'n1',kind:'note',title:'Research note',url:'/notes?note=n1',versionIds:['v1'],olderVersion:true,versionUnknown:false}],scope:'仅本人引用',truncated:false})
 render(<VersionChangePanel documentId="doc" versions={[{id:'v1'},{id:'v2'}]}/>);fireEvent.click(screen.getByRole('button',{name:'比较正文并检查引用'}))
 expect(await screen.findByText('Old limit')).toBeInTheDocument();expect(screen.getByText('New limit')).toBeInTheDocument();expect(screen.getByText('引用旧版本，请核对更新')).toBeInTheDocument()
 expect(api.post).toHaveBeenCalledWith('/versions/diff',{documentId:'doc',beforeId:'v1',afterId:'v2'})
 expect(screen.getByRole('link',{name:/Research note/})).toHaveAttribute('href','/notes?note=n1')
})
