import { useEffect, useState } from 'react'
import { ExternalLink, ShieldCheck } from 'lucide-react'
import { fetchIAMConfig, type IAMConfig } from '../api/auth'
import { aiError } from '../api/ai'
import { useAuth } from '../store/auth'
import { roleLabels } from '../lib/permissions'
import { Button } from '../components/ui'

export default function Account() {
  const user = useAuth(s => s.currentUser)
  const [config, setConfig] = useState<IAMConfig | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    fetchIAMConfig().then(c => { if (active) setConfig(c) }).catch(e => { if (active) setError(aiError(e)) })
    return () => { active = false }
  }, [])
  return <div className="p-6 max-w-4xl mx-auto space-y-5">
    <div><h1 className="text-xl font-semibold flex items-center gap-2"><ShieldCheck className="w-5 h-5 text-brand-600" />我的账号</h1><p className="text-sm text-ink-500 mt-2">由现有 IAM 统一管理身份和密码。</p></div>
    {error && <p role="alert" className="text-red-700 text-sm">{error}</p>}
    <section className="card p-6 space-y-4"><dl className="grid grid-cols-[100px_1fr] text-sm gap-3"><dt className="text-ink-500">当前用户名</dt><dd>{user.username}</dd><dt className="text-ink-500">姓名</dt><dd>{user.displayName}</dd><dt className="text-ink-500">业务角色</dt><dd>{roleLabels[user.role]}</dd></dl>
      {config?.enabled ? <>
        <div className="border-t pt-4 flex flex-wrap gap-3"><a href={config.accountUrl} target="_blank" rel="noreferrer" className="btn-primary"><ExternalLink className="w-4 h-4" />修改用户名 / 密码</a><Button onClick={() => window.location.assign(config.loginUrl)}>重新登录并同步账号</Button></div>
        <p className="text-sm text-ink-500 leading-6">在 IAM「我的账号」中修改用户名，或通过密码项修改自己的密码。修改用户名后先保存，再修改密码；完成后回到这里重新登录。项目归属与历史记录按稳定身份标识关联，不会因改名丢失。</p>
        <a className="text-brand-700 text-sm underline" href={config.signupUrl} target="_blank" rel="noreferrer">新用户注册入口</a>
      </> : <div className="p-3 rounded bg-amber-50 text-amber-800 text-sm leading-6">Lite 的 IAM 接入待管理员启用。目前为原有演示模式；启用后可使用已有账号登录，并通过 IAM 注册、修改用户名和密码。现有账号和项目数据将保留。</div>}
    </section>
  </div>
}
