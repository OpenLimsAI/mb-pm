import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it } from 'vitest'
import ResizableKnowledgeShell from './ResizableKnowledgeShell'

beforeEach(() => localStorage.clear())
it('adjusts within bounds and restores the saved width for the same user', () => {
  const view=render(<ResizableKnowledgeShell storageKey="user-a" sidebar={<aside/>}><main/></ResizableKnowledgeShell>)
  const separator=screen.getByRole('separator',{name:'调整文件夹栏宽度'})
  fireEvent.keyDown(separator,{key:'ArrowRight',shiftKey:true});expect(separator).toHaveAttribute('aria-valuenow','262')
  fireEvent.keyDown(separator,{key:'Home'});expect(separator).toHaveAttribute('aria-valuenow','180')
  fireEvent.keyDown(separator,{key:'End'});expect(separator).toHaveAttribute('aria-valuenow','420')
  view.unmount();render(<ResizableKnowledgeShell storageKey="user-a" sidebar={<aside/>}><main/></ResizableKnowledgeShell>)
  expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow','420')
  fireEvent.doubleClick(screen.getByRole('separator'));expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow','212')
})
it('isolates saved widths and ignores malformed persisted widths', () => {
  localStorage.setItem('user-a:sidebar-width','999');localStorage.setItem('user-b:sidebar-width','null')
  const view=render(<ResizableKnowledgeShell storageKey="user-a" sidebar={<aside/>}><main/></ResizableKnowledgeShell>)
  expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow','420')
  view.unmount();render(<ResizableKnowledgeShell storageKey="user-b" sidebar={<aside/>}><main/></ResizableKnowledgeShell>)
  expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow','212')
})
it('keeps following the pointer after it leaves the narrow divider', () => {
  render(<ResizableKnowledgeShell storageKey="pointer" sidebar={<aside/>}><main/></ResizableKnowledgeShell>)
  const separator=screen.getByRole('separator')
  fireEvent.pointerDown(separator,{pointerId:1,button:0,clientX:212})
  fireEvent.pointerMove(window,{pointerId:1,clientX:312})
  expect(separator).toHaveAttribute('aria-valuenow','312')
  fireEvent.pointerUp(window,{pointerId:1})
  fireEvent.pointerMove(window,{pointerId:1,clientX:400})
  expect(separator).toHaveAttribute('aria-valuenow','312')
})
