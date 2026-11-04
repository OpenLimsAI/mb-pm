import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AcquisitionWorkspace from './AcquisitionWorkspace'
import SourceWatchPanel, { VersionChangePanel } from './SourceWatchPanel'

const api=vi.hoisted(()=>({get:vi.fn(),post:vi.fn(),upload:vi.fn()}))
vi.mock('./v3-api',()=>({knowledgeV3Get:api.get,knowledgeV3Post:api.post,knowledgeV3Upload:api.upload}))
const templates=[{id:'pubmed',name:'PubMed 文献',url:'https://pubmed.ncbi.nlm.nih.gov/',capabilities:['PMID 元数据'],coverage:'元数据不是免费 PDF'}]
const folders=[{id:'topic',name:'稳定性研究'}]
const imported={items:[{documentId:'doc',title:'Study',alreadyImported:false}],jobs:[],errors:[],downloadRequested:false,indexRequested:false}
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
  const {container}=render(<AcquisitionWorkspace folders={folders} canManage/>);fireEvent.click(screen.getByRole('tab',{name:'上传 PDF'}))
  const input=container.querySelector('input[type=file]')!;const file=new File(['%PDF-1.7'],'study.pdf',{type:'application/pdf'});fireEvent.change(input,{target:{files:[file]}})
  fireEvent.change(screen.getByLabelText('收录目标文件夹'),{target:{value:'topic'}});fireEvent.click(screen.getByRole('button',{name:'上传 1 份 PDF'}))
  await waitFor(()=>expect(api.upload).toHaveBeenCalledOnce());const [path,body]=api.upload.mock.calls[0] as [string,FormData]
  expect(path).toBe('/upload');expect(body.get('file')).toBe(file);expect(body.get('folderId')).toBe('topic');expect(body.get('parse')).toBe('false')
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
