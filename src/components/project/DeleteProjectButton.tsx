// 删除项目：仅系统管理员 / CMC 负责人可见（后端同样只允许这两个角色）。
// 需输入项目编号二次确认；成功后回调 onDeleted（通常返回项目列表）。
import { useId, useRef, useState, type FormEvent } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import { asAPIError } from '../../api/client'
import { deleteProjectEntry } from '../../data/bootstrap'
import { can } from '../../lib/permissions'
import { useAuth } from '../../store/auth'
import { useDataStore } from '../../store/data'
import type { Project } from '../../types'
import { Button } from '../ui'

export function DeleteProjectButton({
  project,
  onDeleted,
}: {
  project: Project
  onDeleted: () => void
}) {
  const role = useAuth((s) => s.currentUser?.role)
  const online = useDataStore((s) => s.mode === 'api')
  const dialog = useRef<HTMLDialogElement>(null)
  const submitting = useRef(false)
  const titleId = useId()
  const descriptionId = useId()
  const inputId = useId()
  const [confirmation, setConfirmation] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  if (!can(role, 'project.delete')) return null

  function openDialog() {
    setConfirmation('')
    setError('')
    dialog.current?.showModal()
  }

  async function handleDelete(event: FormEvent) {
    event.preventDefault()
    if (
      !online ||
      !can(useAuth.getState().currentUser?.role, 'project.delete') ||
      confirmation.trim() !== project.code ||
      submitting.current
    ) return

    submitting.current = true
    setPending(true)
    setError('')
    try {
      await deleteProjectEntry(project.id)
      dialog.current?.close()
      onDeleted()
    } catch (err) {
      const { status } = asAPIError(err)
      setError(
        status === 403 ? '当前账号没有删除权限：仅系统管理员和项目负责人可删除项目。' :
        status === 401 ? '登录已失效，请重新登录后再试。' :
        status === 404 ? '项目已不存在，请返回项目列表刷新。' :
        status === 409 ? '项目仍被其他记录引用，暂时无法删除。' :
        '未能确认删除结果，请返回项目列表刷新确认；若项目仍存在，可稍后重试。',
      )
    } finally {
      submitting.current = false
      setPending(false)
    }
  }

  return (
    <>
      <Button
        variant="danger"
        size="sm"
        icon={<Trash2 className="w-3.5 h-3.5" />}
        onClick={openDialog}
        disabled={!online}
        title={!online ? '离线演示数据不支持删除，请连接后端后使用。' : undefined}
      >
        删除项目
      </Button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-lg border border-ink-300 p-6 shadow-xl backdrop:bg-black/40"
        onCancel={(event) => { if (submitting.current) event.preventDefault() }}
      >
        <form onSubmit={handleDelete}>
          <h2 id={titleId} className="text-lg font-semibold text-ink-900">删除项目</h2>
          <div id={descriptionId} className="mt-3 space-y-2 text-sm text-ink-700">
            <p>即将删除 <strong>{project.name}</strong>（{project.code}）。</p>
            <p className="text-red-700">
              该项目的子项目、任务、任务依赖、团队关联、财务与基线记录将一并删除，此操作无法撤销。成员账号不受影响。
            </p>
          </div>
          <label htmlFor={inputId} className="mt-4 block text-sm text-ink-700">
            输入项目编号 <strong>{project.code}</strong> 确认
          </label>
          <input
            id={inputId}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off"
            disabled={pending}
            className="mt-2 w-full rounded-md border border-ink-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" disabled={pending} onClick={() => dialog.current?.close()}>取消</Button>
            <Button
              type="submit"
              variant="danger"
              disabled={pending || confirmation.trim() !== project.code}
              icon={pending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            >
              {pending ? '正在删除…' : '确认删除'}
            </Button>
          </div>
        </form>
      </dialog>
    </>
  )
}
