import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { server } from '../test/setup'
import PortalAccounts from './PortalAccounts'
import userEvent from '@testing-library/user-event'

const member = {
  id: 'subject-1', username: 'zhang.ming', display_name: '张明', email: '', created_at: '',
  enabled: true, must_change_password: false, org_admin: false, is_self: true,
  identity: 'admin', platform_admin: true, pm_identity: 'lead', pm_effective_role: 'admin',
  kb_role: 'editor', kb_enabled: true, kb_roles: ['kb_editor'], pm_roles: ['cmc_lead'], other_roles: [],
  pm_member: null,
}

function renderAccounts(options: { preview?: boolean; enabled?: boolean } = {}) {
  const context = { user: { id: 'subject-1', username: 'zhang.ming', displayName: '张明' }, applications: [{ id: 'accounts', enabled: options.enabled !== false }], preview: options.preview ?? false, logout: vi.fn(), refresh: vi.fn() }
  return render(<MemoryRouter initialEntries={['/accounts']}><Routes><Route element={<Outlet context={context} />}><Route path="/accounts" element={<PortalAccounts />} /></Route></Routes></MemoryRouter>)
}

test('账号列表分别显示平台身份与两类应用权限', async () => {
  server.use(http.get('http://localhost:5175/api/v1/portal/accounts', () => HttpResponse.json({ accounts: [member], issues: [], roles: ['admin', 'cmc_lead', 'kb_editor'], actor: 'admin' })))
  renderAccounts()
  const table = await screen.findByRole('table')
  expect(within(table).getByRole('columnheader', { name: '平台身份' })).toBeInTheDocument()
  expect(within(table).getByRole('columnheader', { name: '项目管理' })).toBeInTheDocument()
  expect(within(table).getByRole('columnheader', { name: '知识库' })).toBeInTheDocument()
  expect(within(table).getByText('系统管理员')).toBeInTheDocument()
  expect(within(table).getByText('继承平台身份')).toBeInTheDocument()
  expect(within(table).getByText('可编辑')).toBeInTheDocument()
})

function serveAccounts(accounts: unknown[] = [member], issues: unknown[] = [], actor = 'admin') {
  server.use(http.get('*/portal/accounts', () => HttpResponse.json({ accounts, issues, roles: ['admin', 'cmc_lead', 'kb_editor'], actor })))
}

test('普通成员不可加载组织名单，界面预览不连接 IAM', async () => {
  const first = renderAccounts({ enabled: false })
  expect(screen.getByText(/组织成员与账号仅系统管理员和项目负责人/)).toBeInTheDocument()
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
  first.unmount()
  renderAccounts({ preview: true })
  expect(screen.getByText('界面预览模式不连接 IAM，请登录后使用账号管理。')).toBeInTheDocument()
})

test('搜索、状态筛选和历史角色显示各自生效', async () => {
  serveAccounts([
    member,
    { ...member, id: 'staff', username: 'li.user', display_name: '李悦', is_self: false, platform_admin: false, pm_identity: 'staff', pm_effective_role: 'production', pm_roles: ['production'], kb_role: 'viewer', enabled: false, org_admin: true, pm_member: { id: 'u2', username: 'li.user', active: false, bound: true, specialty_group: null, weekly_hours: 32 } },
    { ...member, id: 'lead', username: 'zhao.user', display_name: '赵明', is_self: false, platform_admin: false, pm_identity: 'lead', pm_effective_role: 'project_lead', pm_roles: ['project_lead'], kb_role: 'unassigned', must_change_password: true, pm_member: { id: 'u3', username: 'zhao.user', active: true, bound: true, specialty_group: '分析', weekly_hours: 40 } },
  ])
  renderAccounts()
  await screen.findByRole('table')
  expect(screen.getByText('仅阅读（历史）')).toBeInTheDocument()
  expect(screen.getByText('生产支持')).toBeInTheDocument()
  expect(screen.getByText('项目负责人（本人项目）')).toBeInTheDocument()
  expect(screen.getByText('待改初始密码')).toBeInTheDocument()
  await userEvent.type(screen.getByRole('textbox', { name: '搜索账号' }), 'LI.USER')
  expect(screen.getByText('李悦')).toBeInTheDocument()
  expect(screen.queryByText('赵明')).not.toBeInTheDocument()
  await userEvent.clear(screen.getByRole('textbox', { name: '搜索账号' }))
  await userEvent.click(screen.getByRole('tab', { name: '已停用 1' }))
  expect(screen.getByText('李悦')).toBeInTheDocument()
  expect(screen.queryByText('赵明')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('tab', { name: '全部 3' }))
  await userEvent.type(screen.getByRole('textbox', { name: '搜索账号' }), '不存在')
  expect(screen.getByText('没有符合条件的账号。')).toBeInTheDocument()
})

test('项目负责人只有查看入口', async () => {
  serveAccounts([{ ...member, platform_admin: false, pm_roles: [], pm_identity: 'staff', kb_role: 'editor', is_self: false }], [], 'lead')
  renderAccounts()
  await screen.findByRole('table')
  expect(screen.getByText('员工')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '新建账号' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /编辑 张明/ })).not.toBeInTheDocument()
})

test('名单加载失败后可刷新重试', async () => {
  server.use(http.get('*/portal/accounts', () => HttpResponse.json({ detail: '读取 IAM 失败' }, { status: 503 })))
  renderAccounts()
  expect(await screen.findByText('读取 IAM 失败')).toBeInTheDocument()
  serveAccounts()
  await userEvent.click(screen.getByRole('button', { name: '刷新' }))
  expect(await screen.findByRole('table')).toBeInTheDocument()
})

