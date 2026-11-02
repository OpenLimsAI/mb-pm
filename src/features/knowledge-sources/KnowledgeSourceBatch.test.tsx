import {fireEvent,render,screen,waitFor,within} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {beforeEach,it,expect,vi} from 'vitest'
import KnowledgeSourceApp from './KnowledgeSourceApp'
import type {KnowledgeSourceSnapshot} from './api'
const mocks=vi.hoisted(()=>({get:vi.fn(),mutate:vi.fn()}))
vi.mock('./api',async original=>({...await original<typeof import('./api')>(),getKnowledgeSources:mocks.get,mutateKnowledgeSources:mocks.mutate}))
vi.mock('../../components/portal/context',()=>({usePortalContext:()=>({user:{id:'batch',username:'batch'},identityNamespace:'batch-user',preview:false,applications:[{id:'knowledge-sources',enabled:true}]})}))
let data:KnowledgeSourceSnapshot
beforeEach(()=>{localStorage.clear();mocks.get.mockReset();mocks.mutate.mockReset();data={papers:Array.from({length:501},(_,i)=>({id:`p${i}`,title:`论文${i}`,folderIds:[],saved:false,indexStatus:'unknown'})),folders:[{id:'f',name:'目标文件夹',kind:'topic'}],sources:[],jobs:[],documents:[],catalogRevision:1,canManage:true,canOrganize:true,starred:[],integration:{status:'ready',message:''}};mocks.get.mockImplementation(async()=>structuredClone(data))})
it('organizes 501 papers in 500 + 1 batches and undoes in reverse order with fresh revisions',async()=>{
 mocks.mutate.mockImplementation(async()=>{data.catalogRevision++;return {undoToken:`token${data.catalogRevision}`,revision:data.catalogRevision,saved:true}})
 render(<MemoryRouter><KnowledgeSourceApp/></MemoryRouter>);await screen.findByLabelText('全选当前论文');expect(screen.queryByText('论文500')).not.toBeInTheDocument();fireEvent.click(screen.getByLabelText('全选当前论文'));fireEvent.click(screen.getByLabelText('将选中的 501 篇论文放入 目标文件夹'))
 await waitFor(()=>expect(mocks.mutate).toHaveBeenCalledTimes(2));const calls=mocks.mutate.mock.calls;expect(calls[0][2].paperIds).toHaveLength(500);expect(calls[1][2].paperIds).toEqual(['p500']);expect(calls[1][2].revision).toBe(2)
 await waitFor(()=>expect(screen.getByText('撤销整理')).not.toBeDisabled());fireEvent.click(screen.getByText('撤销整理'))
 await waitFor(()=>expect(mocks.mutate).toHaveBeenCalledTimes(4));expect(mocks.mutate.mock.calls[2][2]).toEqual({token:'token3',revision:3});expect(mocks.mutate.mock.calls[3][2]).toEqual({token:'token2',revision:4});await screen.findByText('已撤销整理，原件保留。')
})
it('keeps an undo receipt after the second batch fails',async()=>{
 mocks.mutate.mockImplementationOnce(async()=>{data.catalogRevision=2;return {undoToken:'first',revision:2}}).mockRejectedValueOnce(new Error('interrupted'))
 render(<MemoryRouter><KnowledgeSourceApp/></MemoryRouter>);await screen.findByLabelText('全选当前论文');fireEvent.click(screen.getByLabelText('全选当前论文'));fireEvent.click(screen.getByLabelText('将选中的 501 篇论文放入 目标文件夹'));await waitFor(()=>expect(screen.getByRole('alert')).toBeInTheDocument());expect(screen.getByText('上次整理可撤销（1 批）')).toBeInTheDocument();expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(101)
})

it('respects explicit topic classification even when the folder is a source archive and download destination',async()=>{
 data.papers=[{id:'p',title:'已整理资料',folderIds:['f'],saved:true,indexStatus:'ready'}]
 data.sources=[{id:'ich',name:'ICH',url:'https://www.ich.org',scopes:['Q'],folderId:'f',archiveFolderId:'f',frequency:'daily',enabled:false,adapter:'ich',status:'ok',scopeStatus:{}}]
 render(<MemoryRouter><KnowledgeSourceApp/></MemoryRouter>);await screen.findByRole('button',{name:/已整理资料/});fireEvent.click(screen.getByRole('button',{name:/^待整理/}));expect(screen.queryByRole('button',{name:/已整理资料/})).not.toBeInTheDocument()
})
