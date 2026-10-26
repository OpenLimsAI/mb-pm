import { useId, type ReactNode } from 'react'
import { BookOpen, LayoutGrid } from 'lucide-react'
import { cn } from '../../lib/cn'
import type { KBRole, PMIdentity } from '../../api/accounts'

export interface PermissionValue { platformAdmin: boolean; pmIdentity: PMIdentity; kbRole: KBRole }

function Choice({ group, label, hint, selected, disabled, onChange }: {
  group: string; label: string; hint: string; selected: boolean; disabled?: boolean; onChange?: () => void
}) {
  return <label className={cn('relative block rounded-lg border p-3 pr-10 text-sm', disabled ? 'bg-ink-100 text-ink-500 opacity-60 cursor-not-allowed' : 'cursor-pointer',
    selected ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-ink-300')}>
    <input type="radio" name={group} aria-label={label} checked={selected} disabled={disabled} onChange={onChange}
      className="absolute right-3 top-4 accent-brand-600" />
    <span className="block font-medium">{label}</span><span className="block mt-1 text-xs text-ink-500">{hint}</span>
  </label>
}

export function AccountPermissions({ value, onChange, available, locked = false, disabled = false, pmRoleNote, children }: {
  value: PermissionValue; onChange: (value: PermissionValue) => void; available: string[]
  locked?: boolean; disabled?: boolean; pmRoleNote?: string; children: ReactNode
}) {
  const id = useId()
  return <>
    <fieldset aria-label="平台管理身份" disabled={disabled} className="rounded-xl border border-purple-100 bg-purple-50/30 p-4 space-y-3">
      <legend className="px-1 text-sm font-semibold text-ink-900">平台管理身份</legend>
      <div className="grid sm:grid-cols-2 gap-3">
        <Choice group={id + '-platform'} label="系统管理员" hint="管理组织账号，拥有项目管理全部权限" selected={value.platformAdmin}
          disabled={!value.platformAdmin && !available.includes('admin')} onChange={() => onChange({ ...value, platformAdmin: true })} />
        <Choice group={id + '-platform'} label="普通成员" hint="应用权限按下方角色设置" selected={!value.platformAdmin}
          disabled={locked} onChange={() => onChange({ ...value, platformAdmin: false })} />
      </div>
      <p className="text-xs text-ink-500">{locked ? '不能取消自己的系统管理员身份。' : '系统管理员继承项目管理全部权限；知识库角色单独授权。'}</p>
    </fieldset>
    <div className="text-sm font-semibold text-ink-900">应用权限</div>
    <fieldset aria-label="项目管理" disabled={disabled} className="rounded-xl border border-ink-300 p-4 space-y-3">
      <legend className="px-1 text-sm font-semibold text-ink-900"><LayoutGrid className="inline w-4 h-4 mr-2" />项目管理</legend>
      {value.platformAdmin && <p className="text-sm text-brand-700">继承系统管理员的全部权限；下方业务角色保留，取消管理员身份后生效。</p>}
      <div className="grid sm:grid-cols-2 gap-3">
        <Choice group={id + '-pm'} label="项目负责人" hint="管理项目、使用 AI 分析和 AI设置；账号管理只读" selected={value.pmIdentity === 'lead'}
          disabled={value.platformAdmin || (value.pmIdentity !== 'lead' && !available.includes('cmc_lead'))}
          onChange={() => onChange({ ...value, pmIdentity: 'lead' })} />
        <Choice group={id + '-pm'} label="项目成员" hint="日常更新本人任务，不提供 AI 功能" selected={value.pmIdentity === 'staff'} disabled={value.platformAdmin}
          onChange={() => onChange({ ...value, pmIdentity: 'staff' })} />
      </div>
      {pmRoleNote && <p className="text-xs text-amber-700">当前角色：{pmRoleNote}；不更改业务角色时保留原授权范围。</p>}
      {children}
    </fieldset>
    <fieldset aria-label="知识库" disabled={disabled} className="rounded-xl border border-ink-300 p-4 space-y-3">
      <legend className="px-1 text-sm font-semibold text-ink-900"><BookOpen className="inline w-4 h-4 mr-2" />知识库</legend>
      <div className="grid sm:grid-cols-2 gap-3">
        <Choice group={id + '-kb'} label="知识库负责人" hint={available.includes('kb_manager') ? '管理 AI设置、上传论文，并使用知识库全部功能' : '当前 IAM 中缺少已启用的 kb_manager 角色'}
          selected={value.kbRole === 'manager'} disabled={!available.includes('kb_manager')} onChange={() => onChange({ ...value, kbRole: 'manager' })} />
        <Choice group={id + '-kb'} label="知识库用户" hint={available.includes('kb_editor') ? '查看与编辑、开始翻译和知识问答' : '当前 IAM 中缺少已启用的 kb_editor 角色'}
          selected={value.kbRole === 'editor'} disabled={!available.includes('kb_editor')} onChange={() => onChange({ ...value, kbRole: 'editor' })} />
      </div>
      {value.kbRole === 'viewer' && <p className="text-xs text-amber-700">当前为历史只读权限；请选择知识库角色后保存，才会变更授权。</p>}
      <p className="text-xs text-ink-500">知识库用户不能上传论文或修改 AI设置；中台管理权限另行授权。</p>
    </fieldset>
  </>
}
