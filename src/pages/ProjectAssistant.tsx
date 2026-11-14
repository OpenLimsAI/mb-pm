import { useSearchParams } from 'react-router-dom'
import { Sparkles } from 'lucide-react'
import { projects } from '../mock'
import { useDataStore } from '../store/data'
import { PMAssistant } from '../components/project/PMAssistant'

export default function ProjectAssistant() {
  const [params, setParams] = useSearchParams()
  useDataStore(state => state.version)
  const online = useDataStore(state => state.mode === 'api')
  const requested = params.get('project') || undefined
  const project = requested ? projects.find(item => item.id === requested) : undefined
  return <div className="p-6 max-w-[1600px] mx-auto space-y-4">
    <header>
      <h1 className="text-2xl font-semibold text-ink-900 flex items-center gap-2"><Sparkles className="h-6 w-6 text-brand-600" />项目 AI 助手</h1>
      <p className="mt-1 text-sm text-ink-500">集中提问、核对项目情况、比较排期及查看已有报告。</p>
    </header>
    <label className="block text-sm max-w-lg">项目范围
      <select aria-label="助手项目范围" className="input mt-1" value={requested ?? ''} onChange={event => {
        const next = new URLSearchParams(params)
        if (event.target.value) next.set('project', event.target.value)
        else next.delete('project')
        for (const key of ['aiRun', 'agent_report', 'agent_proposal']) next.delete(key)
        setParams(next)
      }}>
        <option value="">全部可见项目</option>
        {requested && !project && <option value={requested}>项目不可访问</option>}
        {projects.map(item => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}
      </select>
    </label>
    {requested && !project ? <p role="alert" className="rounded border border-amber-200 bg-amber-50 p-4 text-sm">所选项目不存在或不可访问，请重新选择项目。</p>
      : online ? <PMAssistant projectId={project?.id} standalone />
        : <p className="rounded border border-ink-200 bg-white p-4 text-sm text-ink-500">连接后端并登录后，可使用项目 AI 助手及查看授权范围内的历史报告。</p>}
  </div>
}
