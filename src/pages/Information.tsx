import { Link } from 'react-router-dom'
import { usePortalContext } from '../components/portal/context'
import InformationApp from '../features/information/InformationApp'

export default function Information() {
  const { user, identityNamespace, applications, preview } = usePortalContext()
  if (!preview && !applications.some((entry) => entry.id === 'information' && entry.enabled)) {
    return <main className="portal-panel"><h1>行业信息暂时不可用</h1><p>请返回工作台刷新登录身份。</p><Link className="app-workbench-link" to="/">应用工作台</Link></main>
  }
  return <InformationApp key={`${identityNamespace || user.id}:${preview}`} />
}
