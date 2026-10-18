import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import Login from './pages/Login'
import { WorkspacePage } from './pages/Workspace'
import PortalGate from './components/portal/PortalGate'
import { accountsUrl, releaseNotesUrl, settingsRedirect, siteMode, workspaceUrl } from './lib/site'
import { RequirePerm } from './components/auth/RequirePerm'
import { BootSplash } from './components/auth/AuthStatus'

// 工作台首屏不下载项目页面和全量业务数据引导。
const ReadyGate = lazy(() => import('./components/auth/ProjectReadyGate'))
const AppLayout = lazy(() => import('./components/layout/AppLayout').then((module) => ({ default: module.AppLayout })))
const Home = lazy(() => import('./pages/Home'))
const Projects = lazy(() => import('./pages/Projects'))
const ProjectDetail = lazy(() => import('./pages/ProjectDetail'))
const ProjectCreate = lazy(() => import('./pages/ProjectCreate'))
const Templates = lazy(() => import('./pages/Templates'))
const TemplateDetail = lazy(() => import('./pages/TemplateDetail'))
const TemplateEditor = lazy(() => import('./pages/TemplateEditor'))
const TemplatePreview = lazy(() => import('./pages/TemplatePreview'))
const Finance = lazy(() => import('./pages/Finance'))
const Tasks = lazy(() => import('./pages/Tasks'))
const GanttPage = lazy(() => import('./pages/Gantt'))
const Workload = lazy(() => import('./pages/Workload'))
const ReleaseNotes = lazy(() => import('./pages/ReleaseNotes'))
const PortalSettings = lazy(() => import('./pages/PortalSettings'))
const AISettings = lazy(() => import('./pages/AISettings'))
const PortalAccounts = lazy(() => import('./pages/PortalAccounts'))
const PortalHelp = lazy(() => import('./pages/PortalHelp'))
const PortalLaunch = lazy(() => import('./pages/PortalLaunch'))

// www 域名只开放门户页面；pm 保留业务路由与独立鉴权；本地 combined 同时预览两者。
export default function App() {
  return (
    <BrowserRouter>
      <RouteTitle />
      <Suspense fallback={<BootSplash message="正在打开应用 …" />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Navigate to="/login" replace />} />
        {siteMode !== 'pm' && <>
          <Route path="/help" element={<PortalHelp />} />
          <Route path="/workspace" element={<Navigate to="/" replace />} />
          <Route element={<PortalGate />}>
            <Route path="/" element={<WorkspacePage />} />
            <Route path="/settings" element={<SettingsRoute />} />
            {/* 原「我的账号」页并入「我的设置」（保留 ?preview=1 等查询参数） */}
            <Route path="/account" element={<SettingsAlias />} />
            <Route path="/accounts" element={<PortalAccounts />} />
            <Route path="/release-notes" element={<ReleaseNotes />} />
            <Route path="/launch/:appId" element={<PortalLaunch />} />
          </Route>
        </>}
        {siteMode === 'pm' && <>
          <Route path="/workspace" element={<ExternalWorkspace />} />
          {/* 个人设置回门户；旧 AI 标签直达项目管理 AI设置 */}
          <Route path="/settings" element={<SettingsRoute />} />
          <Route path="/org" element={<ExternalRedirect to={accountsUrl} message="正在打开账号管理 …" />} />
          <Route path="/release-notes" element={<ExternalRedirect to={releaseNotesUrl} message="正在打开工作台版本更新 …" keepQuery />} />
        </>}
        {siteMode === 'combined' && <Route path="/org" element={<Navigate to="/accounts" replace />} />}
        {siteMode !== 'portal' && <Route element={<ReadyGate />}>
          <Route element={<AppLayout />}>
            {siteMode === 'pm' && <Route path="/" element={<Home />} />}
            <Route path="/dashboard"             element={<Home />} />
            <Route path="/projects"              element={<Projects />} />
            <Route path="/projects/new"          element={<ProjectCreate />} />
            <Route path="/projects/:id"          element={<ProjectDetail />} />
            <Route path="/templates"             element={<Templates />} />
            <Route path="/templates/:id"         element={<TemplateDetail />} />
            <Route path="/templates/:id/edit"    element={<TemplateEditor />} />
            <Route path="/templates/:id/preview" element={<TemplatePreview />} />
            <Route path="/tasks"                 element={<Tasks />} />
            <Route element={<RequirePerm perms={['gantt.view', 'gantt.view.own']} />}>
              <Route path="/gantt"               element={<GanttPage />} />
            </Route>
            <Route element={<RequirePerm perms={['workload.view']} />}>
              <Route path="/workload"            element={<Workload />} />
            </Route>
            <Route path="/finance"               element={<Finance />} />
            <Route element={<RequirePerm perms={['ai.config']} />}>
              <Route path="/ai-settings"         element={<AISettings />} />
            </Route>
          </Route>
        </Route>}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
    </BrowserRouter>
  )
}

function RouteTitle() {
  const { pathname } = useLocation()
  useEffect(() => {
    const portal = siteMode === 'portal' || (siteMode === 'combined' && (['/', '/login', '/workspace', '/account', '/accounts', '/settings', '/help', '/release-notes'].includes(pathname) || pathname.startsWith('/launch/')))
    document.title = portal ? '迈博药业 · 员工应用门户' : 'CMC-PMS · 项目管理'
  }, [pathname])
  return null
}

function ExternalWorkspace() {
  useEffect(() => { window.location.replace(workspaceUrl) }, [])
  return <BootSplash message="正在打开应用工作台 …" />
}

function SettingsAlias() {
  const { search } = useLocation()
  return <Navigate to={{ pathname: '/settings', search }} replace />
}

function SettingsRoute() {
  const { search } = useLocation()
  const target = settingsRedirect(search)
  if (!target) return <PortalSettings />
  if (target.startsWith('/')) return <Navigate to={target} replace />
  return <ExternalRedirect to={target} message={new URLSearchParams(search).get('tab') === 'ai' ? '正在打开项目管理 AI设置 …' : '正在打开我的设置 …'} />
}

function ExternalRedirect({ to, message, keepQuery = false }: { to: string; message: string; keepQuery?: boolean }) {
  const { search } = useLocation()
  useEffect(() => { window.location.replace(keepQuery ? to + search : to) }, [to, search, keepQuery])
  return <BootSplash message={message} />
}
