// 「请先修改临时密码」：管理员新建账号或重置密码后，本人第一次进入门户 / 项目管理时显示，改完才能继续。
// 替代 Casdoor 的「需要更新密码」（它会把人带到 IAM 自己的页面、回不到应用）。后端在改密前对其他接口返回 403。
import { LogOut, ShieldCheck } from 'lucide-react'
import { PasswordChangeForm } from '../account/PasswordChangeForm'

export function ForcedPasswordChange({ name, submit, onDone, onLogout }: {
  name?: string
  submit: (current: string, next: string) => Promise<void>
  onDone: () => void
  onLogout: () => void
}) {
  return (
    <div className="min-h-dvh bg-[#f3f6f8] flex items-center justify-center p-4">
      <div className="w-full max-w-[440px] space-y-4">
        <div className="flex items-center gap-3">
          <img src="/brand/maibo-pharma-logo.png" alt="迈博药业" className="w-10 h-11 object-contain" />
          <div>
            <div className="font-semibold text-[#23486f] tracking-wider">迈博药业</div>
            <div className="text-xs text-ink-500">数字化工作空间</div>
          </div>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 flex gap-2.5">
          <ShieldCheck className="w-5 h-5 shrink-0 text-amber-700" />
          <span>{name ? `${name}，` : ''}管理员为你设置了临时密码。为了账号安全，请先修改密码后再继续使用。</span>
        </div>
        <PasswordChangeForm submit={submit} onDone={onDone} currentLabel="临时密码（管理员告诉你的）"
          className="bg-white rounded-xl border border-[#dfe7ed] p-6 space-y-4" title="设置新密码"
          description="新密码在门户、项目管理和知识库中同时生效。"
          successNotice="密码已修改，正在进入…" />
        <button type="button" onClick={onLogout} className="text-sm text-ink-500 hover:text-ink-900 inline-flex items-center gap-1.5">
          <LogOut className="w-4 h-4" />退出登录
        </button>
      </div>
    </div>
  )
}
