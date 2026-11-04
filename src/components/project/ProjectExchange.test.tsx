import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { projectExchange, type ProjectExcelPreview } from '../../api/projectExchange'
import { ProjectExchange } from './ProjectExchange'

const result: ProjectExcelPreview = {
  projectId: 'p1', rowCount: 2, changedCount: 1, canApply: true, fingerprint: 'fingerprint', errorLimit: 200, errors: [],
  changes: [{ row: 2, taskId: 't1', taskName: '费用核对任务', resubmitAcceptance: false, changes: [{ field: '实际花费(万元)', before: null, after: 0 }] }],
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
afterEach(() => vi.restoreAllMocks())

function open(onApplied = vi.fn()) {
  render(<ProjectExchange projectId="p1" canManage onApplied={onApplied} />)
  fireEvent.click(screen.getByRole('button', { name: 'Excel 导入导出' }))
  const file = new File(['xlsx'], '计划.xlsx')
  fireEvent.change(screen.getByLabelText('项目工作簿'), { target: { files: [file] } })
  return { file, onApplied }
}

describe('项目 Excel 预览与确认', () => {
  it('预览差异且填写原因后才可应用，保留明确的0，成功通知刷新', async () => {
    vi.spyOn(projectExchange, 'preview').mockResolvedValue(result)
    const save = vi.spyOn(projectExchange, 'apply').mockResolvedValue({ updatedCount: 1 })
    const { file, onApplied } = open()
    expect(screen.queryByRole('button', { name: '确认更新 1 项任务' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '校验并预览差异' }))
    const confirm = await screen.findByRole('button', { name: '确认更新 1 项任务' })
    expect(confirm).toBeDisabled()
    expect(screen.getByText('未填写')).toBeInTheDocument()
    expect(screen.getByText('0')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Excel 导入原因'), { target: { value: '核实原始费用' } })
    fireEvent.click(confirm)
    await screen.findByText('已更新 1 项任务，并记录变更原因。')
    expect(save).toHaveBeenCalledWith('p1', file, 'fingerprint', '核实原始费用')
    expect(onApplied).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: '确认更新 1 项任务' })).not.toBeInTheDocument()
  })

  it('错误显示行号，不提供确认入口；换文件清除旧预览', async () => {
    vi.spyOn(projectExchange, 'preview').mockResolvedValue({ ...result, canApply: false, errors: [{ row: 3, column: '负责人', message: '不在项目团队' }] })
    open()
    fireEvent.click(screen.getByRole('button', { name: '校验并预览差异' }))
    expect(await screen.findByText('第 3 行 · 负责人：不在项目团队')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '确认更新 1 项任务' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('项目工作簿'), { target: { files: [new File(['other'], 'other.xlsx')] } })
    expect(screen.queryByText('第 3 行 · 负责人：不在项目团队')).not.toBeInTheDocument()
  })

  it('关闭时取消预览，迟到结果不会恢复旧数据', async () => {
    let finish!: (value: ProjectExcelPreview) => void
    const preview = vi.spyOn(projectExchange, 'preview').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    open()
    fireEvent.click(screen.getByRole('button', { name: '校验并预览差异' }))
    const signal = preview.mock.calls[0][2]!
    fireEvent.click(screen.getByRole('button', { name: '关闭项目 Excel' }))
    expect(signal.aborted).toBe(true)
    finish(result)
    fireEvent.click(screen.getByRole('button', { name: 'Excel 导入导出' }))
    await waitFor(() => expect(screen.queryByText('费用核对任务')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: '校验并预览差异' })).toBeDisabled()
  })

  it('无管理权限隐藏入口，无效文件提示修正', () => {
    const { unmount } = render(<ProjectExchange projectId="p1" canManage={false} onApplied={vi.fn()} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    unmount()
    open()
    fireEvent.change(screen.getByLabelText('项目工作簿'), { target: { files: [new File(['wrong'], 'data.csv')] } })
    expect(screen.getByRole('status')).toHaveTextContent('请选择不超过 10 MiB 的 .xlsx')
    expect(screen.getByRole('button', { name: '校验并预览差异' })).toBeDisabled()
  })
})
