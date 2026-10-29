import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, BookOpen, BriefcaseBusiness, Check, ChevronRight, FilePenLine, NotebookPen, Settings2, SlidersHorizontal, LayoutGrid, LockKeyhole, Radar, Sparkles, RefreshCw, ShieldCheck, UsersRound } from 'lucide-react'
import PortalLayout from '../components/portal/PortalLayout'
import { usePortalContext } from '../components/portal/context'
import { knowledgeLaunchUrl, siteMode } from '../lib/site'

export interface WorkspaceUser {
  id: string
  username: string
  displayName: string
}

export interface WorkspaceApplication {
  id: 'pm' | 'kb' | 'information' | 'solutions' | 'notes' | 'accounts' | 'assistant'
  enabled: boolean
  reason?: string
}

interface ApplicationPresentation {
  id: string
  accessId?: WorkspaceApplication['id']
  name: string
  englishName: string
  description: string
  domain: string
  href: string
  previewHref?: string
  planned?: boolean
  kind: 'projects' | 'knowledge' | 'information' | 'solutions' | 'notes' | 'hr' | 'accounts' | 'settings' | 'ai' | 'assistant'
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

const assistantApps: readonly ApplicationPresentation[] = [
  { id: 'assistant', accessId: 'assistant', name: 'AI 助手', englishName: 'AI ASSISTANT', description: '围绕一个任务展开对话，带上资料与上下文，让问题、讨论和成果在同一个工作空间里连接起来。', domain: '任务 · 对话 · 产物', href: '/assistant', previewHref: '/assistant?preview=1', kind: 'assistant', features: ['独立任务对话', '资料与上下文', '结果与产物'] },
]
const knowledgeApps: readonly ApplicationPresentation[] = [
  { id: 'solutions', accessId: 'solutions', name: '研究报告', englishName: 'RESEARCH REPORTS', description: '在写作中查阅知识、追问依据，把论文、实践与专家判断写成可追溯的研究报告。', domain: '研究 · 论证 · 撰写', href: '/launch/solutions', previewHref: '/solutions?preview=1', kind: 'solutions', features: ['报告撰写', '知识与 AI', '引用与版本'] },
  { id: 'notes', name: '我的笔记', englishName: 'MY NOTES', description: '整理阅读笔记、研究观察与写作灵感，让每一次思考都有迹可循。', domain: '阅读 · 记录 · 整理', href: '/notes', previewHref: '/notes?preview=1', kind: 'notes', features: ['个人笔记', '阅读摘录', '思考整理'] },
  { id: 'kb', accessId: 'kb', name: '知识库', englishName: 'KNOWLEDGE BASE', description: '连接团队的知识与经验，让需要的信息更容易找到，让积累持续产生价值。', domain: new URL(knowledgeLaunchUrl).host, href: '/launch/kb', previewHref: knowledgeLaunchUrl + '?preview=1', kind: 'knowledge', features: ['知识检索', '内容阅读', '经验沉淀'] },
  { id: 'information', accessId: 'information', name: '行业信息', englishName: 'INDUSTRY INFORMATION', description: '管理医药信息源，收集重要资料，让行业动态与知识积累连接起来。', domain: 'ICH · Q / S / E / M', href: '/launch/information', previewHref: '/information?preview=1', kind: 'information', features: ['信息源监控', '批量收录', '更新与关注'] },
]
const businessApps: readonly ApplicationPresentation[] = [
  { id: 'pm', accessId: 'pm', name: '项目管理', englishName: 'PROJECT MANAGEMENT', description: '把计划、进度与团队协作放在一起，清晰掌握研发项目的每一步。', domain: 'pm.openlims.ai', href: '/launch/pm', previewHref: siteMode === 'combined' ? '/dashboard' : undefined, kind: 'projects', features: ['项目与任务', '团队协作', '财务与风险'] },
  { id: 'hr', name: '人力资源', englishName: 'HUMAN RESOURCES', description: '人员与组织管理的统一入口，应用正在规划中。', domain: '待开发应用', href: '', planned: true, kind: 'hr', features: ['人员档案', '组织管理', '人事流程'] },
  { id: 'accounts', accessId: 'accounts', name: '账号管理', englishName: 'ACCOUNT MANAGEMENT', description: '统一查看组织成员与账号身份，按管理权限维护账号信息。', domain: '按管理权限使用', href: '/accounts', kind: 'accounts', features: ['组织成员', '账号身份', '应用权限'] },
]
const settingApps: readonly ApplicationPresentation[] = [
  { id: 'settings', name: '我的设置', englishName: 'MY SETTINGS', description: '管理个人登录账号，修改用户名、密码并查看应用访问。', domain: '个人账号', href: '/settings', previewHref: '/settings?preview=1', kind: 'settings', features: ['登录身份', '用户名与密码', '应用访问'] },
  { id: 'models', name: 'AI 设置', englishName: 'AI SETTINGS', description: '管理个人研究模型，配置多组服务、连接信息与默认模型。', domain: '个人模型', href: '/model-settings', previewHref: '/model-settings?preview=1', kind: 'ai', features: ['多个服务商', '模型配置', '默认选择'] },
]
const icons = { assistant: Sparkles, solutions: FilePenLine, notes: NotebookPen, knowledge: BookOpen, information: Radar, projects: BriefcaseBusiness, hr: UsersRound, accounts: ShieldCheck, settings: Settings2, ai: SlidersHorizontal }

function ApplicationCard({ application, access, preview }: { application: ApplicationPresentation; access?: WorkspaceApplication; preview: boolean }) {
  const Icon = icons[application.kind]
  const enabled = !application.planned && (preview || !application.accessId || access?.enabled === true)
  const content = (
    <>
      <div className="workspace-app-topline">
        <span className="workspace-app-icon"><Icon size={27} strokeWidth={1.7} aria-hidden="true" /></span>
        <span className="workspace-app-domain">{application.planned ? '待开发' : enabled ? application.domain : <span className="workspace-pending-label"><LockKeyhole size={12} aria-hidden="true" />待开通</span>}</span>
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
        <ArrowRight size={20} aria-hidden="true" />
      </div> : <div className="workspace-app-unavailable"><LockKeyhole size={15} aria-hidden="true" /><span>{application.planned ? '应用待开发，敬请期待。' : access?.reason || '尚未开通此应用，请联系管理员。'}</span></div>}
    </>
  )
  const className = `workspace-app-card workspace-app-card--${application.kind}${enabled ? '' : ' workspace-app-card--unavailable'}`

