import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, ArrowUpRight, BookOpen, BriefcaseBusiness, Check, ChevronRight, LayoutGrid, LockKeyhole, RefreshCw, ShieldCheck } from 'lucide-react'
import PortalLayout from '../components/portal/PortalLayout'
import { usePortalContext } from '../components/portal/context'

export interface WorkspaceUser {
  id: string
  username: string
  displayName: string
}

export interface WorkspaceApplication {
  id: 'pm' | 'kb'
  enabled: boolean
  reason?: string
}

interface ApplicationPresentation {
  id: 'pm' | 'kb'
  name: string
  englishName: string
  description: string
  domain: string
  href: string
  external?: boolean
  kind: 'projects' | 'knowledge'
  features: readonly string[]
}

export interface WorkspaceProps {
  user: WorkspaceUser | null
  /** 门户后端提供应用准入信息，不从 PM 角色推断知识库权限。 */
  applications: readonly WorkspaceApplication[]
  onRefresh: () => Promise<void>
  onLogout: () => void
  preview?: boolean
}

const applicationPresentations: readonly ApplicationPresentation[] = [
  {
    id: 'pm',
    name: '项目管理',
    englishName: 'PROJECT MANAGEMENT',
    description: '把计划、进度与团队协作放在一起，清晰掌握研发项目的每一步。',
    domain: 'pm.openlims.ai',
    href: '/launch/pm',
    kind: 'projects',
    features: ['项目与任务', '团队协作', '财务与风险'],
  },
  {
    id: 'kb',
    name: '知识库',
    englishName: 'KNOWLEDGE BASE',
    description: '连接团队的知识与经验，让需要的信息更容易找到，让积累持续产生价值。',
    domain: 'kb.openlims.ai',
    href: '/launch/kb',
    external: true,
    kind: 'knowledge',
    features: ['知识检索', '内容阅读', '经验沉淀'],
  },
]

function ApplicationCard({ application, access, preview }: { application: ApplicationPresentation; access?: WorkspaceApplication; preview: boolean }) {
  const Icon = application.kind === 'knowledge' ? BookOpen : BriefcaseBusiness
  const enabled = preview || access?.enabled === true
  const content = (
    <>
      <div className="workspace-app-topline">
        <span className="workspace-app-icon"><Icon size={27} strokeWidth={1.7} aria-hidden="true" /></span>
        <span className="workspace-app-domain">{enabled ? application.domain : <span className="workspace-pending-label"><LockKeyhole size={12} aria-hidden="true" />待开通</span>}</span>
      </div>
      <div className="workspace-app-copy">
        <span className="workspace-eyebrow">{application.englishName}</span>
        <h3>{application.name}</h3>
        <p>{application.description}</p>
      </div>
      <ul className="workspace-app-features" aria-label="主要功能">
        {application.features.map((feature) => <li key={feature}><Check size={14} aria-hidden="true" />{feature}</li>)}
      </ul>
      {enabled ? <div className="workspace-app-entry">
        <span>进入{application.name}</span>
        {application.external ? <ArrowUpRight size={20} aria-hidden="true" /> : <ArrowRight size={20} aria-hidden="true" />}
      </div> : <div className="workspace-app-unavailable"><LockKeyhole size={15} aria-hidden="true" /><span>{access?.reason || '尚未开通此应用，请联系管理员。'}</span></div>}
      {enabled && application.external && <span className="workspace-sr-only">，在新标签页打开</span>}
    </>
  )
  const className = `workspace-app-card workspace-app-card--${application.kind}${enabled ? '' : ' workspace-app-card--unavailable'}`

  if (!enabled || preview) return <article className={className}>{content}</article>

  return (
    <a className={className} href={application.href} target={application.external ? '_blank' : undefined} rel={application.external ? 'noopener noreferrer' : undefined} aria-label={`进入${application.name}${application.external ? '（新标签页）' : ''}`}>
      {content}
    </a>
  )
}

export default function Workspace({ user, applications, onRefresh, onLogout, preview = false }: WorkspaceProps) {
  const [refreshing, setRefreshing] = useState(false)
  const [notice, setNotice] = useState('')
  const displayName = user?.displayName || user?.username || ''

  const refreshIdentity = async () => {
    if (refreshing) return
    setRefreshing(true)
    setNotice('')
    try {
      await onRefresh()
      setNotice('登录身份已刷新。')
    } catch {
      setNotice('暂时无法刷新登录身份，请稍后重试。')
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <PortalLayout user={user} logout={onLogout} preview={preview}>
        <section className="workspace-welcome" aria-labelledby="workspace-welcome-title">
          <div className="workspace-welcome-content">
            <div className="workspace-welcome-label"><span className="workspace-label-line" /> MAIBO WORKSPACE</div>
            <h1 id="workspace-welcome-title">{displayName ? `${displayName}，欢迎回来` : '欢迎来到迈博工作空间'}</h1>
            <p>从这里开始，连接项目与知识，继续今天的工作。</p>
            <div className="workspace-welcome-meta"><ShieldCheck size={16} aria-hidden="true" /><span>{preview ? '迈博数字化应用门户' : '迈博 IAM 统一身份登录'}</span></div>
          </div>
          <div className="workspace-welcome-art" aria-hidden="true">
            <div className="workspace-art-orbit workspace-art-orbit--outer" />
            <div className="workspace-art-orbit workspace-art-orbit--inner" />
            <span className="workspace-art-node workspace-art-node--project"><BriefcaseBusiness size={29} strokeWidth={1.5} /></span>
            <span className="workspace-art-node workspace-art-node--knowledge"><BookOpen size={25} strokeWidth={1.5} /></span>
            <span className="workspace-art-hub"><LayoutGrid size={29} strokeWidth={1.4} /></span>
            <span className="workspace-art-dot" />
          </div>
        </section>

        <section className="workspace-apps" aria-labelledby="workspace-apps-title">
          <div className="workspace-section-heading">
            <div><div className="workspace-section-label">YOUR APPLICATIONS</div><h2 id="workspace-apps-title">工作应用</h2><p>选择一个应用，进入你的工作。</p></div>
            <button type="button" className="workspace-refresh" onClick={() => { void refreshIdentity() }} disabled={refreshing || preview}>
              <RefreshCw size={16} className={refreshing ? 'workspace-spin' : undefined} aria-hidden="true" />{refreshing ? '正在刷新' : '刷新身份'}
            </button>
          </div>
          <p className="workspace-notice" role="status" aria-live="polite">{notice}</p>
          <div className="workspace-app-grid">
            {applicationPresentations.map((application) => <ApplicationCard key={application.id} application={application} access={applications.find((entry) => entry.id === application.id)} preview={preview} />)}
          </div>
        </section>

        <aside className="workspace-help" aria-label="账号与访问说明">
          <span className="workspace-help-icon"><ShieldCheck size={22} strokeWidth={1.6} aria-hidden="true" /></span>
          <div><strong>一个身份，连接你的工作</strong><p>用户信息统一在 IAM 平台管理，应用内的数据和操作权限由各应用管理。</p></div>
          <Link to="/help">使用帮助<ChevronRight size={16} aria-hidden="true" /></Link>
        </aside>
    </PortalLayout>
  )
}

export function WorkspacePage() {
  const { user, applications, refresh, logout, preview } = usePortalContext()
  return <Workspace user={user} applications={applications} onRefresh={refresh} onLogout={logout} preview={preview} />
}
