import {act,fireEvent,render,screen,waitFor,within} from '@testing-library/react'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import LibraryWorkbench from './LibraryWorkbench'
import FolderTree from './FolderTree'
import type {KnowledgeSourceSnapshot} from './api'
import type {LibraryPaper,LibraryPage} from './v3-api'
import type {ReadingEntry} from './workspace-v3-types'

const api=vi.hoisted(()=>({get:vi.fn(),post:vi.fn(),download:vi.fn()}))
vi.mock('./v3-api',()=>({knowledgeV3Get:api.get,knowledgeV3Post:api.post,knowledgeV3Download:api.download}))
vi.mock('./SmartCollections',()=>({default:()=>null}))
vi.mock('./ResearchTools',()=>({default:()=>null}))
vi.mock('./DuplicateReview',()=>({default:()=>null}))
vi.mock('./ReadingQueue',()=>({default:({reading,onChanged}:{reading?:ReadingEntry;onChanged:(entry:ReadingEntry)=>void})=><section aria-label="测试阅读状态"><output>{reading?.state||'unread'}</output><button onClick={()=>onChanged({state:'done',versionId:'v1',updatedAt:'2026-11-04T11:00:00Z',position:{offset:900}})}>显式标记读完</button></section>}))
vi.mock('./PaperReaderPanel',()=>({default:({paper,onPdfPosition}:{paper:LibraryPaper;onPdfPosition?:(page:number)=>void})=><section aria-label="测试阅读器"><strong>{paper.title}</strong><button onClick={()=>onPdfPosition?.(2)}>保存PDF第二页</button></section>}))
const data:KnowledgeSourceSnapshot={papers:[],folders:[{id:'topic',name:'稳定性研究'}],sources:[],jobs:[],documents:[],catalogRevision:1,canManage:true,canOrganize:true,starred:[],integration:{status:'ready',message:''}}
const entry:ReadingEntry={state:'reading',versionId:'v1',updatedAt:'2026-11-04T10:00:00Z',position:{offset:1}}
function row(n:number):LibraryPaper{return {id:`sources/paper_${n}.md`,title:`Paper ${n}`,folderIds:['topic'],sourceName:'知识库',type:'Guideline',saved:true,indexStatus:'ready',versionId:'v1',reading:entry}}
function page(offset=0,indexing=false):LibraryPage{return {papers:Array.from({length:50},(_,i)=>row(offset+i+1)),total:120,offset,limit:50,nextOffset:offset+50<120?offset+50:null,revision:1,folderCounts:{topic:120},searchIndex:{complete:!indexing,indexing,indexed:120,total:120,failed:0}}}
const workspace=()=>({revision:0,collections:[],rules:[],reading:{},location:{}})
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return {promise,resolve}}
let sequence=0
function setup(extra:Partial<Parameters<typeof LibraryWorkbench>[0]>={}){const props={data,folder:'all',storageKey:`race-${++sequence}`,density:'compact' as const,busy:false,onRefresh:vi.fn(),onAdd:vi.fn(),onDensityChange:vi.fn(),onOrganize:vi.fn().mockResolvedValue(true),onCounts:vi.fn(),...extra};return {...render(<LibraryWorkbench {...props}/>),props}}
beforeEach(()=>{localStorage.clear();window.history.replaceState({},'','/knowledge-sources');vi.resetAllMocks();api.get.mockResolvedValue(workspace());api.post.mockImplementation(async(path:string,body:Record<string,unknown>)=>path==='/library/query'?page(Number(body.offset)||0):path==='/library/detail'?{paper:{...row(999),id:body.paperId,title:'Restored external document'},text:'source'}:{saved:true})})
afterEach(()=>{vi.useRealTimers()})

