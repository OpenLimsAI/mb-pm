import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KnowledgeSourceSnapshot } from './api'
import type { LibraryPaper, LibraryQuery } from './v3-api'
import LibraryWorkbench from './LibraryWorkbench'
import FolderTree from './FolderTree'

const network=vi.hoisted(()=>({get:vi.fn(),post:vi.fn(),download:vi.fn()}))
vi.mock('./v3-api',()=>({knowledgeV3Get:network.get,knowledgeV3Post:network.post,knowledgeV3Download:network.download}))
vi.mock('./SmartCollections',()=>({default:()=>null}))
vi.mock('./ReadingQueue',()=>({default:()=>null}))
vi.mock('./DuplicateReview',()=>({default:()=>null}))
vi.mock('./ResearchTools',()=>({default:({onOpenEvidence}:{onOpenEvidence:(id:string,offset?:number)=>void})=><button onClick={()=>onOpenEvidence('external-paper',321)}>打开跨页原文证据</button>}))
vi.mock('./PaperReaderPanel',()=>({default:({paper,initialOffset,onClose}:{paper:LibraryPaper;initialOffset?:number;onClose:()=>void})=><section aria-label="资料阅读面板"><strong>{paper.title}</strong><p>定位字符 {initialOffset??0}</p><button onClick={onClose}>关闭页内阅读</button></section>}))

const data:KnowledgeSourceSnapshot={papers:[],folders:[{id:'topic',name:'稳定性研究'}],sources:[],jobs:[],documents:[],catalogRevision:1,canManage:true,canOrganize:true,starred:[],integration:{status:'ready',message:''}}
const row=(number:number):LibraryPaper=>({id:`paper-${number}`,title:`Paper ${number}`,folderIds:[],sourceName:'知识库',saved:true,indexStatus:'ready'})
let key=0
function renderWorkbench(extra:Partial<Parameters<typeof LibraryWorkbench>[0]>={}) {
 const props={data,folder:'all',storageKey:`library-v3-test-${++key}`,density:'compact' as const,busy:false,onRefresh:vi.fn(),onAdd:vi.fn(),onDensityChange:vi.fn(),onOrganize:vi.fn().mockResolvedValue(true),onCounts:vi.fn(),...extra}
 return {...render(<LibraryWorkbench {...props}/>),props}
}
beforeEach(()=>{
 window.history.replaceState({},'', '/knowledge-sources');network.get.mockReset();network.post.mockReset();network.download.mockReset();network.download.mockResolvedValue(undefined)
 network.get.mockResolvedValue({reading:{},collections:[],rules:[],location:{}})
 network.post.mockImplementation(async(path:string,body:LibraryQuery)=>{
  if(path==='/library/query'){const offset=body.offset;return {papers:Array.from({length:Math.min(50,120-offset)},(_,i)=>row(offset+i+1)),offset,limit:50,total:120,nextOffset:offset+50<120?offset+50:null,revision:1,folderCounts:{topic:12},searchIndex:{complete:true,indexing:false,indexed:120,total:120,failed:0}}}
  if(path==='/library/detail')return {paper:{...row(999),id:'external-paper',title:'Cross-page evidence'},text:'Evidence',textOffset:321,totalCharacters:1000}
  return {saved:true}
 })
})

