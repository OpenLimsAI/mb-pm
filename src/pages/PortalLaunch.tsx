import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ArrowRight, Loader2, LockKeyhole } from 'lucide-react'
import PortalLayout from '../components/portal/PortalLayout'
import { usePortalContext } from '../components/portal/context'
import { usePortal } from '../store/portal'
import { feedbackUrl, solutionsUrl, knowledgeLaunchUrl, projectApplicationUrl } from '../lib/site'
import { getMDMLaunchUrl } from '../api/portal'

export default function PortalLaunch() {
  const { appId } = useParams()
  const [params] = useSearchParams()
  const returnTo = params.get('return_to') || '/dashboard'
  const notes = appId === 'kb' && params.get('view') === 'notes'
  const context = usePortalContext()
  const { refresh, preview, logout } = context
  const [problem, setProblem] = useState('')
  const valid = appId === 'pm' || appId === 'kb' || appId === 'information' || appId === 'solutions' || appId === 'feedback' || appId === 'mdm'
  const name = appId === 'feedback' ? '回音壁' : appId === 'mdm' ? '主数据管理' : appId === 'solutions' ? '研究报告' : appId === 'information' ? '行业信息' : appId === 'pm' ? '项目管理' : notes ? '我的笔记' : '知识库'

  useEffect(() => {
    if (!valid || preview || appId === 'information') return
    let cancelled = false
    void refresh().then(async () => {
      if (cancelled) return
      const state = usePortal.getState()
      const access = state.applications.find((app) => app.id === appId)
      if (state.status !== 'ready') {
        setProblem('登录状态已变化，请返回工作台重新确认。')
      } else if (!access?.enabled) {
        setProblem(access?.reason || '尚未开通此应用，请联系管理员。')
      } else {
        // 固定应用地址，不接收任意外部 URL，也不通过 URL 携带身份令牌。
        const url = appId === 'mdm' ? await getMDMLaunchUrl() : appId === 'feedback' ? feedbackUrl : appId === 'solutions' ? solutionsUrl : appId === 'pm' ? projectApplicationUrl(returnTo) : notes ? knowledgeLaunchUrl + '#notes' : knowledgeLaunchUrl
        if (!cancelled) window.location.replace(url)
      }
    }).catch(() => { if (!cancelled) setProblem('暂时无法打开应用，请确认登录及应用入口配置。') })
    return () => { cancelled = true }
  }, [appId, valid, preview, refresh, returnTo, notes])

  const message = appId === 'information' ? '行业信息已下线，知识源正在重新设计。已有资料保留。' : !valid ? '没有找到这个应用，请返回工作台选择应用。' : preview ? '当前为界面预览，不会进入真实应用。' : problem
  return <PortalLayout user={context.user} logout={logout} preview={preview}>
    <section className="portal-panel portal-launch" aria-live="polite">
      <span className="workspace-app-icon">{message ? <LockKeyhole size={26} aria-hidden="true" /> : <Loader2 size={26} className="workspace-spin" aria-hidden="true" />}</span>
      <h1>{message ? '暂时无法打开应用' : `正在打开${name}`}</h1>
      <p className="portal-secondary-copy">{message || '正在确认应用访问权限，请稍候。'}</p>
      <Link className="portal-primary-action" to={'/' + (preview ? '?preview=1' : '')}>返回工作台<ArrowRight size={17} aria-hidden="true" /></Link>
    </section>
  </PortalLayout>
}