it('does not let late server location overwrite typing or trigger repeated workspace loads',async()=>{
 const remote=deferred<ReturnType<typeof workspace>>();api.get.mockReturnValue(remote.promise);setup();await screen.findByRole('checkbox',{name:'选择 Paper 1'});fireEvent.change(screen.getByRole('textbox',{name:'全文搜索资料'}),{target:{value:'my new query'}})
 await act(async()=>{remote.resolve({...workspace(),location:{folderId:'all',query:'stale query',paperId:'old-paper',offset:50,scrollTop:250}} as ReturnType<typeof workspace>);await remote.promise})
 await waitFor(()=>expect(api.post).toHaveBeenCalledWith('/library/query',expect.objectContaining({query:'my new query'}),expect.any(AbortSignal)))
 expect(screen.getByRole('textbox',{name:'全文搜索资料'})).toHaveValue('my new query');expect(api.get).toHaveBeenCalledTimes(1)
 expect(api.post.mock.calls.some(([path,body])=>path==='/library/detail'&&body.paperId==='old-paper')).toBe(false)
})

it('restores a server location only when that folder has no local preferences',async()=>{
 api.get.mockResolvedValue({...workspace(),location:{folderId:'all',query:'protein',paperId:'outside-page',offset:50,scrollTop:140}})
 setup();await screen.findByRole('checkbox',{name:'选择 Paper 51'});expect(screen.getByRole('textbox',{name:'全文搜索资料'})).toHaveValue('protein')
 await screen.findByRole('region',{name:'测试阅读器'});expect(screen.getByText('Restored external document')).toBeInTheDocument()
 await waitFor(()=>expect(screen.getByLabelText('论文列表').scrollTop).toBe(140))
 expect(api.get).toHaveBeenCalledTimes(1)
})

it('preserves intentionally cleared local fields and explicit deep links',async()=>{
 const storageKey=`explicit-${++sequence}`;localStorage.setItem(`${storageKey}:v3:query:all`,'""');localStorage.setItem(`${storageKey}:v3:offset:all`,'0');localStorage.setItem(`${storageKey}:v3:scroll:all`,'0');localStorage.setItem(`${storageKey}:v3:paper:all`,'""')
 api.get.mockResolvedValue({...workspace(),location:{folderId:'all',query:'stale query',paperId:'old-paper',offset:50,scrollTop:200}})
 const first=setup({storageKey});await screen.findByRole('checkbox',{name:'选择 Paper 1'});expect(screen.getByRole('textbox',{name:'全文搜索资料'})).toHaveValue('');expect(screen.getByLabelText('论文列表').scrollTop).toBe(0);first.unmount()
 window.history.replaceState({},'','/knowledge-sources?paper=explicit-paper');setup();await screen.findByRole('region',{name:'测试阅读器'});expect(api.post).toHaveBeenCalledWith('/library/detail',expect.objectContaining({paperId:'explicit-paper'}),expect.any(AbortSignal));expect(screen.getByRole('textbox',{name:'全文搜索资料'})).toHaveValue('')
})

it('retains a newer explicit reading result when a stale query refresh returns',async()=>{
 const view=setup();fireEvent.click(await screen.findByRole('button',{name:/^Paper 1\b/}));fireEvent.click(screen.getByRole('button',{name:'显式标记读完'}));expect(within(screen.getByRole('region',{name:'测试阅读状态'})).getByText('done')).toBeInTheDocument()
 view.rerender(<LibraryWorkbench {...view.props} data={{...data,refreshedAt:'2026-11-04T12:00:00Z'}}/>);await waitFor(()=>expect(api.post.mock.calls.filter(([path])=>path==='/library/query').length).toBe(2));expect(within(screen.getByRole('region',{name:'测试阅读状态'})).getByText('done')).toBeInTheDocument()
})

it('rejects late automatic UI writeback after an explicit done state',async()=>{
 const automatic=deferred<ReadingEntry>();api.post.mockImplementation(async(path:string)=>path==='/library/query'?page():path==='/workspace/reading'?automatic.promise:{saved:true})
 setup();fireEvent.click(await screen.findByRole('button',{name:/^Paper 1\b/}));fireEvent.click(screen.getByRole('button',{name:'保存PDF第二页'}));await waitFor(()=>expect(api.post).toHaveBeenCalledWith('/workspace/reading',expect.objectContaining({automatic:true,expectedUpdatedAt:entry.updatedAt,position:expect.objectContaining({page:2})})))
 fireEvent.click(screen.getByRole('button',{name:'显式标记读完'}));await act(async()=>{automatic.resolve({...entry,position:{page:2}});await automatic.promise})
 expect(within(screen.getByRole('region',{name:'测试阅读状态'})).getByText('done')).toBeInTheDocument()
})