describe('knowledge source library workbench paging and evidence',()=>{
 it('reads through the title and always offers a single adjustment action on each row',async()=>{
  const onDelete=vi.fn()
  renderWorkbench({onDelete})
  const adjust=await screen.findByRole('button',{name:'调整文件 Paper 2'})
  const paperRow=adjust.closest('article')!
  expect(adjust).toHaveTextContent('调整文件')
  expect(within(paperRow).queryByRole('button',{name:/更多|导出|移出|删除/})).not.toBeInTheDocument()
  fireEvent.contextMenu(paperRow)
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  fireEvent.click(within(paperRow).getByRole('button',{name:/^Paper 2\b/}))
  expect(await screen.findByRole('region',{name:'资料阅读面板'})).toHaveTextContent('Paper 2')
  expect(screen.getByRole('checkbox',{name:'选择 Paper 2'})).not.toBeChecked()
  fireEvent.click(screen.getByRole('button',{name:'关闭页内阅读'}))
  const bar=within(screen.getByLabelText('论文选择与批量操作'))
  for(const name of ['拷贝到…','移动到…','移出此文件夹','删除','添加标签','导出所选']){
   expect(bar.getByRole('button',{name})).toBeDisabled()
  }
  expect(bar.queryByText('更多操作')).not.toBeInTheDocument()
  fireEvent.click(adjust)
  fireEvent.click(adjust)
  expect(bar.getByText('已选 1 篇')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:'调整文件 Paper 3'}))
  expect(bar.getByText('已选 2 篇')).toBeInTheDocument()
  expect(screen.getByRole('checkbox',{name:'选择 Paper 2'})).toBeChecked()
  expect(screen.queryByRole('region',{name:'资料阅读面板'})).not.toBeInTheDocument()
  expect(bar.getByRole('button',{name:'移出此文件夹'})).toBeDisabled()
  fireEvent.click(within(paperRow).getByRole('button',{name:/^Paper 2\b/}))
  expect(await screen.findByRole('region',{name:'资料阅读面板'})).toBeVisible()
  fireEvent.click(bar.getByRole('button',{name:'删除'}))
  expect(onDelete).toHaveBeenCalledExactlyOnceWith([row(2),row(3)],expect.any(Function))
  expect(screen.getByRole('checkbox',{name:'选择 Paper 3'})).toBeChecked()
  act(()=>onDelete.mock.calls[0][1]('paper-2'))
  expect(screen.queryByRole('region',{name:'资料阅读面板'})).not.toBeInTheDocument()
  expect(new URLSearchParams(window.location.search).has('paper')).toBe(false)
  expect(screen.getByRole('checkbox',{name:'选择 Paper 2'})).not.toBeChecked()
  expect(screen.getByRole('checkbox',{name:'选择 Paper 3'})).toBeChecked()
 })

 it('removes precisely the selected papers from the open folder across pages',async()=>{
  const onRemoveFromFolder=vi.fn().mockResolvedValue(true)
  renderWorkbench({folder:'topic',onRemoveFromFolder})
  fireEvent.click(await screen.findByRole('button',{name:'调整文件 Paper 2'}))
  fireEvent.click(screen.getByRole('button',{name:'下一页'}))
  fireEvent.click(await screen.findByRole('button',{name:'调整文件 Paper 51'}))
  fireEvent.click(within(screen.getByLabelText('论文选择与批量操作')).getByRole('button',{name:'移出此文件夹'}))
  await waitFor(()=>expect(onRemoveFromFolder).toHaveBeenCalledExactlyOnceWith([row(2),row(51)]))
  await waitFor(()=>expect(screen.getByRole('checkbox',{name:'选择 Paper 51'})).not.toBeChecked())
 })

 it('retains read and export access without offering enabled library write actions to a reader',async()=>{
  renderWorkbench({folder:'topic', data:{...data,canOrganize:false,canManage:false,canEdit:false},onDelete:vi.fn(),onRemoveFromFolder:vi.fn()})
  fireEvent.click(await screen.findByRole('button',{name:'调整文件 Paper 2'}))
  const bar=within(screen.getByLabelText('论文选择与批量操作'))
  for(const name of ['拷贝到…','移动到…','移出此文件夹','删除','添加标签']){
   expect(bar.queryByRole('button',{name})?.matches(':enabled')).not.toBe(true)
  }
  expect(bar.getByRole('button',{name:'导出所选'})).toBeEnabled()
 })

 it('keeps advanced tools and filters out of the default list',async()=>{
  renderWorkbench();await screen.findByRole('checkbox',{name:'选择 Paper 1'})
  expect(screen.queryByRole('combobox',{name:'搜索范围'})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'打开跨页原文证据'})).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:'筛选'}));expect(screen.getByRole('combobox',{name:'搜索范围'})).toBeInTheDocument();expect(screen.getByRole('combobox',{name:'阅读状态'})).toBeInTheDocument()
 })
 it('renders at most 50 papers and sends the next page offset to the server',async()=>{
  const {props}=renderWorkbench();await screen.findByRole('checkbox',{name:'选择 Paper 50'})
  expect(screen.queryByRole('checkbox',{name:'选择 Paper 51'})).not.toBeInTheDocument()
  expect(screen.getAllByRole('checkbox',{name:/^选择 Paper /})).toHaveLength(50)
  expect(network.post).toHaveBeenCalledWith('/library/query',expect.objectContaining({offset:0,limit:50}),expect.any(AbortSignal))
  expect(props.onCounts).toHaveBeenCalledWith({topic:12})
  fireEvent.click(screen.getByRole('button',{name:'下一页'}));await screen.findByRole('checkbox',{name:'选择 Paper 51'})
  expect(network.post).toHaveBeenCalledWith('/library/query',expect.objectContaining({offset:50,limit:50}),expect.any(AbortSignal))
  expect(screen.queryByRole('checkbox',{name:'选择 Paper 1'})).not.toBeInTheDocument();expect(screen.getByText('51—100 / 120 · 每页最多 50 篇')).toBeInTheDocument()
 })
 it('sends a full-text query and distinguishes incomplete indexing from zero results',async()=>{
  network.post.mockImplementation(async(path:string,body:LibraryQuery)=>path==='/library/query'?{papers:body.query?[{...row(1),matches:[{text:'protein evidence excerpt',offset:450,field:'body'}]}]:[row(1)],total:1,offset:0,limit:50,nextOffset:null,revision:1,incomplete:true,searchIndex:{complete:false,indexing:false,indexed:7,total:20,failed:2}}:{saved:true})
  renderWorkbench();await screen.findByRole('checkbox',{name:'选择 Paper 1'})
  expect(screen.getByText(/全文检索覆盖 7 \/ 20 篇/)).toBeInTheDocument();expect(screen.getByText(/2 篇待重试/)).toBeInTheDocument()
  fireEvent.change(screen.getByRole('textbox',{name:'全文搜索资料'}),{target:{value:'protein'}})
  await screen.findByText(/protein evidence excerpt/)
  expect(network.post).toHaveBeenCalledWith('/library/query',expect.objectContaining({query:'protein',searchMode:'all',offset:0,limit:50}),expect.any(AbortSignal))
  fireEvent.click(screen.getByRole('button',{name:/^Paper 1\b/}));const reader=await screen.findByRole('region',{name:'资料阅读面板'});expect(within(reader).getByText('定位字符 450')).toBeInTheDocument()
 })
 it('selects an inclusive contiguous range with Shift without selecting unrelated rows',async()=>{
  renderWorkbench();fireEvent.click(await screen.findByRole('checkbox',{name:'选择 Paper 2'}));fireEvent.click(screen.getByRole('checkbox',{name:'选择 Paper 5'}),{shiftKey:true})
  for(const n of [2,3,4,5])expect(screen.getByRole('checkbox',{name:`选择 Paper ${n}`})).toBeChecked()
  for(const n of [1,6])expect(screen.getByRole('checkbox',{name:`选择 Paper ${n}`})).not.toBeChecked()
  expect(screen.getByText('已选 4 篇')).toBeInTheDocument()
 })
 it('keeps selection controls in the existing toolbar and preserves batch organization',async()=>{
  const {props}=renderWorkbench();await screen.findByRole('checkbox',{name:'选择 Paper 1'})
  const toolbar=screen.getByLabelText('论文选择与批量操作'),list=screen.getByLabelText('论文列表')
  expect(within(toolbar).getByRole('checkbox',{name:'全选本页论文'})).toBeInTheDocument()
  const firstRow=screen.getByRole('checkbox',{name:'选择 Paper 1'}).closest('article')
  fireEvent.click(screen.getByRole('checkbox',{name:'选择 Paper 2'}))
  expect(screen.getByLabelText('论文选择与批量操作')).toBe(toolbar)
  expect(list.firstElementChild).toBe(firstRow)
  expect(within(toolbar).getByText('已选 1 篇')).toBeInTheDocument()
  fireEvent.click(within(toolbar).getByRole('button',{name:'拷贝到…'}))
  const destination=screen.getByRole('combobox',{name:'批量整理目标文件夹'})
  fireEvent.keyDown(destination,{key:'ArrowDown'})
  expect(screen.queryByRole('region',{name:'资料阅读面板'})).not.toBeInTheDocument()
  fireEvent.change(destination,{target:{value:'topic'}});fireEvent.click(screen.getByRole('button',{name:'确认拷贝'}))
  await waitFor(()=>expect(props.onOrganize).toHaveBeenCalledWith(['paper-2'],'topic',false))
  await waitFor(()=>expect(screen.getByRole('checkbox',{name:'选择 Paper 2'})).not.toBeChecked())
  expect(screen.getByLabelText('论文选择与批量操作')).toBe(toolbar)
 })
 it('closes the action popover with Escape without clearing selected papers',async()=>{
  renderWorkbench();fireEvent.click(await screen.findByRole('checkbox',{name:'选择 Paper 2'}))
  const summary=screen.getByRole('button',{name:'拷贝到…'})
  fireEvent.click(summary);expect(summary).toHaveAttribute('aria-expanded','true')
  fireEvent.keyDown(screen.getByRole('combobox',{name:'批量整理目标文件夹'}),{key:'Escape'})
  expect(summary).toHaveAttribute('aria-expanded','false');expect(summary).toHaveFocus()
  expect(screen.getByRole('checkbox',{name:'选择 Paper 2'})).toBeChecked()
  fireEvent.click(screen.getByRole('button',{name:'取消选择'}))
  expect(screen.getByRole('checkbox',{name:'选择 Paper 2'})).not.toBeChecked()
 })
 it('displays tag and export controls directly and dismisses the folder picker on outside interaction',async()=>{
  renderWorkbench();fireEvent.click(await screen.findByRole('button',{name:'调整文件 Paper 2'}))
  const bar=within(screen.getByLabelText('论文选择与批量操作'))
  expect(bar.getByRole('textbox',{name:'批量添加共享标签'})).toBeVisible()
  expect(bar.getByRole('combobox',{name:'资料导出格式'})).toBeEnabled()
  expect(bar.getByRole('button',{name:'导出所选'})).toBeVisible()
  expect(bar.queryByText('更多操作')).not.toBeInTheDocument()
  const copy=bar.getByRole('button',{name:'拷贝到…'})
  fireEvent.click(copy);expect(copy).toHaveAttribute('aria-expanded','true')
  fireEvent.pointerDown(screen.getByRole('textbox',{name:'全文搜索资料'}));expect(copy).toHaveAttribute('aria-expanded','false')
  expect(screen.getByRole('checkbox',{name:'选择 Paper 2'})).toBeChecked()
  network.post.mockResolvedValueOnce({savedCount:1,results:[{paperId:'paper-2',saved:true}]})
  fireEvent.change(bar.getByRole('textbox',{name:'批量添加共享标签'}),{target:{value:'归档'}})
  fireEvent.click(bar.getByRole('button',{name:'添加标签'}))
  await waitFor(()=>expect(network.post).toHaveBeenCalledWith('/library/tags',{paperIds:['paper-2'],tags:['归档'],mode:'add',revision:0}))
 })
 it('uses separate copy and move actions and only permits moving from a real different folder',async()=>{
  const current={...data,folders:[...data.folders,{id:'target',name:'分析方法'}]}
  const first=renderWorkbench({data:current,folder:'topic'});fireEvent.click(await screen.findByRole('checkbox',{name:'选择 Paper 2'}))
  fireEvent.click(screen.getByRole('button',{name:'拷贝到…'}))
  expect(screen.getByRole('button',{name:'确认拷贝'})).toBeDisabled()
  fireEvent.click(screen.getByRole('button',{name:'移动到…'}))
  expect(screen.queryByRole('button',{name:'确认拷贝'})).not.toBeInTheDocument()
  const destination=screen.getByRole('combobox',{name:'批量整理目标文件夹'})
  expect(within(destination).queryByRole('option',{name:'稳定性研究'})).not.toBeInTheDocument()
  fireEvent.change(destination,{target:{value:'target'}});fireEvent.click(screen.getByRole('button',{name:'确认移动'}))
  await waitFor(()=>expect(first.props.onOrganize).toHaveBeenCalledWith(['paper-2'],'target',true))
  first.unmount()
  renderWorkbench({data:current,folder:'all'});fireEvent.click(await screen.findByRole('checkbox',{name:'选择 Paper 2'}))
  expect(screen.getByRole('button',{name:'移动到…'})).toBeDisabled()
  expect(screen.getByRole('button',{name:'拷贝到…'})).toBeEnabled()
 })
 it('retains cross-page selections and exports the exact selected papers in the chosen format',async()=>{
  renderWorkbench();fireEvent.click(await screen.findByRole('checkbox',{name:'选择 Paper 2'}));fireEvent.click(screen.getByRole('button',{name:'下一页'}));fireEvent.click(await screen.findByRole('checkbox',{name:'选择 Paper 51'}))
  expect(screen.getByText('已选 2 篇 · 其中 1 篇不在本页')).toBeInTheDocument()
  fireEvent.change(screen.getByRole('combobox',{name:'资料导出格式'}),{target:{value:'ris'}});fireEvent.click(screen.getByRole('button',{name:'导出所选'}))
  await waitFor(()=>expect(network.download).toHaveBeenCalledWith('/library/export',{paperIds:['paper-2','paper-51'],format:'ris'},'知识源资料.ris'))
  expect(await screen.findByText('资料包已生成，请查看浏览器下载。')).toBeInTheDocument()
 })
 it('opens evidence outside the current page through authorized detail lookup and preserves its location',async()=>{
  renderWorkbench();await screen.findByRole('checkbox',{name:'选择 Paper 1'});fireEvent.click(screen.getByText('更多工具',{exact:false,selector:'summary'}));fireEvent.click(await screen.findByRole('button',{name:'打开跨页原文证据'}))
  const reader=await screen.findByRole('region',{name:'资料阅读面板'});expect(within(reader).getByText('Cross-page evidence')).toBeInTheDocument();expect(within(reader).getByText('定位字符 321')).toBeInTheDocument()
  expect(network.post).toHaveBeenCalledWith('/library/detail',{paperId:'external-paper',offset:321,limit:48000},expect.any(AbortSignal))
  expect(new URLSearchParams(window.location.search).get('paper')).toBe('external-paper')
  expect(network.post).toHaveBeenCalledWith('/workspace/location',expect.objectContaining({paperId:'external-paper',folderId:'all'}))
 })
})

