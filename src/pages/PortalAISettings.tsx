import { useEffect, useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { LayoutGrid } from 'lucide-react'
import PortalLayout from '../components/portal/PortalLayout'
import { usePortalContext } from '../components/portal/context'
import ModelSettingsPanel from '../features/solutions/ModelSettingsPanel'
import { createPreviewModelClient, modelSettingsApi } from '../features/solutions/modelSettings'
import AssistantOperationsPanel from '../components/settings/AssistantOperationsPanel'

export default function PortalAISettings() {
  const { user, identityNamespace, preview, logout, refresh } = usePortalContext()
  const navigate = useNavigate(), suffix = preview ? '?preview=1' : ''
  const namespace = identityNamespace || user.id
  const client = useMemo(() => preview ? createPreviewModelClient(`${namespace}:${user.id}`) : modelSettingsApi, [namespace, preview, user.id])
  useEffect(() => {
    const expired = () => { void refresh() }
    window.addEventListener('solutions:unauthorized', expired)
    return () => window.removeEventListener('solutions:unauthorized', expired)
  }, [refresh])
  return <PortalLayout user={user} logout={logout} preview={preview}>
    <div className="portal-page-heading"><div className="workspace-section-label">AI SETTINGS</div><h1>AI 设置</h1><p>统一管理当前账号的 AI 模型，供工作台助手、研究报告和知识库问答、翻译、摘要及标签生成使用。</p></div>
    <section className="portal-panel portal-ai-settings" aria-label="个人 AI 模型设置">
      <Link className="app-workbench-link" to={'/' + suffix}><LayoutGrid size={16} />应用工作台</Link>
      <ModelSettingsPanel client={client} preview={preview} onChange={() => {}} onClose={() => navigate('/' + suffix)} />
    </section>
    {!preview && <AssistantOperationsPanel key={namespace} />}
  </PortalLayout>
}
