import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import InformationApp from './InformationApp'

const namespace = 'a'.repeat(64)
beforeEach(() => {
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', { get length() { return data.size }, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, String(value)) }, removeItem: (key: string) => data.delete(key), clear: () => data.clear(), key: (index: number) => [...data.keys()][index] ?? null })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
function mount(path = '/information', options: { namespace?: string; preview?: boolean } = { namespace, preview: true }) {
  return render(<MemoryRouter initialEntries={[path]}><Routes><Route element={<Outlet context={{ user: { id: 'real-user', username: 'li.admin', displayName: '李总管' }, identityNamespace: options.namespace, applications: [], preview: options.preview ?? true, logout: vi.fn(), refresh: vi.fn() }} />}><Route path="/information/*" element={<InformationApp />} /></Route></Routes></MemoryRouter>)
}

test('新应用匹配四分类来源布局，实际账号与明确演示标识始终可见', () => {
  mount()
  expect(screen.getByRole('heading', { name: 'ICH 官方指导原则' })).toBeInTheDocument()
  expect(screen.getByText('李总管')).toBeInTheDocument()
  expect(screen.queryByText('开发账户')).not.toBeInTheDocument()
  expect(screen.getByText('界面体验 · 演示数据')).toBeInTheDocument()
  expect(screen.getByText(/真实采集、知识库同步和 AI 尚未接入/)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: '应用工作台' })).toHaveAttribute('href', '/?preview=1')
  for (const name of ['Q 质量','S 安全性','E 有效性','M 多学科']) expect(screen.getByRole('heading', { name })).toBeInTheDocument()
  expect(screen.getByText(/M 类目录检查超时，不能判断是否有更新/)).toBeInTheDocument()
})

test('界面操作不请求采集、知识库或 AI，预览可体验但不持久化', async () => {
  const fetch = vi.spyOn(window, 'fetch')
  mount('/information?preview=1', { preview: true })
  await userEvent.click(screen.getByRole('button', { name: '检查更新' }))
  expect(screen.getByRole('status')).toHaveTextContent('演示：')
  await userEvent.click(screen.getByRole('link', { name: '我的关注' }))
  await userEvent.click(screen.getByRole('checkbox', { name: '关注 Q 质量' }))
  expect(fetch).not.toHaveBeenCalled()
  expect(window.localStorage.length).toBe(0)
})

test('未知来源在本机登记为待适配，不能伪造监控启用或进行采集', async () => {
  mount()
  await userEvent.click(screen.getByRole('button', { name: '添加来源' }))
  const dialog = screen.getByRole('dialog', { name: '添加信息源' })
  await userEvent.type(within(dialog).getByLabelText('来源名称'), '监管来源')
  await userEvent.type(within(dialog).getByLabelText('官方网站地址'), 'https://example.org')
  await userEvent.click(within(dialog).getByRole('button', { name: '保存来源' }))
  expect(screen.getByRole('heading', { name: '监管来源' })).toBeInTheDocument()
  expect(screen.getByText('等待来源适配')).toBeInTheDocument()
  expect(screen.getAllByRole('button', { name: '开启监控' }).at(-1)).toBeDisabled()
  expect(screen.getByRole('status')).toHaveTextContent('未操作真实服务')
})

test('情报可搜索筛选、标记已读并撤销、加入稍后看', async () => {
  mount('/information/inbox')
  await userEvent.click(screen.getByRole('button', { name: '标记已读' }))
  expect(screen.getByRole('button', { name: '标记未读' })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '撤销' }))
  expect(screen.getByRole('button', { name: '标记已读' })).toBeInTheDocument()
  await userEvent.click(screen.getAllByRole('button', { name: '稍后看' }).at(-1)!)
  await userEvent.click(screen.getByRole('button', { name: '稍后看', pressed: false }))
  expect(within(screen.getByRole('region', { name: '情报列表' })).getAllByRole('button')).toHaveLength(1)
  await userEvent.type(screen.getByRole('textbox', { name: '搜索情报' }), '不存在')
  expect(screen.getByText('没有匹配的情报')).toBeInTheDocument()
})

test('选择新文件夹和文件后才创建演示收录任务，可暂停并保留进度', async () => {
  mount('/information/import')
  await userEvent.selectOptions(screen.getByLabelText('知识库文件夹'), 'new-folder')
  await userEvent.type(screen.getByLabelText('新文件夹名称'), '法规资料')
  await userEvent.click(screen.getByRole('button', { name: '预览收录清单' }))
  expect(screen.getByRole('button', { name: '开始批量收录' })).toBeDisabled()
  await userEvent.click(screen.getByRole('checkbox', { name: /收录 M9/ }))
  await userEvent.click(screen.getByRole('button', { name: '开始批量收录' }))
  expect(screen.getByRole('status')).toHaveTextContent('演示：收录任务已创建')
  await userEvent.click(screen.getByRole('button', { name: '暂停收录' }))
  expect(screen.getByText('已暂停')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: /法规资料/ })).toHaveAttribute('href', expect.stringContaining('folder='))
})