  if (!enabled || (preview && !application.previewHref)) return <article className={className} aria-label={application.name}>{content}</article>

  return (
    <a className={className} href={preview ? application.previewHref : application.href} aria-label={`进入${application.name}`}>
      {content}
    </a>
  )
}

export default function Workspace({ user, applications, onRefresh, onLogout, preview = false }: WorkspaceProps) {
  const [refreshing, setRefreshing] = useState(false)
  const [notice, setNotice] = useState('')
  const displayName = user?.displayName || user?.username || ''
  // 管理功能单独分区，仅向获得账号管理准入的人显示；界面预览和普通员工不显示。
  const showManagement = !preview && applications.some((entry) => entry.id === 'accounts' && entry.enabled)

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

        <section className="workspace-category workspace-category--intelligence" aria-labelledby="workspace-intelligence-title">
          <div className="workspace-section-heading"><div><div className="workspace-section-label">AI INTELLIGENCE</div><h2 id="workspace-intelligence-title">AI 智能版块</h2><p>与 AI 一起拆解问题、整理资料，形成可继续使用的工作成果。</p></div><Sparkles size={25} aria-hidden="true" /></div>
          <div className="workspace-app-grid workspace-ai-grid">{assistantApps.map(application => <ApplicationCard key={application.id} application={application} access={applications.find(entry => entry.id === application.accessId)} preview={preview} />)}</div>
        </section>

        <section className="workspace-apps workspace-category workspace-category--knowledge" aria-labelledby="workspace-knowledge-title">
          <div className="workspace-section-heading">
            <div><div className="workspace-section-label">KNOWLEDGE & INFORMATION</div><h2 id="workspace-knowledge-title">知识信息版块</h2><p>从资料与笔记出发，连接研究、知识和行业动态。</p></div>
            <button type="button" className="workspace-refresh" onClick={() => { void refreshIdentity() }} disabled={refreshing || preview}><RefreshCw size={16} className={refreshing ? 'workspace-spin' : undefined} aria-hidden="true" />{refreshing ? '正在刷新' : '刷新身份'}</button>
          </div>
          <p className="workspace-notice" role="status" aria-live="polite">{notice}</p>
          <div className="workspace-app-grid">{knowledgeApps.map(application => <ApplicationCard key={application.id} application={application} access={applications.find(entry => entry.id === application.accessId)} preview={preview} />)}</div>
        </section>
        <section className="workspace-category workspace-category--business" aria-labelledby="workspace-business-title">
          <div className="workspace-section-heading"><div><div className="workspace-section-label">BUSINESS MANAGEMENT</div><h2 id="workspace-business-title">业务管理版块</h2><p>集中处理项目、人员和账号管理。</p></div><BriefcaseBusiness size={25} aria-hidden="true" /></div>
          <div className={`workspace-app-grid workspace-business-grid${showManagement ? ' has-accounts' : ''}`}>{businessApps.filter(application => application.id !== 'accounts' || showManagement).map(application => <ApplicationCard key={application.id} application={application} access={applications.find(entry => entry.id === application.accessId)} preview={preview} />)}</div>
        </section>
        <section className="workspace-category workspace-category--settings" aria-labelledby="workspace-settings-title">
          <div className="workspace-section-heading"><div><div className="workspace-section-label">PREFERENCES & TOOLS</div><h2 id="workspace-settings-title">功能设置版块</h2><p>管理个人账号与 AI 模型偏好。</p></div><Settings2 size={25} aria-hidden="true" /></div>
          <div className="workspace-app-grid">{settingApps.map(application => <ApplicationCard key={application.id} application={application} preview={preview} />)}</div>
        </section>

        <aside className="workspace-help" aria-label="账号与访问说明">
          <span className="workspace-help-icon"><ShieldCheck size={22} strokeWidth={1.6} aria-hidden="true" /></span>
          <div><strong>一个身份，连接你的工作</strong><p>账号由系统管理员统一开通；修改用户名或密码请在「我的设置」中进行。</p></div>
          <Link to="/help">使用帮助<ChevronRight size={16} aria-hidden="true" /></Link>
        </aside>
    </PortalLayout>
  )
}

export function WorkspacePage() {
  const { user, applications, refresh, logout, preview } = usePortalContext()
  return <Workspace user={user} applications={applications} onRefresh={refresh} onLogout={logout} preview={preview} />
}
