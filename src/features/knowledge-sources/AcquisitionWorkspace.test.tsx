import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AxiosProgressEvent } from 'axios'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AcquisitionWorkspace from './AcquisitionWorkspace'
import SourceWatchPanel, { VersionChangePanel } from './SourceWatchPanel'

const api=vi.hoisted(()=>({get:vi.fn(),post:vi.fn(),upload:vi.fn()}))
vi.mock('./v3-api',()=>({knowledgeV3Get:api.get,knowledgeV3Post:api.post,knowledgeV3Upload:api.upload}))
const folders=[{id:'topic',name:'稳定性研究'},{id:'inbox',name:'待整理',systemRole:'inbox' as const}]
const imported={items:[{documentId:'doc',title:'Study',alreadyImported:false}],jobs:[],errors:[],downloadRequested:false,indexRequested:false}
const progressEvent=(loaded:number,total?:number):AxiosProgressEvent=>({loaded,total,bytes:loaded,lengthComputable:total!==undefined})
beforeEach(()=>{api.get.mockReset();api.post.mockReset();api.upload.mockReset();api.get.mockImplementation(async(path:string)=>path==='/watches'?{items:[]}:path.startsWith('/digest')?{groups:[],watchCount:0,days:7,truncated:false}:{items:[],scope:'仅本人引用',truncated:false});api.post.mockResolvedValue(imported);api.upload.mockResolvedValue({saved:true})})