const treeFolders=[{id:'source',name:'ICH',kind:'source' as const},{id:'parent',name:'稳定性研究'},{id:'child',name:'加速试验',parentId:'parent'}]
function dropEvent(ids:unknown,shiftKey=false){const event=new MouseEvent('drop',{bubbles:true,shiftKey});Object.defineProperty(event,'dataTransfer',{value:{getData:()=>JSON.stringify(ids),types:['application/x-knowledge-papers']}});return event}
describe('knowledge source folder tree',()=>{
 it('expands a real nested folder and opens the child without opening its parent',()=>{
  const open=vi.fn();render(<FolderTree folders={treeFolders} current="child" canOrganize counts={{child:4}} onOpen={open} onDrop={vi.fn()}/>)
  expect(screen.queryByRole('button',{name:/^加速试验\s*4$/})).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'展开稳定性研究'}))
  fireEvent.click(screen.getByRole('button',{name:/^加速试验\s*4$/}));expect(open).toHaveBeenCalledWith('child');expect(open).not.toHaveBeenCalledWith('parent')
  expect(screen.getByRole('button',{name:/^加速试验\s*4$/})).toHaveAttribute('aria-current','page')
  fireEvent.click(screen.getByRole('button',{name:'收起稳定性研究'}));expect(screen.queryByRole('button',{name:/^加速试验\s*4$/})).not.toBeInTheDocument()
 })
 it('adds a classification by default and requests a move only with Shift',()=>{
  const dropped=vi.fn();render(<FolderTree folders={treeFolders} current="all" canOrganize onOpen={vi.fn()} onDrop={dropped}/>)
  fireEvent(screen.getByRole('button',{name:'ICH'}),dropEvent(['paper-1','paper-1','paper-2']));expect(dropped).toHaveBeenLastCalledWith('source',['paper-1','paper-2'],false)
  fireEvent(screen.getByRole('button',{name:'稳定性研究'}),dropEvent(['paper-3'],true));expect(dropped).toHaveBeenLastCalledWith('parent',['paper-3'],true)
 })
 it('blocks writes for read-only users and ignores malformed drop payloads',()=>{
  const dropped=vi.fn();const {rerender}=render(<FolderTree folders={treeFolders} current="all" canOrganize={false} onOpen={vi.fn()} onDrop={dropped}/>)
  fireEvent(screen.getByRole('button',{name:'ICH'}),dropEvent(['paper-1']));expect(dropped).not.toHaveBeenCalled()
  rerender(<FolderTree folders={treeFolders} current="all" canOrganize onOpen={vi.fn()} onDrop={dropped}/>);fireEvent(screen.getByRole('button',{name:'ICH'}),dropEvent({paper:'forged'}));expect(dropped).not.toHaveBeenCalled()
 })
})
