import { useEffect, useState } from 'react'
import { Beaker, LogIn, UserPlus } from 'lucide-react'
import { fetchIAMConfig, type IAMConfig } from '../api/auth'
import { aiError } from '../api/ai'
import { useAuth } from '../store/auth'
import { Button } from '../components/ui'

export default function Login() {
  const error = useAuth(s => s.error)
  const [config, setConfig] = useState<IAMConfig | null>(null)
  const [message, setMessage] = useState('')
  useEffect(() => {
    let active = true
    fetchIAMConfig().then(c => { if (active) setConfig(c) }).catch(e => { if (active) setMessage(aiError(e)) })
    return () => { active = false }
  }, [])
  const code = new URLSearchParams(window.location.search).get('error')
  const oauthError = code ? ({ state: '登录链接已过期，请重新登录。', role: '此账号尚不能关联项目身份，请联系管理员检查角色或用户名、邮箱冲突。', provider: 'IAM 身份验证失败，请检查服务配置后重试。', cancelled: '已取消登录。' }[code] || '登录失败，请重试。') : ''
  return <div className="h-full flex items-center justify-center p-6 bg-slate-100"><div className="card p-8 w-full max-w-md space-y-5">
    <Beaker className="w-10 h-10 text-brand-600" /><div><h1 className="text-2xl font-semibold">CMC-PMS Lite</h1><p className="text-sm text-ink-500 mt-2">使用统一 IAM 账号访问研发项目。</p></div>
    {(oauthError || message || error) && <p role="alert" className="text-sm p-3 bg-red-50 text-red-700 rounded">{oauthError || message || error}</p>}
    {config?.enabled ? <>
      <Button className="w-full" variant="primary" icon={<LogIn className="w-4 h-4" />} onClick={() => { window.location.assign(config.loginUrl) }}>使用 IAM 账号登录</Button>
      <a className="btn-secondary w-full justify-center" href={config.signupUrl}><UserPlus className="w-4 h-4" />创建自己的账号</a>
      <p className="text-xs text-ink-500 leading-6">已有账号可直接登录。新用户在 IAM 中自行设置用户名和密码，初次进入仅拥有普通成员权限；由负责人将你加入项目后即可看到项目数据。</p>
    </> : <p className="text-sm text-ink-500">{config ? 'IAM 接入尚未启用，请由管理员完成回调地址和注册配置。' : '正在连接身份服务…'}</p>}
    <Button className="w-full" onClick={() => window.location.reload()}>刷新连接状态</Button>
  </div></div>
}