describe('knowledge source unified intake',()=>{
 it('shows only PDF upload without source tabs or lookup requests',()=>{
  render(<AcquisitionWorkspace folders={folders} initialFolderId="topic" canManage/>)
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  expect(screen.queryByRole('tab')).not.toBeInTheDocument()
  expect(screen.queryByText('官方来源检索')).not.toBeInTheDocument()
  expect(screen.queryByText('标识符与链接')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('待收录的标识符与链接')).not.toBeInTheDocument();expect(api.get).not.toHaveBeenCalled();expect(api.post).not.toHaveBeenCalled()
  expect(screen.getByLabelText('收录目标文件夹')).toHaveValue('topic')
  expect(screen.queryByRole('option',{name:'默认文件夹'})).not.toBeInTheDocument()
 })
 it('defaults to the actual inbox folder in a view without a current folder',()=>{
  render(<AcquisitionWorkspace folders={[...folders,{id:'manual',name:'手动收录'}]} canManage/>)
  expect(screen.getByLabelText('收录目标文件夹')).toHaveValue('inbox')
  expect(screen.getByRole('option',{name:'待整理'})).toHaveProperty('selected',true)
  expect(screen.queryByRole('option',{name:'默认文件夹'})).not.toBeInTheDocument()
 })
 it('uploads to the actual inbox folder ID when no folder is selected',async()=>{
  const {container}=render(<AcquisitionWorkspace folders={folders} canManage/>)
  expect(screen.getByLabelText('收录目标文件夹')).toHaveValue('inbox')
  fireEvent.change(container.querySelector('input[type=file]')!,{target:{files:[new File(['%PDF-1.7'],'choose-folder.pdf')]}})
  expect(screen.getByRole('button',{name:'上传 1 份 PDF'})).toBeEnabled()
  fireEvent.click(screen.getByRole('button',{name:'上传 1 份 PDF'}))
  await waitFor(()=>expect(api.upload).toHaveBeenCalledOnce())
  const body=api.upload.mock.calls[0][1] as FormData
  expect(body.get('folderId')).toBe('inbox');expect(body.has('noFolder')).toBe(false)
 })
 it('does not silently redirect a missing or deleted destination',()=>{
  const manual={id:'manual',name:'手动收录'}
  const view=render(<AcquisitionWorkspace folders={[...folders,manual]} initialFolderId="missing" canManage/>)
  expect(screen.getByLabelText('收录目标文件夹')).toHaveValue('missing')
  expect(screen.getByRole('option',{name:'文件夹已不存在，请重新选择'})).toHaveProperty('selected',true)
  fireEvent.change(screen.getByLabelText('收录目标文件夹'),{target:{value:'topic'}})
  view.rerender(<AcquisitionWorkspace folders={[manual,folders[1]]} initialFolderId="missing" canManage/>)
  expect(screen.getByLabelText('收录目标文件夹')).toHaveValue('topic')
  fireEvent.change(view.container.querySelector('input[type=file]')!,{target:{files:[new File(['%PDF-1.7'],'deleted-folder.pdf')]}})
  expect(screen.getByRole('button',{name:'上传 1 份 PDF'})).toBeDisabled()
  fireEvent.change(screen.getByLabelText('收录目标文件夹'),{target:{value:'inbox'}})
  expect(screen.getByRole('button',{name:'上传 1 份 PDF'})).toBeEnabled()
 })
 it('retains a chosen destination if the background folder context changes while adding files',()=>{
  const other={id:'other',name:'其他主题'},next={id:'next',name:'切换后的主题'}
  const view=render(<AcquisitionWorkspace folders={[...folders,other,next]} initialFolderId="topic" canManage/>)
  fireEvent.change(screen.getByLabelText('收录目标文件夹'),{target:{value:'other'}})
  view.rerender(<AcquisitionWorkspace folders={[...folders,other,next]} initialFolderId="next" canManage/>)
  expect(screen.getByLabelText('收录目标文件夹')).toHaveValue('other')
 })
 it('keeps eligible files from a mixed selection and identifies each rejected file', async () => {
   render(<AcquisitionWorkspace folders={folders} canManage />)
   const input = screen.getByLabelText('选择文件')
   const oversized = new File([], '附件.pdf')
   Object.defineProperty(oversized, 'size', { value: 25 * 1024 * 1024 + 1 })
   const pdf = new File(['%PDF-1.7'], '研究资料.PDF')
   fireEvent.change(input, { target: { files: [new File([], '笔记.txt'), pdf, oversized] } })

   const skipped = within(screen.getByRole('status'))
   expect(skipped.getByText('本次有 2 份文件未加入')).toBeInTheDocument()
   expect(skipped.getByText('笔记.txt · 仅支持 PDF 文件')).toBeInTheDocument()
   expect(skipped.getByText('附件.pdf · 超过每份 25 MB 的限制')).toBeInTheDocument()
   expect(screen.getByText(/还可添加 9 份/)).toBeInTheDocument()
   fireEvent.click(screen.getByRole('button', { name: '上传 1 份 PDF' }))
   await screen.findByText('已上传 1 / 1 份')
   expect(api.upload).toHaveBeenCalledOnce()
   expect(api.upload.mock.calls[0][1].get('file').name).toBe(pdf.name)
 })
 it('fills remaining slots on drop and lets a skipped file be selected after a removal', () => {
   render(<AcquisitionWorkspace folders={folders} canManage />)
   const input = screen.getByLabelText('选择文件')
   const original = Array.from({ length: 9 }, (_, i) => new File([], `已有${i + 1}.pdf`))
   fireEvent.change(input, { target: { files: original } })
   const lastSlot = new File([], '正好25MB.pdf')
   Object.defineProperty(lastSlot, 'size', { value: 25 * 1024 * 1024 })
   const extra = [new File([], '下一份.pdf'), new File([], '最后一份.pdf')]
   fireEvent.drop(screen.getByText('将 PDF 拖到这里'), { dataTransfer: { files: [lastSlot, ...extra] } })

   const queued = within(screen.getByLabelText('待上传文件'))
   expect(queued.getByText('已有1.pdf')).toBeInTheDocument()
   expect(queued.getByText('正好25MB.pdf')).toBeInTheDocument()
   expect(queued.getByText(/还可添加 0 份/)).toBeInTheDocument()
   for (const file of extra) {
     expect(queued.queryByText(file.name)).not.toBeInTheDocument()
     expect(screen.getByText(`${file.name} · 本批已满 10 份，可在下一批上传`)).toBeInTheDocument()
   }
   fireEvent.click(queued.getByRole('button', { name: '移除 已有1.pdf' }))
   fireEvent.change(input, { target: { files: [extra[0]] } })
   expect(queued.getByText('下一份.pdf')).toBeInTheDocument()
   expect(screen.queryByText(/本次有 .* 份文件未加入/)).not.toBeInTheDocument()
   expect(screen.getByRole('button', { name: '上传 10 份 PDF' })).toBeEnabled()
 })
 it('explains an unreadable local file before attempting any network upload',async()=>{
  const read=vi.spyOn(FileReader.prototype,'readAsArrayBuffer').mockImplementation(function(this:FileReader){Object.defineProperty(this,'error',{value:new DOMException('private local path','NotReadableError')});this.dispatchEvent(new ProgressEvent('error'))})
  try{
   const {container}=render(<AcquisitionWorkspace folders={folders} initialFolderId="topic" canManage/>)
   fireEvent.change(container.querySelector('input[type=file]')!,{target:{files:[new File(['%PDF-1.7'],'cloud.pdf')]}});fireEvent.click(screen.getByRole('button',{name:'上传 1 份 PDF'}))
   expect(await screen.findByRole('alert')).toHaveTextContent('请先下载到本机，再重新选择。');expect(screen.getByText('本地文件未就绪，尚未上传。')).toBeInTheDocument();expect(api.upload).not.toHaveBeenCalled();expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();expect(screen.queryByText('查看技术摘要')).not.toBeInTheDocument()
  }finally{read.mockRestore()}
 })
 it('does not attach a previous upload trace to a later local file read failure', async () => {
  const readNormally = FileReader.prototype.readAsArrayBuffer
  const read = vi.spyOn(FileReader.prototype, 'readAsArrayBuffer')
    .mockImplementationOnce(function(this: FileReader, blob) { readNormally.call(this, blob) })
    .mockImplementationOnce(function(this: FileReader) {
      Object.defineProperty(this, 'error', { value: new DOMException('local fixture error', 'NotReadableError') })
      this.dispatchEvent(new ProgressEvent('error'))
    })
  try {
    const onImported = vi.fn()
    const { container } = render(<AcquisitionWorkspace folders={folders} canManage onImported={onImported}/>)
    const files = [new File(['%PDF-1.7'], 'first.pdf'), new File(['%PDF-1.7'], 'cloud.pdf')]
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files } })
    fireEvent.click(screen.getByRole('button', { name: '上传 2 份 PDF' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('请先下载到本机')
    expect(api.upload).toHaveBeenCalledOnce()
    expect(onImported).toHaveBeenCalledOnce()
    expect(screen.queryByText('查看技术摘要')).not.toBeInTheDocument()
  } finally {
    read.mockRestore()
  }
 })
 it('uses the shared upload bridge and leaves indexing off by default',async()=>{
  const refresh=vi.fn();const {container}=render(<AcquisitionWorkspace folders={folders} initialFolderId="topic" canManage onImported={refresh}/>)
  const input=container.querySelector('input[type=file]')!;const file=new File(['%PDF-1.7'],'study.pdf',{type:'application/pdf'});fireEvent.change(input,{target:{files:[file]}})
  expect(screen.getByLabelText('收录目标文件夹')).toHaveValue('topic');fireEvent.click(screen.getByRole('button',{name:'上传 1 份 PDF'}))
  await waitFor(()=>expect(api.upload).toHaveBeenCalledOnce());const [path,body]=api.upload.mock.calls[0] as [string,FormData]
  expect(path).toMatch(/^\/upload\?upload_trace=[0-9a-f]{32}$/);expect(body.get('file')).not.toBe(file);expect(body.get('file')).toMatchObject({name:file.name,size:file.size,type:file.type});expect(body.get('folderId')).toBe('topic');expect(body.has('noFolder')).toBe(false);expect(body.get('parse')).toBe('false')
  await waitFor(()=>expect(refresh).toHaveBeenCalledOnce())
 })
 it('preserves a confirmed upload and its undo receipt when the next upload fails, refreshing once',async()=>{
  const refresh=vi.fn(),undo=vi.fn()
  api.upload.mockResolvedValueOnce({saved:true,registered:false,indexStatus:'not_requested',ruleFiling:[{undoTokens:['undo-first']}]}).mockRejectedValueOnce({isAxiosError:true,response:{status:500,data:'Internal Server Error'}})
  const {container}=render(<AcquisitionWorkspace folders={folders} initialFolderId="topic" canManage onImported={refresh} onUndoTokens={undo}/>)
  const first=new File(['%PDF-1.7 first'],'first.pdf',{type:'application/pdf'}),second=new File(['%PDF-1.7 second'],'second.pdf',{type:'application/pdf'})
  fireEvent.change(container.querySelector('input[type=file]')!,{target:{files:[first,second]}});fireEvent.click(screen.getByRole('button',{name:'上传 2 份 PDF'}))
  expect(await screen.findByRole('alert')).toHaveTextContent('知识源服务处理失败')
  expect(screen.getByText('first.pdf',{selector:'strong'})).toBeInTheDocument();expect(screen.getByText(/原件已保存 · 待登记/)).toBeInTheDocument()
  expect(screen.getByText('second.pdf',{selector:'.kso-intake-file span'})).toBeInTheDocument();expect(screen.getAllByRole('button',{name:/^移除 /})).toHaveLength(1)
  expect(screen.getByRole('button',{name:'上传 1 份 PDF'})).toBeEnabled();expect(refresh).toHaveBeenCalledOnce();expect(undo).toHaveBeenCalledExactlyOnceWith(['undo-first'])
  expect(api.upload.mock.calls.map(([,body])=>(body as FormData).get('parse'))).toEqual(['false','false'])
 })
 it('retains the first failed file without implying it was not saved or refreshing a confirmed success',async()=>{
  const refresh=vi.fn();api.upload.mockRejectedValueOnce({isAxiosError:true,code:'ETIMEDOUT', message:'private-file-name.pdf',config:{url:'private-url'}})
  const {container}=render(<AcquisitionWorkspace folders={folders} initialFolderId="topic" canManage onImported={refresh}/>)
  const file=new File(['%PDF-1.7'],'uncertain.pdf',{type:'application/pdf'});fireEvent.change(container.querySelector('input[type=file]')!,{target:{files:[file]}});fireEvent.click(screen.getByRole('button',{name:'上传 1 份 PDF'}))
  expect(await screen.findByRole('alert')).toHaveTextContent('响应超时')
  const trace = new URL(api.upload.mock.calls[0][0], 'https://fixture.test').searchParams.get('upload_trace')!
  const summary = screen.getByText('查看技术摘要').parentElement!
  expect(summary).toHaveTextContent(trace)
  expect(summary).toHaveTextContent('未收到HTTP回执')
  expect(summary).toHaveTextContent('未报告')
  expect(summary).toHaveTextContent('ETIMEDOUT')
  expect(summary).not.toHaveTextContent('private')
  expect(summary).not.toHaveTextContent('uncertain.pdf')
  expect(screen.getByText('uncertain.pdf',{selector:'.kso-intake-file span'})).toBeInTheDocument();expect(screen.getByRole('button',{name:'上传 1 份 PDF'})).toBeEnabled();expect(refresh).not.toHaveBeenCalled()
 })
 it('shows real network upload progress, then waits for the save receipt instead of declaring success at 100%',async()=>{
  const refresh=vi.fn();let progress!:(event:AxiosProgressEvent)=>void,resolve!:(value:unknown)=>void
  api.upload.mockImplementation((_path,_body,_signal,onProgress)=>{progress=onProgress;return new Promise(done=>{resolve=done})})
  const {container}=render(<AcquisitionWorkspace folders={folders} initialFolderId="topic" canManage onImported={refresh}/>)
  fireEvent.change(container.querySelector('input[type=file]')!,{target:{files:[new File(['%PDF-1.7'],'progress.pdf',{type:'application/pdf'})]}});fireEvent.click(screen.getByRole('button',{name:'上传 1 份 PDF'}))
  await waitFor(()=>expect(api.upload).toHaveBeenCalledOnce())
  const bar=screen.getByRole('progressbar',{name:'当前文件网络上传进度'})
  expect(bar).not.toHaveAttribute('value');expect(screen.getByText('1 / 1 份')).toBeInTheDocument()
  act(()=>progress(progressEvent(25,100)));expect(bar).toHaveAttribute('value','25');expect(screen.getByText('正在上传 · 25%')).toBeInTheDocument()
  act(()=>progress(progressEvent(100,100)));expect(screen.getByText('正在解析并保存…')).toBeInTheDocument();expect(refresh).not.toHaveBeenCalled();expect(screen.queryByText('原件已保存。')).not.toBeInTheDocument()
  await act(async()=>resolve({registered:false,indexStatus:'not_requested'}))
  expect(screen.getByText('原件已保存。')).toBeInTheDocument();expect(screen.getByText('1 / 1 份')).toBeInTheDocument();expect(refresh).toHaveBeenCalledOnce()
  act(()=>progress(progressEvent(50,100)));expect(screen.getByText('原件已保存。')).toBeInTheDocument();expect(bar).toHaveAttribute('value','100')
 })
 it('resets progress for each file, ignores late events, and keeps partial receipts after a later failure',async()=>{
  const refresh=vi.fn(),undo=vi.fn(),requests:{progress:(e:AxiosProgressEvent)=>void;resolve:(value:unknown)=>void;reject:(error:unknown)=>void}[]=[]
  api.upload.mockImplementation((_path,_body,_signal,onProgress)=>new Promise((resolve,reject)=>requests.push({progress:onProgress,resolve,reject})))
  const {container}=render(<AcquisitionWorkspace folders={folders} initialFolderId="topic" canManage onImported={refresh} onUndoTokens={undo}/>)
  fireEvent.change(container.querySelector('input[type=file]')!,{target:{files:[new File(['%PDF-1.7'],'first-progress.pdf'),new File(['%PDF-1.7'],'second-progress.pdf')]}});fireEvent.click(screen.getByRole('button',{name:'上传 2 份 PDF'}))
  await waitFor(()=>expect(requests).toHaveLength(1));await act(async()=>requests[0].resolve({registered:false,ruleFiling:[{undoTokens:['progress-undo']}]}));await waitFor(()=>expect(requests).toHaveLength(2))
  expect(screen.getByText('2 / 2 份')).toBeInTheDocument();const bar=screen.getByRole('progressbar',{name:'当前文件网络上传进度'});expect(bar).not.toHaveAttribute('value')
  act(()=>requests[0].progress(progressEvent(100,100)));expect(bar).not.toHaveAttribute('value')
  act(()=>requests[1].progress(progressEvent(30)));expect(bar).not.toHaveAttribute('value');expect(screen.getByText('正在上传…')).toBeInTheDocument()
  act(()=>requests[1].progress(progressEvent(40,100)));expect(bar).toHaveAttribute('value','40')
  const traces = api.upload.mock.calls.map(([path]) => new URL(path, 'https://fixture.test').searchParams.get('upload_trace')!)
  expect(new Set(traces).size).toBe(2)
  expect(traces.every(trace => /^[0-9a-f]{32}$/.test(trace))).toBe(true)
  act(() => requests[1].progress(progressEvent(100, 100)))
  await act(async()=>requests[1].reject({isAxiosError:true,code:'ETIMEDOUT'}))
  const summary = screen.getByText('查看技术摘要').parentElement!
  expect(summary).toHaveTextContent(traces[1])
  expect(summary).not.toHaveTextContent(traces[0])
  expect(summary).toHaveTextContent('等待服务器回执')
  expect(summary).toHaveTextContent('100 B')
  expect(screen.getByRole('alert')).toHaveTextContent('已确认保存 1 份');expect(screen.getByText('保存结果待确认，请核对后重试。')).toBeInTheDocument();expect(screen.getByRole('button',{name:'上传 1 份 PDF'})).toBeEnabled();expect(screen.getByText('first-progress.pdf',{selector:'strong'})).toBeInTheDocument();expect(refresh).toHaveBeenCalledOnce();expect(undo).toHaveBeenCalledExactlyOnceWith(['progress-undo'])
  act(()=>requests[1].progress(progressEvent(10,100)));expect(bar).toHaveAttribute('value','100')
 })
 it('aborts the current upload on close without starting another file or confirming a save',async()=>{
  const refresh=vi.fn();let signal!:AbortSignal,progress!:(event:AxiosProgressEvent)=>void
  api.upload.mockImplementation((_path,_body,currentSignal,onProgress)=>{signal=currentSignal;progress=onProgress;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject({isAxiosError:true,code:'ERR_CANCELED'}),{once:true}))})
  const {container,unmount}=render(<AcquisitionWorkspace folders={folders} initialFolderId="topic" canManage onImported={refresh}/>)
  fireEvent.change(container.querySelector('input[type=file]')!,{target:{files:[new File(['%PDF-1.7'],'cancel-first.pdf'),new File(['%PDF-1.7'],'cancel-second.pdf')]}});fireEvent.click(screen.getByRole('button',{name:'上传 2 份 PDF'}));await waitFor(()=>expect(api.upload).toHaveBeenCalledOnce())
  await act(async()=>unmount());expect(signal.aborted).toBe(true);act(()=>progress(progressEvent(100,100)));expect(api.upload).toHaveBeenCalledOnce();expect(refresh).not.toHaveBeenCalled()
 })
 it('disables writes for a read-only user',()=>{render(<AcquisitionWorkspace folders={folders} initialFolderId="topic" canManage={false}/>);expect(screen.getByRole('button',{name:'上传 0 份 PDF'})).toBeDisabled();expect(screen.getByLabelText('收录目标文件夹')).toBeDisabled()})
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

it('blocks submission until the actual inbox exists, without claiming an unfiled target',()=>{
 const {container}=render(<AcquisitionWorkspace folders={[]} canManage/>)
 fireEvent.change(container.querySelector('input[type=file]')!,{target:{files:[new File(['%PDF-1.7'],'waiting.pdf')]}})
 expect(screen.getByRole('button',{name:'上传 1 份 PDF'})).toBeDisabled()
 expect(screen.getByRole('option',{name:'正在准备待整理文件夹…'})).toBeInTheDocument()
})
