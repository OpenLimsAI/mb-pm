import { fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '../../test/setup'
import { AccountDialog, CreateAccountDialog, CredentialDialog, type AccountTab } from './AccountDialogs'
import type { Account } from '../../api/accounts'

const account = {
  id: 'subject-1', username: 'zhang.ming', displayName: '张明', email: '', createdAt: '',
  enabled: true, mustChangePassword: false, orgAdmin: false, isSelf: false,
  identity: 'lead', platformAdmin: false, pmIdentity: 'lead', pmEffectiveRole: 'cmc_lead',
  kbRole: 'editor', kbEnabled: true, kbRoles: ['kb_editor'], pmRoles: ['cmc_lead'], otherRoles: [],
  pmMember: { id: 'member-1', username: 'zhang.ming', active: true, bound: true, specialtyGroup: '分析', weeklyHours: 40 },
} as Account

test('平台身份独立设置，知识库只能选择可编辑', () => {
  render(<AccountDialog account={account} available={['admin', 'cmc_lead', 'kb_editor']} onClose={vi.fn()} onSaved={vi.fn()} onPasswordReset={vi.fn()} />)
  const platform = screen.getByRole('group', { name: '平台管理身份' })
  expect(within(platform).getByRole('radio', { name: /系统管理员/ })).toBeEnabled()
  const pm = screen.getByRole('group', { name: '项目管理' })
  expect(within(pm).queryByRole('radio', { name: /系统管理员/ })).not.toBeInTheDocument()
  const kb = screen.getByRole('group', { name: '知识库' })
  expect(within(kb).getByRole('radio', { name: /仅阅读/ })).toBeDisabled()
  expect(within(kb).getByRole('radio', { name: /可编辑/ })).toBeChecked()
})

test('只提交明确选择的知识库编辑权限', async () => {
  const saved = vi.fn()
  let submitted: unknown
  server.use(http.patch('http://localhost:5175/api/v1/portal/accounts/subject-1', async ({ request }) => {
    submitted = await request.json()
    return new HttpResponse(null, { status: 204 })
  }))
  render(<AccountDialog account={{ ...account, kbRole: 'viewer', kbRoles: ['kb_viewer'] }} available={['admin', 'cmc_lead', 'kb_editor']} onClose={vi.fn()} onSaved={saved} onPasswordReset={vi.fn()} />)
  expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
  await userEvent.click(screen.getByRole('radio', { name: '可编辑' }))
  await userEvent.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(() => expect(saved).toHaveBeenCalled())
  expect(submitted).toEqual({ kb_role: 'editor' })
  expect(saved).toHaveBeenCalledWith(expect.stringContaining('重新登录'))
})

test('新建账号可分别选择平台身份并保留项目业务角色', async () => {
  const created = vi.fn()
  let submitted: unknown
  server.use(http.post('http://localhost:5175/api/v1/portal/accounts', async ({ request }) => {
    submitted = await request.json()
    return new HttpResponse(null, { status: 204 })
  }))
  render(<CreateAccountDialog preset={{ username: 'new.user', displayName: '新同事' }} available={['admin', 'cmc_lead', 'kb_editor']} onClose={vi.fn()} onCreated={created} />)
  await userEvent.click(screen.getByRole('radio', { name: '项目负责人' }))
  await userEvent.click(screen.getByRole('radio', { name: '系统管理员' }))
  await userEvent.click(screen.getByRole('button', { name: '自动生成' }))
  await userEvent.click(screen.getByRole('button', { name: '创建账号' }))
  await waitFor(() => expect(created).toHaveBeenCalled())
  expect(submitted).toMatchObject({ platform_admin: true, pm_identity: 'lead', kb_role: 'editor' })
  expect(submitted).not.toHaveProperty('identity')
})

function showDialog(changes: Partial<Account> = {}, initialTab: AccountTab = 'profile', available = ['admin', 'cmc_lead', 'kb_editor']) {
  const callbacks = { onClose: vi.fn(), onSaved: vi.fn(), onPasswordReset: vi.fn() }
  render(<AccountDialog account={{ ...account, ...changes }} initialTab={initialTab} available={available} {...callbacks} />)
  return callbacks
}

test.each(['viewer', 'unassigned'] as const)('仅修改公共资料不升级知识库 %s 账号', async (kbRole) => {
  let body: unknown
  server.use(http.patch('*/portal/accounts/subject-1', async ({ request }) => { body = await request.json(); return new HttpResponse(null, { status: 204 }) }))
  const { onSaved } = showDialog({ kbRole, pmMember: null })
  await userEvent.clear(screen.getByLabelText(/姓名/))
  await userEvent.type(screen.getByLabelText(/姓名/), '新姓名')
  await userEvent.type(screen.getByLabelText(/邮箱/), 'new@example.com')
  await userEvent.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  expect(body).toEqual({ display_name: '新姓名', email: 'new@example.com' })
})

test('平台身份提升独立提交并锁定继承的 PM 角色', async () => {
  let body: unknown
  server.use(http.patch('*/portal/accounts/subject-1', async ({ request }) => { body = await request.json(); return new HttpResponse(null, { status: 204 }) }))
  const { onSaved } = showDialog()
  await userEvent.click(screen.getByRole('radio', { name: '系统管理员' }))
  expect(screen.getByRole('radio', { name: '员工' })).toBeDisabled()
  expect(screen.getByRole('radio', { name: '项目负责人' })).toBeChecked()
  await userEvent.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  expect(body).toEqual({ platform_admin: true })
})

test('取消其他人的管理员身份提示回落范围并可调整业务角色', async () => {
  let body: unknown
  server.use(http.patch('*/portal/accounts/subject-1', async ({ request }) => { body = await request.json(); return new HttpResponse(null, { status: 204 }) }))
  const { onSaved } = showDialog({ platformAdmin: true, pmEffectiveRole: 'admin' })
  await userEvent.click(screen.getByRole('radio', { name: '普通成员' }))
  expect(screen.getByText('取消管理员后，项目管理回落为项目负责人。')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('radio', { name: '员工' }))
  await userEvent.selectOptions(screen.getByRole('combobox'), '')
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '32' } })
  await userEvent.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  expect(body).toEqual({ platform_admin: false, pm_identity: 'staff', specialty_group: '', weekly_hours: 32 })
})

