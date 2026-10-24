import { useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { usePortalContext } from '../components/portal/context'
import { solutionApi } from '../features/solutions/api'
import { createDemoClient } from '../features/solutions/demo'
import SolutionsApp from '../features/solutions/SolutionsApp'

export default function Solutions() {
  const { user, identityNamespace, applications, preview, refresh } = usePortalContext()
  const namespace = identityNamespace || user.id
  const client = useMemo(() => preview ? createDemoClient(namespace, user.id, user.displayName) : solutionApi, [namespace, preview, user.id, user.displayName])
  useEffect(() => {
    const expired = () => { void refresh() }
    window.addEventListener('solutions:unauthorized', expired)
    return () => window.removeEventListener('solutions:unauthorized', expired)
  }, [refresh])
  if (!preview && !applications.some(entry => entry.id === 'solutions' && entry.enabled)) {
    return <main className="portal-panel"><h1>知识报告暂时不可用</h1><p>请返回工作台刷新登录身份。</p><Link to="/">返回应用工作台</Link></main>
  }
  return <SolutionsApp key={`${namespace}:${preview}`} client={client} userId={user.id} userName={user.displayName} preview={preview} />
}
