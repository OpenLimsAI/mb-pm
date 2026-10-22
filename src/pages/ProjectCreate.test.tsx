import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import ProjectCreate from './ProjectCreate'
import { createProjectBundle } from '../data/bootstrap'
import { useTemplatesStore } from '../store/templates'
import { useDataStore } from '../store/data'
import type { Template } from '../types'
import type { ProjectBundle } from '../store/projects'

vi.mock('../data/bootstrap', () => ({
  createProjectBundle: vi.fn(async (bundle: ProjectBundle) => bundle.project.id),
}))

vi.mock('../store/templates', async () => {
  const { create } = await import('zustand')
  return { useTemplatesStore: create<{ templates: Template[] }>(() => ({ templates: [] })) }
})

const template: Template = {
  id: 'test-template', name: '测试工艺模板', productType: '单抗', currentVersion: 'V1.0',
  description: '测试用任务树', isActive: true, createdBy: 'u2',
  createdAt: '2026-10-21', updatedAt: '2026-10-21',
  versions: [{
    id: 'test-version', templateId: 'test-template', versionNumber: 'V1.0',
    changeSummary: '', changeSource: 'visual_edit', modifiedBy: 'u2', modifiedAt: '2026-10-21', isCurrent: true,
    structureJson: {
      id: 'root', name: '工艺开发', children: [{
        id: 'sub', name: '上游开发', module: 'USP', children: [{
          id: 'task', taskCode: 'USP-001', name: '工艺研究', defaultDuration: 14, costBudget: 25,
        }],
      }],
    },
  }],
}

beforeEach(() => {
  vi.mocked(createProjectBundle).mockReset().mockImplementation(async (bundle) => bundle.project.id)
  useTemplatesStore.setState({ templates: [template] })
  useDataStore.setState({ mode: 'mock' })
})

function startProject() {
  render(<MemoryRouter><ProjectCreate /></MemoryRouter>)
  fireEvent.change(screen.getByPlaceholderText('CMAB00028'), { target: { value: 'BLANK-01' } })
  fireEvent.change(screen.getByPlaceholderText('如：CMAB-28 抗XX单抗'), { target: { value: '自主规划项目' } })
  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'u2' } })
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
}

test('没有模板时仍可明确选择空白项目，以零任务和独立预算创建', async () => {
  useTemplatesStore.setState({ templates: [] })
  startProject()
  expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: /空白项目/ }))
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  expect(screen.getByRole('heading', { name: '确认空白项目' })).toBeInTheDocument()
  const budget = screen.getByLabelText(/项目总预算/)
  expect(budget).toHaveValue('0')
  fireEvent.change(budget, { target: { value: '120.50' } })
  fireEvent.click(screen.getByRole('button', { name: '确认创建' }))
  expect(await screen.findByRole('heading', { name: /项目创建成功/ })).toBeInTheDocument()
  expect(createProjectBundle).toHaveBeenCalledTimes(1)
  expect(vi.mocked(createProjectBundle).mock.calls[0][0]).toMatchObject({
    project: { code: 'BLANK-01', name: '自主规划项目', ownerId: 'u2', templateId: null, templateVersion: null, progress: 0, health: 'green' },
    subProjects: [], tasks: [], dependencies: [], finance: { totalBudget: 120.5, spent: 0, committed: 0 },
  })
  expect(screen.getByText(/已创建为空白项目/)).toBeInTheDocument()
  expect(screen.getByText(/项目仅保存在本机浏览器/)).toBeInTheDocument()
})

test('从模板预览返回改选空白项目，不带入旧任务和模板预算', async () => {
  startProject()
  fireEvent.click(screen.getByRole('button', { name: /测试工艺模板/ }))
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  expect(screen.getByText('工艺研究')).toBeInTheDocument()
  expect(screen.getByLabelText(/项目总预算/)).toHaveValue('25')
  fireEvent.click(screen.getByRole('button', { name: '上一步' }))
  fireEvent.click(screen.getByRole('button', { name: /空白项目/ }))
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  expect(screen.queryByText('工艺研究')).not.toBeInTheDocument()
  expect(screen.getByLabelText(/项目总预算/)).toHaveValue('0')
  fireEvent.click(screen.getByRole('button', { name: '确认创建' }))
  await screen.findByRole('heading', { name: /项目创建成功/ })
  expect(vi.mocked(createProjectBundle).mock.calls[0][0].tasks).toEqual([])
})

test('空白项目改选模板后仍实例化任务并保留模板关联', async () => {
  useDataStore.setState({ mode: 'api' })
  startProject()
  fireEvent.click(screen.getByRole('button', { name: /空白项目/ }))
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  fireEvent.click(screen.getByRole('button', { name: '上一步' }))
  fireEvent.click(screen.getByRole('button', { name: /测试工艺模板/ }))
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  expect(screen.getByText('工艺研究')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '确认创建' }))
  await screen.findByRole('heading', { name: /项目创建成功/ })
  const bundle = vi.mocked(createProjectBundle).mock.calls[0][0]
  expect(bundle.project).toMatchObject({ templateId: template.id, templateVersion: 'V1.0' })
  expect(bundle.subProjects).toHaveLength(1)
  expect(bundle.tasks).toHaveLength(1)
  expect(bundle.finance?.totalBudget).toBe(25)
  expect(screen.getByText(/项目已保存到后端数据库/)).toBeInTheDocument()
})

test('模板任务删空仍阻止创建，只有明确选择空白项目才允许零任务', () => {
  startProject()
  fireEvent.click(screen.getByRole('button', { name: /测试工艺模板/ }))
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  fireEvent.click(screen.getByRole('button', { name: '删除任务' }))
  expect(screen.getByRole('button', { name: '确认创建' })).toBeDisabled()
  expect(createProjectBundle).not.toHaveBeenCalled()
})

test('返回基本信息切换产品类型后，须重新确认创建方式', () => {
  startProject()
  fireEvent.click(screen.getByRole('button', { name: /测试工艺模板/ }))
  fireEvent.click(screen.getByRole('button', { name: '上一步' }))
  fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: '其他' } })
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled()
  expect(screen.queryByRole('button', { name: /测试工艺模板/ })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /空白项目/ }))
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  expect(screen.getByRole('heading', { name: '确认空白项目' })).toBeInTheDocument()
})

test('空白项目校验预算，保存失败后保留输入并可重试', async () => {
  vi.mocked(createProjectBundle).mockRejectedValueOnce(new Error('offline'))
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    startProject()
    fireEvent.click(screen.getByRole('button', { name: /空白项目/ }))
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    const budget = screen.getByLabelText(/项目总预算/)
    fireEvent.change(budget, { target: { value: '-1' } })
    expect(screen.getByRole('button', { name: '确认创建' })).toBeDisabled()
    fireEvent.change(budget, { target: { value: '50' } })
    fireEvent.click(screen.getByRole('button', { name: '确认创建' }))
    expect(await screen.findByText(/创建失败，请确认后端/)).toBeInTheDocument()
    expect(budget).toHaveValue('50')
    fireEvent.click(screen.getByRole('button', { name: '确认创建' }))
    await screen.findByRole('heading', { name: /项目创建成功/ })
    expect(createProjectBundle).toHaveBeenCalledTimes(2)
  } finally {
    errorLog.mockRestore()
  }
})
