import { useEffect } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { AlertTriangle, Beaker, Loader2, LogOut, RotateCw } from 'lucide-react'
import Login from './pages/Login'
import Home from './pages/Home'
import Projects from './pages/Projects'
import ProjectDetail from './pages/ProjectDetail'
import ProjectCreate from './pages/ProjectCreate'
import Templates from './pages/Templates'
import TemplateDetail from './pages/TemplateDetail'
import TemplateEditor from './pages/TemplateEditor'
import TemplatePreview from './pages/TemplatePreview'
import Finance from './pages/Finance'
import OrgManagement from './pages/OrgManagement'
import Tasks from './pages/Tasks'
import GanttPage from './pages/Gantt'
import Workload from './pages/Workload'
import Settings from './pages/Settings'
import ReleaseNotes from './pages/ReleaseNotes'
import { AppLayout } from './components/layout/AppLayout'
import { RequirePerm } from './components/auth/RequirePerm'
import { Button } from './components/ui'
import { bootstrap, watchIdentity } from './data/bootstrap'
import { useAuth } from './store/auth'
import { useDataStore } from './store/data'

// CTO Lite：首页（组合总览 / 我的看板）/ 项目 / 任务 / 甘特图 / 人员负荷 / 模板 / 财务 / 组织 / 设置（我的账号 / AI）。
//
// 路由结构（鉴权门）：
//   /login       —— 始终可渲染：跳转 mb-casd IAM 登录（授权码 + PKCE 由后端完成）。
//   /register    —— 兼容旧链接，回到登录页；账号统一在 IAM 平台开通。
//   其余所有路由  —— 经 <ReadyGate>：未登录跳 /login；身份不可用显示原因；已登录才拉数据并渲染。
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Navigate to="/login" replace />} />
        <Route element={<ReadyGate />}>
          <Route element={<AppLayout />}>
            <Route path="/"                      element={<Home />} />
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
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

// 鉴权 + 数据就绪门。
function ReadyGate() {
  const ready = useDataStore((s) => s.ready)
  const status = useAuth((s) => s.status)
  const error = useAuth((s) => s.error)
  const location = useLocation()

  useEffect(() => {
    void bootstrap()
    return watchIdentity()
  }, [])

  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  }
  if (status === 'error') return <IdentityProblem message={error} />
  if (!ready) return <BootSplash />
  return <Outlet />
}

function BootSplash() {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 text-ink-500">
      <div className="w-12 h-12 rounded-xl bg-brand-600 flex items-center justify-center text-white">
        <Beaker className="w-7 h-7" />
      </div>
      <div className="flex items-center gap-2 text-sm">
        <Loader2 className="w-4 h-4 animate-spin" /> 正在加载 CMC-PMS 数据 …
      </div>
    </div>
  )
}

// 已连上后端但身份不可用（账号被停用 / 角色不合规 / IAM 暂不可用）：说明原因，可重试或切换账号。
function IdentityProblem({ message }: { message: string | null }) {
  const logout = useAuth((s) => s.logout)
  return (
    <div className="h-full flex items-center justify-center p-8">
      <div className="card p-6 w-full max-w-md">
        <div className="flex items-center gap-2 text-amber-600 mb-3">
          <AlertTriangle className="w-5 h-5" />
          <h1 className="text-base font-semibold text-ink-900">无法确认登录身份</h1>
        </div>
        <p role="alert" className="text-sm text-ink-700">{message || '身份验证失败，请稍后重试。'}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button icon={<LogOut className="w-4 h-4" />} onClick={logout}>切换账号</Button>
          <Button variant="primary" icon={<RotateCw className="w-4 h-4" />} onClick={() => window.location.reload()}>
            重试
          </Button>
        </div>
      </div>
    </div>
  )
}
