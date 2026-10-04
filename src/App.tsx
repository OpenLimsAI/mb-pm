import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import Login from './pages/Login'
import { WorkspacePage } from './pages/Workspace'
import PortalGate from './components/portal/PortalGate'
import { siteMode, workspaceUrl } from './lib/site'
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
const OrgManagement = lazy(() => import('./pages/OrgManagement'))
const Tasks = lazy(() => import('./pages/Tasks'))
const GanttPage = lazy(() => import('./pages/Gantt'))
const Workload = lazy(() => import('./pages/Workload'))
const Settings = lazy(() => import('./pages/Settings'))
const ReleaseNotes = lazy(() => import('./pages/ReleaseNotes'))
const PortalAccount = lazy(() => import('./pages/PortalAccount'))
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
            <Route path="/account" element={<PortalAccount />} />
            <Route path="/launch/:appId" element={<PortalLaunch />} />
          </Route>
        </>}
        {siteMode === 'pm' && <Route path="/workspace" element={<ExternalWorkspace />} />}
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
            <Route path="/org"                   element={<OrgManagement />} />
            <Route path="/settings"              element={<Settings />} />
            <Route path="/release-notes"         element={<ReleaseNotes />} />
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
    const portal = siteMode === 'portal' || (siteMode === 'combined' && (['/', '/login', '/workspace', '/account', '/help'].includes(pathname) || pathname.startsWith('/launch/')))
    document.title = portal ? '迈博药业 · 员工应用门户' : 'CMC-PMS · 项目管理'
  }, [pathname])
  return null
}

function ExternalWorkspace() {
  useEffect(() => { window.location.replace(workspaceUrl) }, [])
  return <BootSplash message="正在打开应用工作台 …" />
}
