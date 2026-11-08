import { useEffect, useState } from 'react'
import { Contrast, Grid2X2, MessageSquareText } from 'lucide-react'
import { feedbackUrl, settingsUrl, workspaceUrl } from '../../lib/site'
import { buildFeedbackEntry } from '../../features/feedback/source'
import './applicationActions.css'

const THEME_KEY = 'maibo.application.theme'
function savedTheme(): boolean {
  try { return localStorage.getItem(THEME_KEY) === 'dark' } catch { return false }
}

export default function ApplicationActions({ userName, preview, application, page = window.location }: {
  userName?: string; preview: boolean; application?: string; page?: Pick<Location, 'pathname' | 'hash'>
}) {
  const [dark, setDark] = useState(savedTheme)
  const suffix = preview ? '?preview=1' : ''
  const route = page.pathname.split('/')[1]
  const source = application || ({ 'knowledge-sources': 'knowledge-sources', solutions: 'solutions', assistant: 'assistant', notes: 'notes', feedback: 'feedback', 'data-backup': 'data-backup', accounts: 'accounts', settings: 'settings', 'model-settings': 'models' } as Record<string, string>)[route] || 'platform'
  useEffect(() => {
    document.documentElement.dataset.applicationTheme = dark ? 'dark' : 'light'
    return () => { delete document.documentElement.dataset.applicationTheme }
  }, [dark])
  return <div className="application-actions">
    <a className="app-feedback-link app-header-link" href={buildFeedbackEntry(preview ? '/feedback' : feedbackUrl, source, page, preview)} target="_blank" rel="noopener noreferrer" aria-label="回音壁（新标签页打开）" title="在新标签页打开回音壁，原页面保留"><MessageSquareText size={17} aria-hidden="true" /><span>回音壁</span></a>
    <a className="app-workbench-link app-workbench-entry" href={preview ? '/' + suffix : workspaceUrl} aria-label="应用工作台" title="返回工作台"><Grid2X2 size={17} aria-hidden="true" /><span>工作台</span></a>
    <span className="application-action-divider" aria-hidden="true" />
    {userName && <a className="application-account" href={preview ? '/settings' + suffix : settingsUrl} aria-label={`${userName} · 我的设置`} title="我的设置">
      <span className="application-avatar" aria-hidden="true">{Array.from(userName || '我')[0]}</span>
      <span className="application-account-copy"><strong title={userName}>{userName}</strong></span>
    </a>}
    <button className="application-theme-toggle" type="button" aria-label="切换主题" title={dark ? '切换浅色主题' : '切换深色主题'} aria-pressed={dark} onClick={() => setDark(value => { const next = !value; try { localStorage.setItem(THEME_KEY, next ? 'dark' : 'light') } catch { /* Keep the selection for this session. */ } return next })}><Contrast size={19} aria-hidden="true" /></button>
  </div>
}