it('keeps type and index status ANDed with query, folder and reading filters',async()=>{
 setup({folder:'topic'});await screen.findByRole('checkbox',{name:'选择 Paper 1'});fireEvent.change(screen.getByRole('textbox',{name:'全文搜索资料'}),{target:{value:'protein'}});fireEvent.click(screen.getByRole('button',{name:'待读'}));fireEvent.click(screen.getByRole('button',{name:'筛选与排序'}));fireEvent.change(screen.getByRole('combobox',{name:'筛选资料类型'}),{target:{value:'Guideline'}});fireEvent.change(screen.getByRole('combobox',{name:'筛选问答索引状态'}),{target:{value:'failed'}})
 await waitFor(()=>expect(api.post).toHaveBeenCalledWith('/library/query',expect.objectContaining({query:'protein',folderId:'topic',readingStatus:'unread',type:'Guideline',indexStatus:'failed',offset:0}),expect.any(AbortSignal)))
 fireEvent.click(screen.getByRole('button',{name:'重置筛选'}));await waitFor(()=>expect(api.post).toHaveBeenLastCalledWith('/library/query',expect.objectContaining({query:'',readingStatus:undefined,type:undefined,indexStatus:undefined}),expect.any(AbortSignal)))
})

it('polls an active text index despite unrelated reading page updates',async()=>{
 vi.useFakeTimers();api.post.mockImplementation(async(path:string,body:Record<string,unknown>)=>path==='/library/query'?page(Number(body.offset)||0,true):{saved:true});setup();await act(async()=>{await vi.advanceTimersByTimeAsync(20)});fireEvent.click(screen.getByRole('button',{name:/^Paper 1\b/}))
 for(let i=0;i<4;i++){await act(async()=>{await vi.advanceTimersByTimeAsync(1000)});fireEvent.click(screen.getByRole('button',{name:'显式标记读完'}))}
 await act(async()=>{await vi.advanceTimersByTimeAsync(1100)});await act(async()=>{await vi.advanceTimersByTimeAsync(1)});expect(api.post.mock.calls.filter(([path])=>path==='/library/query').length).toBeGreaterThanOrEqual(2);expect(api.get).toHaveBeenCalledTimes(1)
})

it('folder quick search reveals matching descendants with their parent and clears cleanly',()=>{
 const folders=[{id:'source',name:'ICH'},{id:'parent',name:'稳定性研究'},{id:'child',name:'加速试验',parentId:'parent'}],open=vi.fn();render(<FolderTree folders={folders} current="all" canOrganize onOpen={open} onDrop={vi.fn()}/>);fireEvent.change(screen.getByRole('searchbox',{name:'搜索论文文件夹'}),{target:{value:'加速'}})
 expect(screen.getByRole('button',{name:'稳定性研究'})).toBeInTheDocument();expect(screen.queryByRole('button',{name:'ICH'})).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'加速试验'}));expect(open).toHaveBeenCalledWith('child');fireEvent.click(screen.getByRole('button',{name:'清除文件夹搜索'}));expect(screen.getByRole('button',{name:'ICH'})).toBeInTheDocument()
})

it('does not silently truncate a drag operation above one server batch',()=>{
 const dropped=vi.fn();render(<FolderTree folders={[{id:'target',name:'目标'}]} current="all" canOrganize onOpen={vi.fn()} onDrop={dropped}/>);const ids=Array.from({length:601},(_,i)=>`sources/paper-${i}.md`);const event=new MouseEvent('drop',{bubbles:true});Object.defineProperty(event,'dataTransfer',{value:{getData:()=>JSON.stringify(ids),types:['application/x-knowledge-papers']}});fireEvent(screen.getByRole('button',{name:'目标'}),event);expect(dropped).toHaveBeenCalledWith('target',ids,false)
})