test('编辑保存后显示结果并重新读取 IAM 名单', async () => {
  serveAccounts()
  server.use(http.patch('*/portal/accounts/subject-1', () => new HttpResponse(null, { status: 204 })))
  renderAccounts()
  await userEvent.click(await screen.findByRole('button', { name: '编辑 张明' }))
  fireEvent.change(screen.getByLabelText(/邮箱/), { target: { value: 'new@example.com' } })
  await userEvent.click(screen.getByRole('button', { name: '保存' }))
  expect(await screen.findByText('已保存 张明 的修改。')).toBeInTheDocument()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test('新建账号完成后展示一次性开通说明', async () => {
  serveAccounts()
  server.use(http.post('*/portal/accounts', () => new HttpResponse(null, { status: 204 })))
  renderAccounts()
  await userEvent.click(await screen.findByRole('button', { name: '新建账号' }))
  await userEvent.click(screen.getByRole('button', { name: '取消' }))
  await userEvent.click(screen.getByRole('button', { name: '新建账号' }))
  fireEvent.change(screen.getByLabelText(/^姓名/), { target: { value: '新同事' } })
  fireEvent.change(screen.getByLabelText(/^用户名/), { target: { value: 'new.member' } })
  await userEvent.click(screen.getByRole('button', { name: '自动生成' }))
  await userEvent.click(screen.getByRole('button', { name: '创建账号' }))
  expect(await screen.findByRole('heading', { name: '账号已创建' })).toBeInTheDocument()
  expect(screen.getByText('已创建 新同事 的账号。')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '完成' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test('从列表重置密码后交接一次性密码', async () => {
  serveAccounts([{ ...member, is_self: false }])
  server.use(http.post('*/portal/accounts/subject-1/password', () => new HttpResponse(null, { status: 204 })))
  renderAccounts()
  await userEvent.click(await screen.findByRole('button', { name: '编辑 张明' }))
  await userEvent.click(screen.getByRole('tab', { name: '重置密码' }))
  await userEvent.click(screen.getByRole('button', { name: '自动生成' }))
  await userEvent.click(screen.getByRole('button', { name: '重置密码' }))
  expect(await screen.findByRole('heading', { name: '密码已重置' })).toBeInTheDocument()
  expect(screen.getByText('已重置 张明 的密码。')).toBeInTheDocument()
})

test.each([true, false])('问题修复显示处理结果 success=%s', async (success) => {
  serveAccounts([member], [{ kind: 'pm_member_inactive', account_id: member.id, member_id: null, username: member.username, display_name: member.display_name, message: '成员被停用' }])
  let complete!: () => void
  const pending = new Promise<void>((resolve) => { complete = resolve })
  server.use(http.post('*/portal/accounts/subject-1/repair', async () => {
    await pending
    return success ? new HttpResponse(null, { status: 204 }) : HttpResponse.json({ detail: '修复失败' }, { status: 503 })
  }))
  renderAccounts()
  await userEvent.click(await screen.findByRole('button', { name: '修复' }))
  expect(screen.getByRole('button', { name: '修复' })).toBeDisabled()
  complete()
  expect(await screen.findByText(success ? '已修复 张明 的账号。' : '修复失败')).toBeInTheDocument()
})

test('历史 PM 成员可预填新建账号，默认账号直接进入状态页', async () => {
  serveAccounts([member], [
    { kind: 'pm_only_member', account_id: null, member_id: 'old-1', username: 'old.member', display_name: '历史成员', message: '需要开通账号' },
    { kind: 'default_account', account_id: member.id, member_id: null, username: member.username, display_name: member.display_name, message: '默认账号' },
    { kind: 'pm_member_conflict', account_id: member.id, member_id: null, username: member.username, display_name: member.display_name, message: '成员冲突' },
    { kind: 'iam_password_flag', account_id: 'missing-subject', member_id: null, username: 'missing', display_name: '已移除', message: '过期问题' },
  ])
  renderAccounts()
  const issues = await screen.findByRole('list')
  await userEvent.click(within(issues).getByRole('button', { name: '新建账号' }))
  expect(screen.getByLabelText(/^用户名/)).toHaveValue('old.member')
  expect(screen.getByLabelText(/^姓名/)).toHaveValue('历史成员')
  await userEvent.click(screen.getByRole('button', { name: '取消' }))
  await userEvent.click(within(screen.getByRole('list')).getByRole('button', { name: '删除' }))
  expect(screen.getByRole('tab', { name: '停用 / 删除' })).toHaveAttribute('aria-selected', 'true')
  await userEvent.click(screen.getAllByRole('button', { name: '关闭' }).at(-1)!)
  await userEvent.click(within(screen.getByRole('list')).getByRole('button', { name: '修复' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByText('请联系技术支持核对')).toBeInTheDocument()
})

test('知识库待分配进入编辑流程，由管理员明确选择', async () => {
  server.use(http.get('http://localhost:5175/api/v1/portal/accounts', () => HttpResponse.json({
    accounts: [{ ...member, kb_role: 'unassigned', kb_enabled: false, kb_roles: [] }], actor: 'admin', roles: ['admin', 'cmc_lead', 'kb_editor'],
    issues: [{ kind: 'kb_missing', account_id: member.id, member_id: null, username: member.username, display_name: member.display_name, message: '知识库待分配' }],
  })))
  renderAccounts()
  await userEvent.click(await screen.findByRole('button', { name: '分配知识库编辑权限' }))
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  expect(screen.getByRole('radio', { name: '可编辑' })).not.toBeChecked()
  expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
})
