import { useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { usePortalContext } from '../components/portal/context'
import { solutionApi } from '../features/solutions/api'
import { createPreviewNotesClient, notesApi } from '../features/notes/client'
import { createDemoClient } from '../features/solutions/demo'
import SolutionsApp from '../features/solutions/SolutionsApp'
import { createPreviewModelClient, modelSettingsApi } from '../features/solutions/modelSettings'

export default function Solutions() {
  const { user, identityNamespace, applications, preview, refresh } = usePortalContext()
  const namespace = identityNamespace || user.id
  const client = useMemo(() => preview ? createDemoClient(namespace, user.id, user.displayName) : solutionApi, [namespace, preview, user.id, user.displayName])
  const notesClient = useMemo(() => preview ? createPreviewNotesClient(`${namespace}:${user.id}`) : notesApi, [namespace, preview, user.id])
  const modelClient = useMemo(() => preview ? createPreviewModelClient(`${namespace}:${user.id}`) : modelSettingsApi, [namespace, preview, user.id])
  useEffect(() => {
    const expired = () => { void refresh() }
    window.addEventListener('solutions:unauthorized', expired)
    return () => window.removeEventListener('solutions:unauthorized', expired)
  }, [refresh])
  if (!preview && !applications.some(entry => entry.id === 'solutions' && entry.enabled)) {
    return <main className="portal-panel"><h1>研究报告暂时不可用</h1><p>请返回工作台刷新登录身份。</p><Link className="app-workbench-link" to="/">应用工作台</Link></main>
  }
  return <SolutionsApp key={`${namespace}:${user.id}:${preview}`} client={client} userId={user.id} userName={user.displayName} preview={preview} modelClient={modelClient} notesClient={notesClient} recoveryNamespace={identityNamespace} initialHome />
}