test('项目负责人选择明确全部项目范围，并保留失败草稿', async () => {
  server.use(http.patch('*/portal/accounts/subject-1', () => HttpResponse.json({ detail: 'IAM 暂不可用' }, { status: 503 })))
  showDialog({ pmIdentity: 'staff', pmEffectiveRole: 'qa_qc', pmRoles: ['qa_qc'] })
  expect(screen.getByText(/当前角色：QA\/QC/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('radio', { name: '项目负责人' }))
  await userEvent.click(screen.getByRole('button', { name: '保存' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('IAM 暂不可用')
  expect(screen.getByRole('radio', { name: '项目负责人' })).toBeChecked()
  expect(screen.getByRole('button', { name: '保存' })).toBeEnabled()
})

test('自己的平台管理员身份不可取消', () => {
  showDialog({ platformAdmin: true, isSelf: true })
  expect(screen.getByRole('radio', { name: '普通成员' })).toBeDisabled()
  expect(screen.getByText('不能取消自己的系统管理员身份。')).toBeInTheDocument()
})

test('缺少启用角色时不可新增对应授权', () => {
  showDialog({ pmIdentity: 'staff', kbRole: 'unassigned' }, 'profile', [])
  expect(screen.getByRole('radio', { name: '系统管理员' })).toBeDisabled()
  expect(screen.getByRole('radio', { name: '项目负责人' })).toBeDisabled()
  expect(screen.getByRole('radio', { name: '可编辑' })).toBeDisabled()
  expect(screen.getByText(/缺少已启用的 kb_editor/)).toBeInTheDocument()
})

test('姓名邮箱与工时校验阻止无效提交', async () => {
  showDialog()
  fireEvent.change(screen.getByLabelText(/姓名/), { target: { value: '长'.repeat(51) } })
  expect(screen.getByText('最多 50 个字')).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText(/姓名/), { target: { value: '张明' } })
  fireEvent.change(screen.getByLabelText(/邮箱/), { target: { value: 'bad-email' } })
  expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText(/邮箱/), { target: { value: 'a@example.com' } })
  for (const value of ['', '81', '-1', '1.5']) {
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value } })
    expect(screen.getByText('请输入 0–80 的整数')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
  }
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '0' } })
  expect(screen.getByRole('button', { name: '保存' })).toBeEnabled()
})

