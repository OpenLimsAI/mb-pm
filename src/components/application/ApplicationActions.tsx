import { useEffect, useState } from 'react'
import { Contrast, Grid2X2 } from 'lucide-react'
import './applicationActions.css'

const THEME_KEY = 'maibo.application.theme'
function savedTheme(): boolean {
  try { return localStorage.getItem(THEME_KEY) === 'dark' } catch { return false }
}

export default function ApplicationActions({ userName, preview }: { userName: string; preview: boolean }) {
  const [dark, setDark] = useState(savedTheme)
  const suffix = preview ? '?preview=1' : ''
  useEffect(() => {
    document.documentElement.dataset.applicationTheme = dark ? 'dark' : 'light'
    return () => { delete document.documentElement.dataset.applicationTheme }
  }, [dark])
  return <div className="application-actions">
    <a className="app-workbench-link" href={'/' + suffix} aria-label="应用工作台"><Grid2X2 size={16} aria-hidden="true" /><span>应用工作台</span></a>
    <a className="application-account" href={'/settings' + suffix} aria-label={`${userName} · 我的设置`} title="我的设置">
      <span className="application-avatar" aria-hidden="true">{Array.from(userName || '我')[0]}</span>
      <span className="application-account-copy"><strong>{userName}</strong><small>{preview ? '界面预览账号' : '当前登录账号'}</small></span>
    </a>
    <button className="application-theme-toggle" type="button" aria-label="切换主题" title={dark ? '切换浅色主题' : '切换深色主题'} aria-pressed={dark} onClick={() => setDark(value => { const next = !value; try { localStorage.setItem(THEME_KEY, next ? 'dark' : 'light') } catch { /* Keep the selection for this session. */ } return next })}><Contrast size={19} aria-hidden="true" /></button>
  </div>
}
