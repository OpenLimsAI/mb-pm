import { useSearchParams } from 'react-router-dom'
import { Settings2, Sparkles, UserRound, type LucideIcon } from 'lucide-react'
import { AccountPanel } from '../components/settings/AccountPanel'
import { AISettingsPanel } from '../components/settings/AISettingsPanel'
import { cn } from '../lib/cn'
import { can } from '../lib/permissions'
import { useAuth } from '../store/auth'

type Tab = 'account' | 'ai'

// 设置：「我的账号」人人可用；「AI 分析」仅 admin / cmc_lead（后端 /ai/settings 同样限权）。
export default function Settings() {
  const canConfigureAI = can(useAuth((s) => s.currentUser?.role), 'ai.config')
  const [params, setParams] = useSearchParams()
  const tab: Tab = canConfigureAI && params.get('tab') === 'ai' ? 'ai' : 'account'
  const select = (next: Tab) => setParams(next === 'ai' ? { tab: 'ai' } : {}, { replace: true })

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold flex items-center gap-2"><Settings2 className="w-5 h-5 text-brand-600" />设置</h1>
        <p className="text-sm text-ink-500 mt-1">
          {canConfigureAI ? '管理您的登录账号，以及项目分析使用的 AI 服务。' : '管理您的登录账号。'}
        </p>
      </div>
      {canConfigureAI && (
        <div role="tablist" aria-label="设置分类" className="flex gap-1 border-b border-ink-300/60">
          <TabButton icon={UserRound} active={tab === 'account'} onClick={() => select('account')}>我的账号</TabButton>
          <TabButton icon={Sparkles} active={tab === 'ai'} onClick={() => select('ai')}>AI 分析</TabButton>
        </div>
      )}
      <div role="tabpanel" hidden={tab !== 'account'}><AccountPanel /></div>
      {/* 切换分类时保留 AI 设置里未保存的修改 */}
      {canConfigureAI && <div role="tabpanel" hidden={tab !== 'ai'}><AISettingsPanel /></div>}
    </div>
  )
}

function TabButton({ icon: Icon, active, onClick, children }: { icon: LucideIcon; active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        '-mb-px px-3 py-2 text-sm flex items-center gap-2 border-b-2 transition-colors',
        active ? 'border-brand-600 text-brand-700 font-medium' : 'border-transparent text-ink-600 hover:text-ink-900',
      )}
    >
      <Icon className="w-4 h-4" />{children}
    </button>
  )
}
