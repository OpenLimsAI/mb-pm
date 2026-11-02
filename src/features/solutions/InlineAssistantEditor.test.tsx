import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import InlineAssistantEditor from './InlineAssistantEditor'

beforeEach(() => { localStorage.setItem('ks-editor-mode', 'markdown') })

function mount(initial = '') {
  const create = vi.fn()
  function Editor() {
    const [content, setContent] = useState(initial)
    return <InlineAssistantEditor content={content} cards={[]} disabled={false} scope="全部授权资料"
      onEdit={edit => setContent(current => current.slice(0, edit.from) + edit.insert + current.slice(edit.to))}
      onSelection={() => {}} onCreate={create} onUpdate={() => {}} onRemove={() => {}} onAsk={() => {}} onAdopt={() => {}} onSource={() => {}} />
  }
  render(<Editor />)
  return { input: screen.getByRole('textbox', { name: '章节正文' }), create }
}

describe('inline slash command input', () => {
  it('keeps read-only reports immutable through formatting controls', () => {
    const edit = vi.fn()
    render(<InlineAssistantEditor content="只读正文" cards={[]} disabled scope="全部授权资料"
      onEdit={edit} onSelection={() => {}} onCreate={() => {}} onUpdate={() => {}} onRemove={() => {}} onAsk={() => {}} onAdopt={() => {}} onSource={() => {}} />)
    expect(screen.getByRole('textbox', { name: '章节正文' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '加粗' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '加粗' }))
    expect(edit).not.toHaveBeenCalled()
  })

  it('formats selected text and preserves the caret through undo and redo', () => {
    const { input } = mount('研究目标：验证')
    fireEvent.focus(input)
    fireEvent.select(input, { target: { selectionStart: 5, selectionEnd: 7 } })
    fireEvent.click(screen.getByRole('button', { name: '加粗' }))
    expect(input).toHaveValue('研究目标：**验证**')
    expect(input).toHaveFocus()
    expect((input as HTMLTextAreaElement).selectionStart).toBe(7)
    fireEvent.keyDown(input, { key: 'z', metaKey: true })
    expect(input).toHaveValue('研究目标：验证')
    fireEvent.click(screen.getByRole('button', { name: '重做正文编辑' }))
    expect(input).toHaveValue('研究目标：**验证**')
  })

  it('uses keyboard formatting and continues lists without breaking IME input', () => {
    const { input } = mount('观察')
    fireEvent.focus(input)
    fireEvent.select(input, { target: { selectionStart: 0, selectionEnd: 2 } })
    fireEvent.keyDown(input, { key: 'i', ctrlKey: true })
    expect(input).toHaveValue('*观察*')
    fireEvent.click(screen.getByRole('button', { name: '撤销正文编辑' }))
    fireEvent.click(screen.getByRole('button', { name: '项目列表' }))
    expect(input).toHaveValue('- 观察')
    fireEvent.select(input, { target: { selectionStart: 4, selectionEnd: 4 } })
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(input).toHaveValue('- 观察')
    fireEvent.compositionEnd(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input).toHaveValue('- 观察\n- ')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input).toHaveValue('- 观察\n')
  })

  it('drops the redo branch when a fresh text edit follows undo', () => {
    const { input } = mount('观察')
    fireEvent.input(input, { target: { value: '观察记录', selectionStart: 4, selectionEnd: 4 }, inputType: 'insertText', data: '记录' })
    fireEvent.click(screen.getByRole('button', { name: '撤销正文编辑' }))
    expect(input).toHaveValue('观察')
    fireEvent.input(input, { target: { value: '观察结果', selectionStart: 4, selectionEnd: 4 }, inputType: 'insertText', data: '结果' })
    expect(screen.getByRole('button', { name: '重做正文编辑' })).toBeDisabled()
    expect(input).toHaveValue('观察结果')
  })

  it('offers an accessible command for a typed slash and supports Enter', () => {
    const { input, create } = mount()
    fireEvent.input(input, { target: { value: '/', selectionStart: 1, selectionEnd: 1 }, inputType: 'insertText', data: '/' })
    expect(screen.getByRole('menu', { name: '插入功能' })).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(create).toHaveBeenCalledWith(0, [])
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('keeps literal text on Escape and closes on caret navigation', () => {
    const { input, create } = mount()
    fireEvent.input(input, { target: { value: '/', selectionStart: 1, selectionEnd: 1 }, inputType: 'insertText', data: '/' })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).toHaveValue('/')
    expect(create).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    fireEvent.input(input, { target: { value: '/\n/', selectionStart: 3, selectionEnd: 3 }, inputType: 'insertText', data: '/' })
    fireEvent.keyDown(input, { key: 'ArrowLeft' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('does not open a command for pasted text, URLs or input composition', () => {
    const { input, create } = mount()
    fireEvent.input(input, { target: { value: '/', selectionStart: 1, selectionEnd: 1 }, inputType: 'insertFromPaste', data: '/' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    fireEvent.input(input, { target: { value: 'https:/', selectionStart: 7, selectionEnd: 7 }, inputType: 'insertText', data: '/' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    fireEvent.compositionStart(input)
    fireEvent.input(input, { target: { value: '\n/', selectionStart: 2, selectionEnd: 2 }, inputType: 'insertText', data: '/', isComposing: true })
    fireEvent.compositionEnd(input)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(create).not.toHaveBeenCalled()
  })

  it('allows keyboard focus on the command and escape back to editing', () => {
    const { input } = mount()
    fireEvent.input(input, { target: { value: '/', selectionStart: 1, selectionEnd: 1 }, inputType: 'insertText', data: '/' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    const command = screen.getByRole('menuitem')
    expect(command).toHaveFocus()
    fireEvent.keyDown(command, { key: 'Escape' })
    expect(input).toHaveFocus()
    expect(input).toHaveValue('/')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
