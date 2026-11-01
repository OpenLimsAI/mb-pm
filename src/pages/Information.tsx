import { Link } from 'react-router-dom'

export default function Information() {
  return <main className="portal-panel"><h1>行业信息已下线</h1><p>请使用知识源管理论文、文件夹和下载来源。已有资料保留。</p><Link className="app-workbench-link" to="/knowledge-sources">打开知识源</Link> <Link className="app-workbench-link" to="/">应用工作台</Link></main>
}