test('登录身份隔离演示状态，缺少验证命名空间时只使用内存', async () => {
  const first = mount('/information/following')
  await userEvent.click(screen.getByRole('checkbox', { name: '关注 Q 质量' }))
  expect(screen.getByRole('checkbox', { name: '关注 Q 质量' })).toBeChecked()
  first.unmount()
  const other = mount('/information/following', { namespace: 'b'.repeat(64) })
  expect(screen.getByRole('checkbox', { name: '关注 Q 质量' })).not.toBeChecked()
  other.unmount()
  window.localStorage.clear()
  mount('/information/following', {})
  await userEvent.click(screen.getByRole('checkbox', { name: '关注 Q 质量' }))
  expect(window.localStorage.length).toBe(0)
})

test('资料按目标文件夹筛选，版本与问答仅提供明确示例', async () => {
  mount('/information/library?folder=ich-folder')
  expect(within(screen.getByRole('region', { name: '知识资料列表' })).getAllByRole('button')).toHaveLength(6)
  await userEvent.click(screen.getByRole('tab', { name: '版本变化' }))
  expect(screen.getByText('版本对比 · 演示文本')).toBeInTheDocument()
  await userEvent.type(screen.getByLabelText('围绕这份资料提问'), '这次更新有什么变化？')
  await userEvent.click(screen.getByRole('button', { name: '查看问答示例' }))
  expect(screen.getByText('固定演示回答')).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: /下载/ })).not.toBeInTheDocument()
})

test('个人笔记提醒与来源监控独立，费用测算不请求当前价格或生成实际账单', async () => {
  mount('/information/following')
  await userEvent.selectOptions(screen.getByLabelText('提醒节奏'), '暂停提醒')
  await userEvent.clear(screen.getByLabelText('我的研究笔记'))
  await userEvent.type(screen.getByLabelText('我的研究笔记'), '个人研究记录')
  await userEvent.click(screen.getByRole('button', { name: '保存笔记' }))
  expect(screen.getByLabelText('我的研究笔记')).toHaveValue('个人研究记录')
  await userEvent.click(screen.getByRole('link', { name: /运行与费用/ }))
  expect(screen.getByText('未调用真实模型，无实际费用账单。')).toBeInTheDocument()
  const price = screen.getByLabelText('输入单价（元 / 百万 Token）')
  await userEvent.clear(price)
  await userEvent.type(price, '10')
  expect(screen.getByText(/可修改的示例参数/)).toBeInTheDocument()
})

test('重置演示恢复最初数据', async () => {
  mount('/information/following')
  await userEvent.click(screen.getByRole('checkbox', { name: '关注 Q 质量' }))
  expect(screen.getByRole('checkbox', { name: '关注 Q 质量' })).toBeChecked()
  await userEvent.click(screen.getByRole('button', { name: '重置演示数据' }))
  expect(window.localStorage.length).toBe(0)
})

test.each(['toString','constructor','__proto__'])('未知继承属性路由安全回退到来源页：%s', route => {
  mount(`/information/${route}`)
  expect(screen.getByRole('heading', { name: '信息源', level: 1 })).toBeInTheDocument()
})

test('示例解析重试同步资料详情并保留已保存版本', async () => {
  mount('/information/library')
  await userEvent.click(screen.getByRole('button', { name: /M4 · 通用技术文件/ }))
  expect(screen.getByRole('button', { name: '重试解析 · 演示' })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '重试解析 · 演示' }))
  expect(screen.queryByRole('button', { name: '重试解析 · 演示' })).not.toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('解析重试任务已提交')
  expect(screen.getAllByText(/演示采集版/)).toHaveLength(2)
})

test('顶栏显示当前账号、我的设置及主题切换，不显示退出登录', () => {
  mount('/information/sources?preview=1')
  const header = within(screen.getByRole('banner'))
  expect(header.getByText('李总管')).toBeInTheDocument()
  expect(header.getByRole('link', { name: '李总管 · 我的设置' })).toHaveAttribute('href', '/settings?preview=1')
  expect(header.queryByRole('button', { name: '退出登录' })).not.toBeInTheDocument()
  expect(header.getByRole('button', { name: '切换主题' })).toBeEnabled()
})

test('来源弹窗支持键盘编辑，关闭后焦点返回添加入口', async () => {
  mount()
  const trigger = screen.getByRole('button', { name: '添加来源' })
  await userEvent.click(trigger)
  const dialog = screen.getByRole('dialog', { name: '添加信息源' })
  const name = within(dialog).getByRole('textbox', { name: '来源名称' })
  expect(name).toHaveFocus()
  await userEvent.type(name, '我的监管来源')
  expect(name).toHaveFocus()
  expect(name).toHaveValue('我的监管来源')
  await userEvent.keyboard('{Escape}')
  expect(screen.queryByRole('dialog', { name: '添加信息源' })).not.toBeInTheDocument()
  expect(trigger).toHaveFocus()
})
