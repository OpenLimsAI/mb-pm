import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MoreHorizontal, Pencil, Settings2, Trash2 } from 'lucide-react'

export type FolderMenuAction = 'rename' | 'delete' | 'settings'
export default function FolderActionMenu({ name, disabled = false, onAction }: {
  name: string; disabled?: boolean; onAction: (action: FolderMenuAction) => void
}) {
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  function close(restoreFocus = false) { setPosition(null); if (restoreFocus) trigger.current?.focus() }
  function show() {
    if (disabled) return
    const rect = trigger.current!.getBoundingClientRect()
    setPosition({ top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 144)), left: Math.max(8, Math.min(rect.right - 158, window.innerWidth - 166)) })
  }
  useEffect(() => {
    if (!position) return
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setPosition(null) }
    const hide = () => setPosition(null)
    document.addEventListener('pointerdown', outside); window.addEventListener('resize', hide); window.addEventListener('scroll', hide, true)
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', hide); window.removeEventListener('scroll', hide, true) }
  }, [position])
  return <>
    <button ref={trigger} type="button" className="kso-icon-btn kso-folder-more" aria-label={`管理文件夹 ${name}`} aria-haspopup="menu" aria-expanded={!!position} disabled={disabled} onClick={() => position ? close() : show()} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); show() } }}><MoreHorizontal size={16}/></button>
    {position && createPortal(<div ref={menu} className="kso-folder-action-menu" role="menu" aria-label={`${name}文件夹操作`} style={position} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) }
      const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button') || [])
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus() }
      if (event.key === 'Tab') close()
    }}>{([
      ['rename', '重命名', Pencil], ['delete', '删除文件夹', Trash2], ['settings', '更多设置', Settings2],
    ] as const).map(([action, label, Icon]) => <button key={action} type="button" role="menuitem" className={action === 'delete' ? 'is-danger' : undefined} onClick={() => { close(true); onAction(action) }}><Icon size={15}/>{label}</button>)}</div>, document.body)}
  </>
}
