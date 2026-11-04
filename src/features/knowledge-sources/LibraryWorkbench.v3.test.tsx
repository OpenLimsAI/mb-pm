import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  await screen.findByText('protein evidence excerpt')
  expect(network.post).toHaveBeenCalledWith('/library/query',expect.objectContaining({query:'protein',searchMode:'all',offset:0,limit:50}),expect.any(AbortSignal))
  fireEvent.click(screen.getByRole('button',{name:/Paper 1/}));const reader=await screen.findByRole('region',{name:'资料阅读面板'});expect(within(reader).getByText('定位字符 450')).toBeInTheDocument()
 })
 it('selects an inclusive contiguous range with Shift without selecting unrelated rows',async()=>{
  renderWorkbench();fireEvent.click(await screen.findByRole('checkbox',{name:'选择 Paper 2'}));fireEvent.click(screen.getByRole('checkbox',{name:'选择 Paper 5'}),{shiftKey:true})
  for(const n of [2,3,4,5])expect(screen.getByRole('checkbox',{name:`选择 Paper ${n}`})).toBeChecked()
  for(const n of [1,6])expect(screen.getByRole('checkbox',{name:`选择 Paper ${n}`})).not.toBeChecked()
  expect(screen.getByText('已选 4 篇')).toBeInTheDocument()
 })
 it('retains cross-page selections and exports the exact selected papers in the chosen format',async()=>{
  renderWorkbench();fireEvent.click(await screen.findByRole('checkbox',{name:'选择 Paper 2'}));fireEvent.click(screen.getByRole('button',{name:'下一页'}));fireEvent.click(await screen.findByRole('checkbox',{name:'选择 Paper 51'}))
  expect(screen.getByText('已选 2 篇 · 其中 1 篇不在本页')).toBeInTheDocument()
  fireEvent.change(screen.getByRole('combobox',{name:'资料导出格式'}),{target:{value:'ris'}});fireEvent.click(screen.getByRole('button',{name:'导出所选'}))
  await waitFor(()=>expect(network.download).toHaveBeenCalledWith('/library/export',{paperIds:['paper-2','paper-51'],format:'ris'},'知识源资料.ris'))
  expect(await screen.findByText('资料包已生成，请查看浏览器下载。')).toBeInTheDocument()
 })
 it('opens evidence outside the current page through authorized detail lookup and preserves its location',async()=>{
  renderWorkbench();await screen.findByRole('checkbox',{name:'选择 Paper 1'});fireEvent.click(screen.getByRole('button',{name:'打开跨页原文证据'}))
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
