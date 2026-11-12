import { act,fireEvent,render,screen,waitFor,within } from '@testing-library/react'
import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest'
import SolutionsApp from './SolutionsApp'
import {createDemoClient} from './demo'
import {createPreviewNotesClient} from '../notes/client'
beforeEach(()=>{localStorage.clear();sessionStorage.clear();localStorage.setItem('ks-editor-mode','markdown')})
afterEach(()=>vi.restoreAllMocks())
async function mount(home=false){const client=createDemoClient('upgrade','author','作者'),notes=createPreviewNotesClient('upgrade');render(<SolutionsApp client={client} notesClient={notes} userId="author" userName="作者" preview initialHome={home}/>);if(!home)await screen.findByRole('textbox',{name:'章节正文'});else await screen.findByRole('button',{name:'缓冲体系选择与验证报告'});return {client,notes}}
describe('report upgrade workflows',()=>{
 it('replaces a selected passage only after confirming and undo restores the original',async()=>{
  await mount();const body=screen.getByRole('textbox',{name:'章节正文'}) as HTMLTextAreaElement
  fireEvent.change(body,{target:{value:'前面原文后面'}});body.focus();body.setSelectionRange(2,4);fireEvent.select(body)
  fireEvent.change(screen.getByRole('textbox',{name:'向AI提问'}),{target:{value:'解释研究条件'}});fireEvent.click(screen.getByRole('button',{name:'发送问题'}));await screen.findByRole('button',{name:'插入报告'})
  fireEvent.click(screen.getByRole('button',{name:'插入报告'}));const dialog=screen.getByRole('dialog',{name:/确认采纳/})
  fireEvent.change(within(dialog).getByRole('combobox',{name:'插入位置'}),{target:{value:'replace'}})
  fireEvent.change(within(dialog).getByRole('textbox',{name:'确认或改写内容'}),{target:{value:'已确认的新解释'}})
  expect(body.value).toBe('前面原文后面');fireEvent.click(within(dialog).getByRole('button',{name:'确认插入并保留引用'}));expect(body.value).toContain('已确认的新解释');expect(body.value).not.toContain('原文')
  fireEvent.click(screen.getByRole('button',{name:'撤销插入'}));expect(body.value).toBe('前面原文后面')
 })
 it('creates a child, duplicates content and saves a reusable structure template',async()=>{
  const {client}=await mount();fireEvent.click(screen.getByRole('button',{name:'章节操作：研究目标与适用范围'}));fireEvent.click(screen.getByRole('button',{name:'添加子章节'}));expect(screen.getByRole('button',{name:'打开章节：新子章节'})).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:'保存章节模板'}));const dialog=screen.getByRole('dialog',{name:'章节模板'});fireEvent.change(within(dialog).getByRole('textbox',{name:'模板名称'}),{target:{value:'研究标准结构'}});fireEvent.click(within(dialog).getByRole('button',{name:'保存模板'}));await screen.findByText('模板已保存，新建报告时可选择。');const templates=await client.templates!();expect(templates[0].sections.some(s=>s.parentId)).toBe(true);expect(templates[0].sections.some(s=>'content' in s)).toBe(false)
  fireEvent.click(screen.getByRole('button',{name:'新建报告'}));expect(screen.getByRole('option',{name:'研究标准结构'})).toBeInTheDocument()
 })
 it('searches existing personal notes and inserts a traceable note link',async()=>{
  const {notes}=await mount();await act(async()=>{await notes.create('note-123',{title:'实验要点',content:'需要记录实验温度',sourceApp:'manual',sourceTitle:'',sourceUrl:''})})
  fireEvent.click(screen.getByRole('button',{name:'插入我的笔记'}));await screen.findByRole('button',{name:'选择此笔记'});fireEvent.click(screen.getByRole('button',{name:'选择此笔记'}));fireEvent.click(screen.getByRole('button',{name:'确认插入并保留引用'}));expect((screen.getByRole('textbox',{name:'章节正文'}) as HTMLTextAreaElement).value).toContain('/notes?note=note-123')
 })
 it('pins reports using the server client and allows list and project organization',async()=>{const {client}=await mount(true);fireEvent.click(screen.getByRole('button',{name:'置顶缓冲体系选择与验证报告'}));await screen.findByRole('button',{name:'取消置顶缓冲体系选择与验证报告'});expect((await client.list())[0].pinned).toBe(true);fireEvent.click(screen.getByRole('button',{name:'列表视图'}));expect(document.querySelector('.ks-solution-grid')).toHaveClass('is-list');fireEvent.click(screen.getByRole('checkbox',{name:'按项目分组'}));expect(document.querySelector('.ks-project-group-title')).toHaveTextContent('示例研发项目')})
 it('renames, archives and deletes a persisted conversation without changing the report', async () => {
  const { client } = await mount()
  const assistant = within(screen.getByRole('region', { name: 'AI研究助手面板' }))
  const topics = assistant.getByRole('combobox', { name: '对话主题' })
  fireEvent.change(assistant.getByRole('textbox', { name: '向AI提问' }), { target: { value: '整理研究目标' } })
  fireEvent.click(assistant.getByRole('button', { name: '发送问题' }))
  await assistant.findByRole('button', { name: '插入报告' })
  fireEvent.click(assistant.getByRole('button', { name: '管理主题' }))
  fireEvent.change(assistant.getByRole('textbox', { name: '主题名称' }), { target: { value: '主题一' } })
  fireEvent.click(assistant.getByRole('button', { name: '保存名称' }))
  await waitFor(() => expect(topics).toHaveTextContent('主题一'))
  const topic = (await client.topics!('demo-solution'))[0]
  expect(topic.title).toBe('主题一')
  fireEvent.click(assistant.getByRole('button', { name: '管理主题' }))
  fireEvent.click(assistant.getByRole('button', { name: '归档主题' }))
  await waitFor(() => expect(topics).toHaveTextContent('[归档]'))
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  fireEvent.click(assistant.getByRole('button', { name: '管理主题' }))
  fireEvent.click(assistant.getByRole('button', { name: '删除主题' }))
  await waitFor(() => expect(assistant.queryByRole('button', { name: '插入报告' })).not.toBeInTheDocument())
  expect(await client.history('demo-solution')).toEqual([])
  expect((await client.get('demo-solution')).sections).toHaveLength(7)
 })
 it('stops waiting without losing the question or adopting a late answer',async()=>{const {client}=await mount();let complete!:(value:Awaited<ReturnType<typeof client.ask>>)=>void;const spy=vi.spyOn(client,'ask').mockImplementation(()=>new Promise(resolve=>{complete=resolve}));fireEvent.change(screen.getByRole('textbox',{name:'向AI提问'}),{target:{value:'尚未回答的问题'}});fireEvent.click(screen.getByRole('button',{name:'发送问题'}));await waitFor(()=>expect(spy).toHaveBeenCalled());fireEvent.click(screen.getByRole('button',{name:'停止生成'}));expect(spy.mock.calls[0][2]?.aborted).toBe(true);expect(screen.getByRole('textbox',{name:'向AI提问'})).toHaveValue('尚未回答的问题');await act(async()=>complete({id:'late',question:'尚未回答的问题',content:'迟到回答',references:[],context:'',scope:'',createdAt:new Date().toISOString(),mode:'ai'}));expect(screen.queryByText('迟到回答')).not.toBeInTheDocument()})

 it('uses the new revision after saving a named version and supports restoring one chapter', async () => {
  const { client } = await mount()
  const editor = within(screen.getByRole('region', { name: '撰写报告' }))
  const body = editor.getByRole('textbox', { name: '章节正文' }) as HTMLTextAreaElement
  const before = body.value
  const history = screen.getByRole('button', { name: '历史版本' })
  fireEvent.click(history)
  const versionDialog = within(await screen.findByRole('dialog', { name: '历史版本与评审记录' }))
  fireEvent.change(versionDialog.getByRole('textbox', { name: '版本名称' }), { target: { value: '已核对版本' } })
  fireEvent.click(versionDialog.getByRole('button', { name: '保存当前版本' }))
  await versionDialog.findByRole('button', { name: /已核对版本/ })
  fireEvent.click(versionDialog.getByRole('button', { name: '关闭弹窗' }))
  fireEvent.change(body, { target: { value: '替换后的内容' } })
  fireEvent.click(history)
  const restoreDialog = within(await screen.findByRole('dialog', { name: '历史版本与评审记录' }))
  await restoreDialog.findByRole('textbox', { name: '版本名称' })
  fireEvent.click(restoreDialog.getAllByRole('button', { name: '恢复此章节' })[0])
  fireEvent.click(restoreDialog.getByRole('button', { name: '确认恢复' }))
  await waitFor(() => expect((editor.getByRole('textbox', { name: '章节正文' }) as HTMLTextAreaElement).value).toBe(before))
  expect((await client.get('demo-solution')).sections[0].content).toBe(before)
 })

 it('does not overwrite typing when a late pin save returns',async()=>{const {client}=await mount();const original=client.save;let finish!:()=>void;vi.spyOn(client,'save').mockImplementationOnce((id,input)=>new Promise(resolve=>{finish=()=>{void original(id,input).then(resolve)}}));fireEvent.click(screen.getByRole('button',{name:'研究报告主页'}));await screen.findByRole('button',{name:'置顶缓冲体系选择与验证报告'});fireEvent.click(screen.getByRole('button',{name:'置顶缓冲体系选择与验证报告'}));await waitFor(()=>expect(finish).toBeDefined());fireEvent.click(screen.getByRole('button',{name:'缓冲体系选择与验证报告'}));const body=await screen.findByRole('textbox',{name:'章节正文'});fireEvent.change(body,{target:{value:'置顶等待期间继续撰写'}});await act(async()=>finish());expect(body).toHaveValue('置顶等待期间继续撰写')})

})
