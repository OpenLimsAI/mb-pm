import { useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { usePortalContext } from '../components/portal/context'
import AssistantApp from '../features/assistant/AssistantApp'
import { assistantApi, createPreviewAssistantClient } from '../features/assistant/client'
import { createPreviewModelClient, modelSettingsApi } from '../features/solutions/modelSettings'

export default function Assistant() {
  const { user, identityNamespace, preview, applications, refresh } = usePortalContext()
  const namespace = `${identityNamespace || user.id}:${user.id}`
  const client = useMemo(() => preview ? createPreviewAssistantClient(namespace) : assistantApi, [namespace, preview])
  const modelClient = useMemo(() => preview ? createPreviewModelClient(namespace) : modelSettingsApi, [namespace, preview])
  useEffect(() => { const expired = () => { void refresh() }; window.addEventListener('solutions:unauthorized', expired); return () => window.removeEventListener('solutions:unauthorized', expired) }, [refresh])
  if (!preview && !applications.some(app => app.id === 'assistant' && app.enabled)) return <main className="portal-panel"><h1>AI 助手暂时不可用</h1><p>请返回工作台刷新登录身份。</p><Link className="app-workbench-link" to="/">应用工作台</Link></main>
  return <AssistantApp key={`${namespace}:${preview}`} client={client} modelClient={modelClient} userName={user.displayName || user.username} preview={preview} namespace={namespace} />
}
