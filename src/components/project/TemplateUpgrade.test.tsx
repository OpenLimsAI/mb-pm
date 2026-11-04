import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Project } from '../../types'
import { TemplateUpgrade } from './TemplateUpgrade'

const api = vi.hoisted(() => ({ catalog: vi.fn(), preview: vi.fn(), apply: vi.fn(), refresh: vi.fn() }))
vi.mock('../../api/templateUpgrade', () => ({ templateUpgradeApi: api }))
vi.mock('../../store/data', () => ({ useDataStore: (selector: (s: unknown) => unknown) => selector({ mode: 'api' }) }))
vi.mock('../../data/bootstrap', () => ({ refreshAllData: api.refresh }))
const project = { id: 'p1' } as Project
beforeEach(() => {
  vi.clearAllMocks()
  api.catalog.mockResolvedValue({ templateId: 't1', templateName: '标准流程', sourceVersion: 'V1', editable: true, versions: [{ version: 'V2', summary: '新版', nodes: [], subs: [] }, { version: 'V1', summary: '原版', nodes: [], subs: [] }], mappings: [], subMappings: [], tasks: [], subProjects: [], members: [] })
  api.preview.mockResolvedValue({ fingerprint: 'a'.repeat(64), sourceVersion: 'V1', targetVersion: 'V2', unmapped: [], changes: [{ id: 'task:n1:name', nodeId: 'n1', name: '试验任务', kind: 'task', field: 'name', label: '名称', before: '旧名称', after: '新名称', blocked: null, requires: [] }, { id: 'task:n2:delete', nodeId: 'n2', name: '旧任务', kind: 'task', field: 'delete', label: 'delete', before: { name: '旧任务' }, after: null, blocked: null, requires: [] }, { id: 'task:n3:delete', nodeId: 'n3', name: '执行中任务', kind: 'task', field: 'delete', label: 'delete', before: { name: '执行中任务' }, after: null, blocked: '已开始', requires: [] }] })
})
describe('模板选择性升级', () => {
  it('默认不选删除项，按确认的差异与原因提交；冲突时保留原因并要求重预览', async () => {
    const user = userEvent.setup()
    render(<TemplateUpgrade project={project} />)
    await user.click(await screen.findByRole('button', { name: '对比并预览升级' }))
    expect(await screen.findByLabelText('选择 试验任务 名称')).toBeChecked()
    expect(screen.getByLabelText('选择 旧任务 移除')).not.toBeChecked()
    expect(screen.getByLabelText('选择 执行中任务 移除')).toBeDisabled()
    await user.type(screen.getByLabelText('模板升级原因'), '变更评审通过')
    api.apply.mockRejectedValueOnce(new Error('请重新预览'))
    await user.click(screen.getByRole('button', { name: '确认应用 1 项变更' }))
    await waitFor(() => expect(api.apply).toHaveBeenCalledWith('p1', expect.objectContaining({ selectedIds: ['task:n1:name'], reason: '变更评审通过', fingerprint: 'a'.repeat(64) })))
    expect(await screen.findByRole('status')).toHaveTextContent('请重新预览')
    expect(screen.queryByRole('button', { name: '确认应用 1 项变更' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '对比并预览升级' }))
    expect(await screen.findByLabelText('模板升级原因')).toHaveValue('变更评审通过')
  })
  it('未明确来源绑定时不能确认应用', async () => {
    api.preview.mockResolvedValueOnce({ fingerprint: 'b'.repeat(64), sourceVersion: 'V1', targetVersion: 'V2', unmapped: [{ nodeId: 'n1', name: '来源任务', kind: 'task' }], changes: [{ id: 'task:n2:add', nodeId: 'n2', name: '新增任务', kind: 'task', field: 'name', label: '名称', before: '', after: '新增', blocked: null, requires: [] }] })
    const user = userEvent.setup()
    render(<TemplateUpgrade project={project} />)
    await user.click(await screen.findByRole('button', { name: '对比并预览升级' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('来源节点未绑定')
    await user.type(screen.getByLabelText('模板升级原因'), '确认')
    expect(screen.getByRole('button', { name: '确认应用 1 项变更' })).toBeDisabled()
  })
})
