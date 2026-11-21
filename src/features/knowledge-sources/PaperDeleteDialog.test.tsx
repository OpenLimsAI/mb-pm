import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import PaperDeleteDialog from './PaperDeleteDialog'
import type { SourceFolder, SourcePaper } from './api'
const api=vi.hoisted(()=>({get:vi.fn(),post:vi.fn()}))
vi.mock('./v3-api',()=>({knowledgeV3Get:api.get,knowledgeV3Post:api.post}))
const paper:SourcePaper={id:'sources/a.md',title:'Test paper',folderIds:['a','b'],saved:true,indexStatus:'ready'}
const folders: SourceFolder[] = [
  { id: 'a', name: '分析方法与质量表征' },
  { id: 'b', name: 'ICH' },
  { id: 'c', name: '待整理' },
]
const plan={planId:'plan-1',path:paper.id,title:paper.title,expiresAt:'2030-01-01T00:00:00Z',pages:[],sharedCount:2,unverifiedCount:1}
beforeEach(()=>{localStorage.clear();api.get.mockReset();api.post.mockReset();api.post.mockResolvedValue(plan)})
it('only previews until explicit confirmation and only completes on confirmed server success',async()=>{
 const done=vi.fn();render(<PaperDeleteDialog paper={paper} folders={folders} storageKey="user" onClose={vi.fn()} onDeleted={done}/>)
 const confirm=await screen.findByRole('button',{name:'确认删除文件'});await waitFor(()=>expect(confirm).toBeEnabled())
 expect(api.post).toHaveBeenCalledExactlyOnceWith('/library/delete-preview',{paperId:paper.id},expect.any(AbortSignal))
 const dialog = screen.getByRole('dialog', { name: '从知识库删除文件' })
 expect(dialog).toHaveAccessibleDescription('将从整个知识库删除此文件，所有文件夹都将不再显示。')
 const affectedFolders = within(dialog).getByRole('list', { name: '受影响的文件夹（当前可见）' })
 expect(within(affectedFolders).getAllByRole('listitem').map(item => item.textContent)).toEqual(['分析方法与质量表征', 'ICH'])
 expect(done).not.toHaveBeenCalled()
 api.post.mockResolvedValue({operationId:plan.planId,path:paper.id,status:'succeeded',completed:1,total:1})
 fireEvent.click(confirm);await waitFor(()=>expect(done).toHaveBeenCalledTimes(1))
 expect(api.post).toHaveBeenLastCalledWith('/library/delete',{paperId:paper.id,planId:plan.planId},expect.any(AbortSignal))
 expect(localStorage.getItem('user:delete:'+paper.id)).toBeNull()
})
it('keeps uncertain operation receipts and resumes by querying instead of deleting twice',async()=>{
 api.post.mockImplementation(async(path:string)=>{if(path.endsWith('delete-preview'))return plan;throw new Error('network')})
 const view=render(<PaperDeleteDialog paper={paper} folders={folders} storageKey="user" onClose={vi.fn()} onDeleted={vi.fn()}/>);await waitFor(()=>expect(screen.getByRole('button',{name:'确认删除文件'})).toBeEnabled())
 fireEvent.click(screen.getByRole('button',{name:'确认删除文件'}));await screen.findByRole('alert')
 expect(screen.queryByRole('button',{name:'确认删除文件'})).not.toBeInTheDocument();expect(localStorage.getItem('user:delete:'+paper.id)).not.toBeNull()
 view.unmount();api.post.mockClear();api.get.mockResolvedValue({operationId:plan.planId,path:paper.id,status:'running',completed:0,total:1})
 render(<PaperDeleteDialog paper={paper} folders={folders} storageKey="user" onClose={vi.fn()} onDeleted={vi.fn()}/>);await waitFor(()=>expect(api.get).toHaveBeenCalledWith('/library/delete-status?operationId=plan-1',expect.any(AbortSignal)))
 expect(api.post).not.toHaveBeenCalled()
})
it('does not offer fake whole-library deletion for an unregistered archive',async()=>{
 render(<PaperDeleteDialog paper={{...paper,id:'archive:v1'}} folders={folders} storageKey="user" onClose={vi.fn()} onDeleted={vi.fn()}/>);expect(await screen.findByRole('alert')).toHaveTextContent('尚未登记');expect(api.post).not.toHaveBeenCalled()
})
it('previews and confirms deletion of a pending PDF using its archive ID', async () => {
 const original = { ...paper, id: 'archive:' + 'a'.repeat(64), indexStatus: 'not_requested' as const }
 const done = vi.fn()
 api.post.mockResolvedValue({ ...plan, path: original.id, scope: 'original' })
 render(<PaperDeleteDialog paper={original} folders={folders} storageKey="user" onClose={vi.fn()} onDeleted={done}/>)
 const confirm = await screen.findByRole('button', { name: '确认删除原件' })
 expect(api.post).toHaveBeenCalledExactlyOnceWith('/library/delete-preview', { paperId: original.id }, expect.any(AbortSignal))
 expect(done).not.toHaveBeenCalled()
 api.post.mockResolvedValue({ operationId: plan.planId, path: original.id, status: 'succeeded', completed: 1, total: 1 })
 fireEvent.click(confirm)
 await waitFor(() => expect(done).toHaveBeenCalledOnce())
 expect(api.post).toHaveBeenLastCalledWith('/library/delete', { paperId: original.id, planId: plan.planId }, expect.any(AbortSignal))
})
it('continues a confirmed failed deletion with the same plan instead of creating a new one',async()=>{
 localStorage.setItem('user:delete:'+paper.id,JSON.stringify({plan,submitted:true}))
 api.get.mockResolvedValue({operationId:plan.planId,path:paper.id,status:'failed',completed:0,total:1,message:'temporary interruption'})
 const done=vi.fn();render(<PaperDeleteDialog paper={paper} folders={folders} storageKey="user" onClose={vi.fn()} onDeleted={done}/>)
 const retry=await screen.findByRole('button',{name:'继续删除'});api.post.mockResolvedValue({operationId:plan.planId,path:paper.id,status:'succeeded',completed:1,total:1})
 fireEvent.click(retry);await waitFor(()=>expect(done).toHaveBeenCalledTimes(1))
 expect(api.post).toHaveBeenCalledExactlyOnceWith('/library/delete',{paperId:paper.id,planId:plan.planId},expect.any(AbortSignal))
})
it('re-previews an explicitly expired plan while keeping generic conflicts recoverable',async()=>{
 const {AxiosError}=await import('axios')
 api.post.mockImplementation(async(path:string)=>{if(path.endsWith('delete-preview'))return plan;throw new AxiosError('expired','ERR_BAD_REQUEST',undefined,undefined,{status:409,data:{detail:{code:'paper_delete_plan_expired'}},headers:{},config:{} as never,statusText:'Conflict'})})
 render(<PaperDeleteDialog paper={paper} folders={folders} storageKey="user" onClose={vi.fn()} onDeleted={vi.fn()}/>);await waitFor(()=>expect(screen.getByRole('button',{name:'确认删除文件'})).toBeEnabled())
 fireEvent.click(screen.getByRole('button',{name:'确认删除文件'}));await screen.findByText('删除确认已过期，请重新检查后确认。')
 expect(localStorage.getItem('user:delete:'+paper.id)).toBeNull();expect(screen.getByRole('button',{name:'重新检查'})).toBeEnabled()
})