test.each([
  ['username', { orgAdmin: true }, 'IAM 组织管理员'],
  ['password', { orgAdmin: true }, 'IAM 组织管理员'],
  ['status', { orgAdmin: true }, 'IAM 组织管理员'],
  ['password', { isSelf: true }, '我的设置'],
  ['status', { isSelf: true }, '不能停用或删除自己的账号'],
] as const)('保护敏感操作 %s %j', async (tab, changes, message) => {
  const { onClose } = showDialog(changes, tab)
  expect(screen.getByText(new RegExp(message))).toBeInTheDocument()
  await userEvent.click(screen.getAllByRole('button', { name: '关闭' }).at(-1)!)
  expect(onClose).toHaveBeenCalled()
})

test('用户名修改通过独立接口保存并保留错误输入', async () => {
  let body: unknown
  server.use(http.post('*/portal/accounts/subject-1/username', async ({ request }) => { body = await request.json(); return new HttpResponse(null, { status: 204 }) }))
  const { onSaved } = showDialog({}, 'username')
  expect(screen.getByRole('button', { name: '修改用户名' })).toBeDisabled()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new.name' } })
  await userEvent.click(screen.getByRole('button', { name: '修改用户名' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  expect(body).toEqual({ username: 'new.name' })
})

test('用户名非法或冲突时不丢失修改', async () => {
  server.use(http.post('*/portal/accounts/subject-1/username', () => HttpResponse.json({ detail: '用户名已存在' }, { status: 409 })))
  showDialog({ isSelf: true }, 'username')
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a b' } })
  expect(screen.getByRole('button', { name: '修改用户名' })).toBeDisabled()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new.name' } })
  await userEvent.click(screen.getByRole('button', { name: '修改用户名' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('用户名已存在')
  expect(screen.getByRole('textbox')).toHaveValue('new.name')
})

test('重置密码先校验两次输入，再发送新密码', async () => {
  let body: unknown
  server.use(http.post('*/portal/accounts/subject-1/password', async ({ request }) => { body = await request.json(); return new HttpResponse(null, { status: 204 }) }))
  const { onPasswordReset } = showDialog({}, 'password')
  fireEvent.change(screen.getByLabelText(/^新密码/), { target: { value: 'short' } })
  fireEvent.change(screen.getByLabelText(/^确认新密码/), { target: { value: 'different' } })
  expect(screen.getByText('两次输入的密码不一致')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '显示密码' }))
  expect(screen.getByLabelText(/^新密码/)).toHaveAttribute('type', 'text')
  await userEvent.click(screen.getByRole('button', { name: '隐藏密码' }))
  fireEvent.change(screen.getByLabelText(/^新密码/), { target: { value: 'Manual-pass2026' } })
  fireEvent.change(screen.getByLabelText(/^确认新密码/), { target: { value: 'Manual-pass2026' } })
  await userEvent.click(screen.getByRole('button', { name: '重置密码' }))
  await waitFor(() => expect(onPasswordReset).toHaveBeenCalled())
  expect(body).toEqual({ password: 'Manual-pass2026' })
})

test.each([true, false])('账号状态修改需要二次确认 enabled=%s', async (enabled) => {
  let body: unknown
  server.use(http.patch('*/portal/accounts/subject-1', async ({ request }) => { body = await request.json(); return new HttpResponse(null, { status: 204 }) }))
  const { onSaved } = showDialog({ enabled }, 'status')
  const action = enabled ? '停用' : '启用'
  await userEvent.click(screen.getByRole('button', { name: action + '账号' }))
  await userEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(body).toBeUndefined()
  await userEvent.click(screen.getByRole('button', { name: action + '账号' }))
  await userEvent.click(screen.getByRole('button', { name: '确定' + action }))
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  expect(body).toEqual({ enabled: !enabled })
})

test('删除账号须准确输入用户名，可撤销确认', async () => {
  server.use(http.delete('*/portal/accounts/subject-1', () => new HttpResponse(null, { status: 204 })))
  const { onSaved } = showDialog({ pmMember: null }, 'status')
  await userEvent.click(screen.getByRole('button', { name: '删除账号' }))
  expect(screen.getByRole('button', { name: '确定删除' })).toBeDisabled()
  await userEvent.type(screen.getByRole('textbox'), 'wrong')
  expect(screen.getByRole('button', { name: '确定删除' })).toBeDisabled()
  await userEvent.click(screen.getByRole('button', { name: '取消' }))
  await userEvent.click(screen.getByRole('button', { name: '删除账号' }))
  expect(screen.getByRole('textbox')).toHaveValue('')
  await userEvent.type(screen.getByRole('textbox'), account.username)
  await userEvent.click(screen.getByRole('button', { name: '确定删除' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith('已删除 张明 的账号。'))
})

test.each(['created', 'reset'] as const)('开通说明 %s 可复制且可关闭', async (kind) => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  const onClose = vi.fn()
  render(<CredentialDialog credentials={{ kind, displayName: '张明', username: 'zhang.ming', password: 'Temporary-pass1' }} onClose={onClose} />)
  await userEvent.click(screen.getByRole('button', { name: kind === 'created' ? '复制开通说明' : '复制重置说明' }))
  expect(await screen.findByRole('button', { name: '已复制' })).toBeInTheDocument()
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Temporary-pass1'))
  await userEvent.click(screen.getByRole('button', { name: '完成' }))
  expect(onClose).toHaveBeenCalled()
})

test('复制失败可重试，Escape 可以关闭无修改的面板', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
  const onClose = vi.fn()
  render(<CredentialDialog credentials={{ kind: 'reset', displayName: '张明', username: 'zhang.ming', password: 'Temporary-pass1' }} onClose={onClose} />)
  await userEvent.click(screen.getByRole('button', { name: '复制重置说明' }))
  expect(screen.getByRole('button', { name: '复制重置说明' })).toBeInTheDocument()
  await userEvent.keyboard('{Escape}')
  expect(onClose).toHaveBeenCalled()
})

test('新建账号失败保留手动输入并允许重试', async () => {
  server.use(http.post('*/portal/accounts', () => HttpResponse.json({ detail: '创建失败' }, { status: 503 })))
  const onClose = vi.fn()
  render(<CreateAccountDialog available={['admin', 'cmc_lead', 'kb_editor']} onClose={onClose} onCreated={vi.fn()} />)
  fireEvent.change(screen.getByLabelText(/^姓名/), { target: { value: '李悦' } })
  fireEvent.change(screen.getByLabelText(/^用户名/), { target: { value: 'li.yue' } })
  await userEvent.click(screen.getByRole('button', { name: '自动生成' }))
  await userEvent.click(screen.getByRole('button', { name: '创建账号' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('创建失败')
  expect(screen.getByLabelText(/^姓名/)).toHaveValue('李悦')
  expect(screen.getByRole('button', { name: '创建账号' })).toBeEnabled()
  await userEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(onClose).toHaveBeenCalled()
})

test('关闭或切换页签前确认未保存修改', async () => {
  const { onClose } = showDialog()
  await userEvent.type(screen.getByLabelText(/邮箱/), 'new@example.com')
  await userEvent.click(screen.getByRole('button', { name: '关闭' }))
  expect(onClose).not.toHaveBeenCalled()
  expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '继续编辑' }))
  expect(screen.getByLabelText(/邮箱/)).toHaveValue('new@example.com')
  await userEvent.click(screen.getByRole('tab', { name: '用户名' }))
  await userEvent.click(screen.getByRole('button', { name: '放弃修改' }))
  expect(screen.getByRole('button', { name: '修改用户名' })).toBeInTheDocument()
})
