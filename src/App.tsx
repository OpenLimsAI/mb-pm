import { useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Beaker, Loader2 } from 'lucide-react'
import Callback from './pages/Callback'
import { getAccessToken, login } from './lib/oidc'
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
export default function App() {
  const ready = useDataStore((s) => s.ready)

  useEffect(() => {
    if (window.location.pathname === '/callback') return
    getAccessToken().then((t) => { if (!t) login() })
  }, [])

  useEffect(() => {
    bootstrap()
  }, [])

  if (!ready) return <BootSplash />

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/"                     element={<Home />} />
          <Route path="/projects"             element={<Projects />} />
          <Route path="/projects/new"         element={<ProjectCreate />} />
          <Route path="/projects/:id"         element={<ProjectDetail />} />
          <Route path="/templates"            element={<Templates />} />
          <Route path="/templates/:id"        element={<TemplateDetail />} />
          <Route path="/templates/:id/edit"   element={<TemplateEditor />} />
          <Route path="/templates/:id/preview" element={<TemplatePreview />} />
          <Route path="/finance"              element={<Finance />} />
          <Route path="/org"                  element={<OrgManagement />} />
        </Route>
        <Route path="/callback" element={<Callback />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
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