it('retries only the same saved confirmation when status confirms no started operation',async()=>{
 const {AxiosError}=await import('axios')
 localStorage.setItem('user:delete:'+paper.id,JSON.stringify({plan,submitted:true}))
 api.get.mockRejectedValue(new AxiosError('not started','ERR_BAD_REQUEST',undefined,undefined,{status:404,data:{detail:'删除任务不存在'},headers:{},config:{} as never,statusText:'Not Found'}))
 const done=vi.fn();render(<PaperDeleteDialog paper={paper} folders={folders} storageKey="user" onClose={vi.fn()} onDeleted={done}/>)
 const retry=await screen.findByRole('button',{name:'重试确认删除'})
 expect(api.post).not.toHaveBeenCalled()
 expect(JSON.parse(localStorage.getItem('user:delete:'+paper.id)!).plan.planId).toBe(plan.planId)
 api.post.mockResolvedValue({operationId:plan.planId,path:paper.id,status:'succeeded',completed:1,total:1})
 fireEvent.click(retry);await waitFor(()=>expect(done).toHaveBeenCalledOnce())
 expect(api.post).toHaveBeenCalledExactlyOnceWith('/library/delete',{paperId:paper.id,planId:plan.planId},expect.any(AbortSignal))
 expect(localStorage.getItem('user:delete:'+paper.id)).toBeNull()
})
it.each([403,503])('does not infer an unstarted operation from status %s',async(status)=>{
 const {AxiosError}=await import('axios')
 localStorage.setItem('user:delete:'+paper.id,JSON.stringify({plan,submitted:true}))
 api.get.mockRejectedValue(new AxiosError('unavailable','ERR_BAD_REQUEST',undefined,undefined,{status,data:{detail:'暂时无法查询'},headers:{},config:{} as never,statusText:'Error'}))
 render(<PaperDeleteDialog paper={paper} folders={folders} storageKey="user" onClose={vi.fn()} onDeleted={vi.fn()}/>)
 await screen.findByRole('alert')
 expect(screen.queryByRole('button',{name:'重试确认删除'})).not.toBeInTheDocument()
 expect(api.post).not.toHaveBeenCalled()
 expect(localStorage.getItem('user:delete:'+paper.id)).not.toBeNull()
})
it('can refresh an explicitly expired saved plan after a safe same-plan retry',async()=>{
 const {AxiosError}=await import('axios')
 localStorage.setItem('user:delete:'+paper.id,JSON.stringify({plan,submitted:true}))
 api.get.mockRejectedValue(new AxiosError('missing','ERR_BAD_REQUEST',undefined,undefined,{status:404,data:{detail:'删除任务不存在'},headers:{},config:{} as never,statusText:'Not Found'}))
 api.post.mockRejectedValue(new AxiosError('expired','ERR_BAD_REQUEST',undefined,undefined,{status:409,data:{detail:{code:'paper_delete_plan_expired'}},headers:{},config:{} as never,statusText:'Conflict'}))
 render(<PaperDeleteDialog paper={paper} folders={folders} storageKey="user" onClose={vi.fn()} onDeleted={vi.fn()}/>)
 fireEvent.click(await screen.findByRole('button',{name:'重试确认删除'}))
 await screen.findByText('删除确认已过期，请重新检查后确认。')
 expect(localStorage.getItem('user:delete:'+paper.id)).toBeNull()
 expect(screen.getByRole('button',{name:'重新检查'})).toBeEnabled()
 expect(api.post).toHaveBeenCalledExactlyOnceWith('/library/delete',{paperId:paper.id,planId:plan.planId},expect.any(AbortSignal))
})
