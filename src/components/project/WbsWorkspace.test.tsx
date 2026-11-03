import { useEffect, useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { WbsWorkspace, type WbsView } from './WbsWorkspace'

function Draft() { return <input aria-label="未保存进度" defaultValue="20" /> }
function Harness() {
  const [view, setView] = useState<WbsView>('table')
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open])
  return <div><button>背景导航</button><WbsWorkspace projectName="测试项目" view={view} onChange={setView} overlayOpen={open}
    overlay={open && <div role="dialog"><button onClick={() => setOpen(false)}>关闭任务</button></div>}>
    {() => <><Draft /><button onClick={() => setOpen(true)}>任务详情</button><span>当前视图：{view}</span></>}
  </WbsWorkspace></div>
}

describe('WBS 全屏工作区', () => {
  it('进入与退出全屏保留同一输入、草稿和外层滚动位置，并恢复背景可交互状态', () => {
    render(<Harness />)
    const input = screen.getByRole('textbox', { name: '未保存进度' })
    const background = screen.getByRole('button', { name: '背景导航' })
    const host = background.parentElement!
    host.scrollTop = 137
    fireEvent.change(input, { target: { value: '56' } })
    fireEvent.click(screen.getByRole('button', { name: '全屏视图' }))
    expect(screen.getByRole('textbox', { name: '未保存进度' })).toBe(input)
    expect(input).toHaveValue('56')
    expect(background.inert).toBe(true)
    expect(document.body.style.overflow).toBe('hidden')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByRole('button', { name: '全屏视图' })).toHaveFocus()
    expect(input).toHaveValue('56')
    expect(background.inert).toBeFalsy()
    expect(document.body.style.overflow).toBe('')
    expect(host.scrollTop).toBe(137)
  })

  it('全屏内可切换三个视图；Esc 先关闭任务抽屉，再退出全屏', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '全屏视图' }))
    for (const [name, value] of [['树形', 'tree'], ['甘特图', 'gantt'], ['表格录入', 'table']]) {
      fireEvent.click(screen.getByRole('button', { name }))
      expect(screen.getByText(`当前视图：${value}`)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '退出全屏' })).toBeInTheDocument()
    }
    const task = screen.getByRole('button', { name: '任务详情' })
    task.focus()
    fireEvent.click(task)
    expect(screen.getByRole('button', { name: '关闭任务' })).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '退出全屏' })).toBeInTheDocument()
    expect(task).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: '退出全屏' }))
    expect(screen.getByRole('button', { name: '全屏视图' })).toBeInTheDocument()
  })

  it('全屏中离开页面会解除背景锁定，并保留原本的 inert 和 overflow 状态', () => {
    const { unmount } = render(<Harness />)
    const background = screen.getByRole('button', { name: '背景导航' })
    background.inert = true
    document.body.style.overflow = 'clip'
    fireEvent.click(screen.getByRole('button', { name: '全屏视图' }))
    unmount()
    expect(background.inert).toBe(true)
    expect(document.body.style.overflow).toBe('clip')
    document.body.style.overflow = ''
  })
})
