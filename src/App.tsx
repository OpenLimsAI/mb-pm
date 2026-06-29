import { useEffect } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { Beaker, Loader2 } from 'lucide-react'
import Callback from './pages/Callback'
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
import { AppLayout } from './components/layout/AppLayout'
import { bootstrap } from './data/bootstrap'
import { useDataStore } from './store/data'

// CTO Lite：仅三大模块 —— 首页（项目组合总览）/ 项目 / 模板。
//
// 路由结构（鉴权门）：
//   /callback        —— 永远渲染（OIDC 回调处理），不受 ready 门控，否则换取 token 的页面会被 BootSplash 挡住。
//   其余所有路由      —— 经 <ReadyGate> 门控：bootstrap() 负责「未登录则跳 Casdoor、已登录才拉数据并 setReady」。
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/callback" element={<Callback />} />
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
            <Route path="/finance"               element={<Finance />} />
            <Route path="/org"                   element={<OrgManagement />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

// 鉴权 + 数据就绪门。仅在非 /callback 路由挂载，故 bootstrap 在回跳后才以已登录态运行。
function ReadyGate() {
  const ready = useDataStore((s) => s.ready)

  useEffect(() => {
    bootstrap()
  }, [])

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
