import { SlidersHorizontal } from 'lucide-react'
import { AISettingsPanel } from '../components/settings/AISettingsPanel'
import { useDataStore } from '../store/data'

export default function AISettings() {
  const online = useDataStore((state) => state.mode === 'api')
  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-ink-900 flex items-center gap-2.5"><SlidersHorizontal className="w-6 h-6 text-brand-600" />AI设置</h1>
        <p className="text-sm text-ink-500 mt-2">维护项目与财务分析提示词；模型及默认选择与工作台统一共享。</p>
      </div>
      <AISettingsPanel online={online} />
    </div>
  )
}
