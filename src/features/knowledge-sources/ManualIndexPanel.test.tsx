import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import ManualIndexPanel from './ManualIndexPanel'
const api=vi.hoisted(()=>({get:vi.fn(),post:vi.fn()}))
vi.mock('./v3-api',()=>({knowledgeV3Get:api.get,knowledgeV3Post:api.post}))
beforeEach(()=>{api.get.mockReset();api.post.mockReset();api.get.mockResolvedValue({jobId:null,status:'not_started',indexStatus:'not_requested',canStart:true,originalSaved:true,globalIncremental:true});api.post.mockResolvedValue({jobId:'job',status:'queued',indexStatus:'not_requested',originalSaved:true,globalIncremental:true})})
it('never submits ingest by opening the panel and requires explicit whole-library confirmation',async()=>{
 render(<ManualIndexPanel paperId="archive:version" canManage/>);const start=await screen.findByRole('button',{name:'确认并开始知识库增量索引'})
 await waitFor(()=>expect(api.get).toHaveBeenCalled());expect(start).toBeDisabled();expect(api.post).not.toHaveBeenCalled()
 expect(screen.getByText(/处理知识库中所有尚待索引的资料/)).toBeInTheDocument()
 fireEvent.click(screen.getByRole('checkbox',{name:'确认处理知识库全部待索引资料'}));fireEvent.click(start)
 await waitFor(()=>expect(api.post).toHaveBeenCalledWith('/library/manual-index',{paperId:'archive:version',confirmed:true}))
 expect(await screen.findByRole('status')).toHaveTextContent('索引任务已排队，尚未完成。')
 expect(screen.queryByRole('button',{name:/取消/})).not.toBeInTheDocument()
})
it('does not offer indexing when fresh permissions reject the manager role',async()=>{
 api.get.mockResolvedValue({jobId:null,status:'not_started',indexStatus:'unknown',canStart:false,originalSaved:true,globalIncremental:true})
 render(<ManualIndexPanel paperId="archive:version" canManage/>);await screen.findByText('只有当前有效的知识库负责人可以主动发起索引。')
 expect(screen.getByRole('checkbox',{name:'确认处理知识库全部待索引资料'})).toBeDisabled();expect(api.post).not.toHaveBeenCalled()
})
it('keeps unknown and failed index outcomes distinct from an available original',async()=>{
 api.get.mockResolvedValue({jobId:'job',status:'failed',indexStatus:'failed',error:'Actual task failed',canStart:true,originalSaved:true,globalIncremental:true})
 render(<ManualIndexPanel paperId="archive:version" canManage/>);expect(await screen.findByText('Actual task failed')).toBeInTheDocument();expect(screen.getByText(/上次索引未完成，原件保留/)).toBeInTheDocument()
 expect(screen.queryByText('问答索引已确认可用。')).not.toBeInTheDocument();expect(api.post).not.toHaveBeenCalled()
})
