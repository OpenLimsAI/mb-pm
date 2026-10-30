import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { beforeEach, expect, test, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../test/setup'
import InformationApp from './InformationApp'
import * as informationAPI from './api'
import { demoSeed } from './demo'
import type { InformationSnapshot } from './api'
let state: InformationSnapshot
const logout = vi.fn()
beforeEach(() => {
  logout.mockClear()
  const seed=demoSeed()
  state={...seed,canManage:true,documents:[],events:[],runs:[],jobs:[],folders:[],sources:[{...seed.sources[0],enabled:false,status:'unchecked',scopeStatus:{}}],integration:{status:'ready',message:'Live fixture',kbUrl:'https://kb.example'},note:''}
  server.use(http.get('*/api/v1/information/snapshot',()=>HttpResponse.json(state)))
})
function mount(path='/information/sources') {
 return render(<MemoryRouter initialEntries={[path]}><Routes><Route element={<Outlet context={{user:{id:'actual-person',username:'actual',displayName:'Actual User'},preview:false,identityNamespace:'c'.repeat(64),logout}} />}><Route path="/information/*" element={<InformationApp/>}/></Route></Routes></MemoryRouter>)
}
test('production reads durable API state and never creates demo papers or reset controls',async()=>{
 mount();expect(await screen.findByRole('heading',{name:'ICH 官方指导原则'})).toBeInTheDocument()
 expect(screen.getByText('Actual User')).toBeInTheDocument()
 expect(screen.getByText('官方来源 · 实际采集')).toBeInTheDocument()
 expect(screen.queryByRole('button',{name:'重置演示数据'})).not.toBeInTheDocument()
 await userEvent.click(screen.getByRole('link',{name:'知识资料'}))
 expect(screen.getByText('没有符合条件的资料')).toBeInTheDocument()
})
test('a source check posts a real task request and displays the server acknowledgement',async()=>{
 const calls=vi.fn()
 server.use(http.post('*/api/v1/information/sources/ich/check',()=>{calls();return HttpResponse.json({id:'real-job'},{status:202})}))
 mount();await screen.findByRole('heading',{name:'ICH 官方指导原则'})
 await userEvent.click(screen.getByRole('button',{name:'检查更新'}))
 expect(await screen.findByRole('status')).toHaveTextContent('检查任务已提交')
 expect(calls).toHaveBeenCalledTimes(1)
 expect(state.sources[0].status).toBe('unchecked')
})
test('ordinary members can browse but have no source or retry controls',async()=>{
 const seed=demoSeed();state={...state,canManage:false,documents:[{...seed.documents[0],error:'requires recovery'}]}
 mount('/information/library');await screen.findByRole('heading',{name:seed.documents[0].title})
 expect(screen.queryByRole('button',{name:'重试解析或索引'})).not.toBeInTheDocument()
 await userEvent.click(screen.getByRole('link',{name:'信息源'}))
 expect(screen.queryByRole('button',{name:'添加来源'})).not.toBeInTheDocument()
 expect(screen.queryByRole('button',{name:'检查更新'})).not.toBeInTheDocument()
 await userEvent.click(screen.getByRole('link',{name:'批量收录'}))
 expect(screen.getByRole('heading',{name:'需要资料收录权限'})).toBeInTheDocument()
})
test('service failure remains visible and cannot fall back to demo data',async()=>{
 server.use(http.get('*/api/v1/information/snapshot',()=>HttpResponse.json({detail:'Collection service unavailable'},{status:503})))
 mount();expect(await screen.findByRole('alert')).toHaveTextContent('Collection service unavailable')
 expect(screen.queryByRole('heading',{name:'ICH 官方指导原则'})).not.toBeInTheDocument()
 expect(screen.queryByText('界面体验 · 演示数据')).not.toBeInTheDocument()
})
test('live original and comparison views use actual version endpoints, with no fixed QA answer',async()=>{
 const doc=demoSeed().documents[0];state.documents=[doc]
 server.use(http.get('*/api/v1/information/documents/:doc/versions/:version',()=>HttpResponse.json({text:'Actual original paragraph from the archived document.'})),http.get('*/api/v1/information/documents/:doc/diff',()=>HttpResponse.json({text:'- old original paragraph\n+ revised original paragraph',identical:false,truncated:false})))
 mount('/information/library');await screen.findByRole('heading',{name:doc.title})
 await userEvent.click(screen.getAllByRole('button',{name:'查看解析正文'})[0])
 expect(await screen.findByText('Actual original paragraph from the archived document.')).toBeInTheDocument()
 expect(screen.queryByRole('button',{name:'查看问答示例'})).not.toBeInTheDocument()
 await userEvent.click(screen.getByRole('tab',{name:'比较最近两版'}))
 expect(await screen.findByText(/revised original paragraph/)).toBeInTheDocument()
})
test('personal notes are written to the server and reload from the server',async()=>{
 const calls=vi.fn()
 server.use(http.post('*/api/v1/information/preferences',async({request})=>{const body=await request.json() as {note:string};state={...state,note:body.note};calls(body);return HttpResponse.json({saved:true})}))
 const first=mount('/information/following');await screen.findByLabelText('我的研究笔记')
 await userEvent.type(screen.getByLabelText('我的研究笔记'),'Persisted note')
 await userEvent.click(screen.getByRole('button',{name:'保存笔记'}))
 await waitFor(()=>expect(calls).toHaveBeenCalledWith({note:'Persisted note'}));first.unmount()
 mount('/information/following');expect(await screen.findByLabelText('我的研究笔记')).toHaveValue('Persisted note')
})

test('paused directory checks have a real resume control for managers',async()=>{
 state.runs=[{id:'paused-check',sourceId:'ich',kind:'check',status:'paused',startedAt:new Date().toISOString(),details:{jobId:'paused-check'}}]
 const resumed=vi.fn()
 server.use(http.post('*/api/v1/information/jobs/paused-check/control',async({request})=>{resumed(await request.json());return HttpResponse.json({saved:true})}))
 mount('/information/runs');await screen.findByRole('heading',{name:'来源检查记录'})
 await userEvent.click(screen.getByRole('button',{name:'继续检查'}))
 await waitFor(()=>expect(resumed).toHaveBeenCalledWith({action:'resume'}))
})

test('the unified account header offers portal settings without a logout button',async()=>{
 mount();await screen.findByRole('heading',{name:'ICH 官方指导原则'})
 expect(screen.getByRole('link',{name:'Actual User · 我的设置'})).toHaveAttribute('href','/settings')
 expect(screen.queryByRole('button',{name:'退出登录'})).not.toBeInTheDocument()
 expect(logout).not.toHaveBeenCalled()
})


test('an immediately closed information page does not start a queued initial request', async () => {
  vi.useFakeTimers()
  const read = vi.spyOn(informationAPI, 'getInformation')
  try {
    const view = mount()
    view.unmount()
    await vi.runOnlyPendingTimersAsync()
    expect(read).not.toHaveBeenCalled()
  } finally {
    read.mockRestore()
    vi.useRealTimers()
  }
})
