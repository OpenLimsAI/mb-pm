import { useEffect, useState } from 'react'
import { CheckCircle2, Cloud, Cpu, Loader2, Save, Settings2, Unplug } from 'lucide-react'
import { aiError, getAIModels, getAISettings, providerLabels, saveAISettings, testAIConnection, type AIProvider, type AISettings, type ProviderConfig } from '../api/ai'
import { Button } from '../components/ui'
import { useDataStore } from '../store/data'
import { cn } from '../lib/cn'

export default function Settings() {
  const online = useDataStore(s => s.mode) === 'api'
  const [draft, setDraft] = useState<AISettings | null>(null)
  const [editing, setEditing] = useState<AIProvider>('deepseek')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [dirty, setDirty] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let active = true
    if (online) getAISettings().then(value => {
      if (active) { setDraft(value); setEditing(value.provider); setError('') }
    }).catch(e => { if (active) setError(aiError(e)) })
    return () => { active = false }
  }, [online, retry])

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  function update(patch: Partial<AISettings>) {
    if (!draft) return
    setDraft({ ...draft, ...patch }); setDirty(true); setNotice(''); setError('')
  }
  function updateProvider(patch: Partial<ProviderConfig>) {
    if (!draft) return
    update({ providers: { ...draft.providers, [editing]: { ...draft.providers[editing], ...patch } } })
  }
  async function action(kind: 'save' | 'models' | 'test') {
    if (!draft) return
    setBusy(kind); setError(''); setNotice('')
    try {
      if (kind === 'save') {
        const saved = await saveAISettings(draft)
        setDraft(saved); setDirty(false)
        setNotice(!['custom', 'ollama'].includes(saved.provider) && !saved.providers[saved.provider].keySet ? '设置已保存；当前服务商尚未填写 API Key，填写后即可生成分析。' : '设置已保存，项目分析将使用此配置。')
      } else if (kind === 'models') {
        const result = await getAIModels(editing, draft.providers[editing])
        setModels(result.models)
        setNotice(result.models.length ? `已读取 ${result.models.length} 个模型，请选择或手动填写模型名称。` : '连接成功，但没有可用模型。请先在模型服务中安装或开通模型。')
      } else {
        const result = await testAIConnection(editing, draft.providers[editing])
        setNotice(`模型调用成功 · ${result.model} · ${(result.ms / 1000).toFixed(1)} 秒。${dirty ? '请保存设置后用于项目分析。' : ''}`)
      }
    } catch (e) { setError(aiError(e)) } finally { setBusy('') }
  }

  const cfg = draft?.providers[editing]
  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div><h1 className="text-xl font-semibold flex items-center gap-2"><Settings2 className="w-5 h-5 text-brand-600" />设置</h1><p className="text-sm text-ink-500 mt-1">管理项目分析使用的 AI 服务与本地模型。</p></div>
        <Button variant="primary" disabled={!draft || !!busy || !dirty || !online} onClick={() => action('save')} icon={busy === 'save' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}>保存设置{dirty ? ' · 未保存' : ''}</Button>
      </div>
      {!online && <div className="p-4 rounded-lg bg-amber-50 text-amber-800 text-sm">当前为离线演示模式，请连接后端后配置 AI。</div>}
      {error && <div role="alert" className="p-3 rounded-lg bg-red-50 text-red-700 text-sm">{error}{!draft && online && <button className="underline ml-3" onClick={() => setRetry(v => v + 1)}>重新加载</button>}</div>}
      {notice && <div role="status" className="p-3 rounded-lg bg-emerald-50 text-emerald-800 text-sm flex items-center gap-2"><CheckCircle2 className="w-4 h-4 shrink-0" />{notice}</div>}
      {!draft && online && !error && <div className="flex gap-2 items-center text-ink-500"><Loader2 className="animate-spin w-4 h-4" />正在加载设置…</div>}
      {draft && cfg && <>
        <section className="card p-5 space-y-4">
          <div><h2 className="font-semibold">AI 设置</h2><p className="text-sm text-ink-500 mt-1">选择项目分析服务。每家服务商的地址、模型和密钥分别保存。</p></div>
          <fieldset disabled={!!busy} className="grid sm:grid-cols-2 gap-5">
            <label className="text-sm space-y-2"><span className="font-medium">项目分析使用</span><select className="input" value={draft.provider} onChange={e => { const p = e.target.value as AIProvider; update({ provider: p }); setEditing(p); setModels([]) }}>{Object.entries(providerLabels).map(([p, label]) => <option key={p} value={p}>{label}</option>)}</select></label>
            <div className="rounded-lg bg-ink-100 p-3 text-sm text-ink-700">当前模型：<b className="text-ink-900">{draft.providers[draft.provider].model || '尚未选择'}</b><p className="text-xs mt-1">在下方填写配置，可先读取模型列表，再测试实际调用。</p></div>
          </fieldset>
        </section>
        <section className="card overflow-hidden">
          <div className="flex flex-wrap gap-1 p-3 border-b border-ink-300/60 bg-slate-50">
            {(Object.keys(providerLabels) as AIProvider[]).map(p => <button key={p} disabled={!!busy} onClick={() => { setEditing(p); setModels([]); setError(''); setNotice('') }} className={cn('px-3 py-2 rounded-md text-sm flex items-center gap-2', editing === p ? 'bg-brand-50 text-brand-700 font-medium' : 'text-ink-700 hover:bg-ink-100')}>{p === 'ollama' ? <Cpu className="w-4 h-4" /> : <Cloud className="w-4 h-4" />}{providerLabels[p]}{draft.provider === p && <span className="text-[10px] border rounded px-1">当前</span>}</button>)}
          </div>
          <fieldset disabled={!!busy} className="p-5 space-y-5">
            <div><h3 className="font-semibold">{providerLabels[editing]}</h3><p className="text-xs text-ink-500 mt-1">{editing === 'ollama' ? '连接 Ollama，直接使用已安装的本地模型，无需 API Key。' : '使用 OpenAI 兼容的对话接口。填写基础地址，不含 /chat/completions。'}</p></div>
            <label className="block text-sm space-y-2"><span>接口地址</span><input className="input" value={cfg.baseUrl} onChange={e => { updateProvider({ baseUrl: e.target.value }); setModels([]) }} placeholder={editing === 'ollama' ? 'http://127.0.0.1:11434' : 'https://example.com/v1'} /></label>
            {editing === 'minimax' && <p className="text-xs text-ink-500">国内地址：https://api.minimaxi.com/v1；国际地址：https://api.minimax.io/v1。请与创建密钥的平台一致。</p>}
            {editing !== 'ollama' && <div className="space-y-2"><label className="block text-sm space-y-2"><span>API Key {editing === 'custom' && '（本地兼容服务可留空）'}</span><input type="password" autoComplete="new-password" className="input" value={cfg.apiKey || ''} onChange={e => updateProvider({ apiKey: e.target.value, clearKey: false })} placeholder={cfg.keySet ? '密钥已保存；留空保留原密钥' : '输入 API Key'} /></label><div className="flex justify-between text-xs text-ink-500"><span>密钥仅保存在后端本机，不回传完整密钥。更换地址后需重新填写。</span>{cfg.keySet && <button className="text-red-600 ml-2 shrink-0" onClick={() => updateProvider({ apiKey: '', clearKey: !cfg.clearKey })}>{cfg.clearKey ? '撤销清除' : '清除已存密钥'}</button>}</div>{cfg.clearKey && <p className="text-xs text-amber-700">保存后将清除该服务商密钥。</p>}</div>}
            <div className="grid sm:grid-cols-[1fr_auto] items-end gap-3"><label className="text-sm space-y-2"><span>模型名称</span><input className="input" list="ai-model-options" value={cfg.model} onChange={e => updateProvider({ model: e.target.value })} placeholder="读取模型列表选择，或手动输入" /><datalist id="ai-model-options">{models.map(name => <option key={name} value={name} />)}</datalist></label><Button onClick={() => action('models')} icon={busy === 'models' ? <Loader2 className="w-4 h-4 animate-spin" /> : undefined}>读取模型列表</Button></div>
            {models.length > 0 && <label className="block text-sm space-y-2"><span>可用模型</span><select className="input" value={models.includes(cfg.model) ? cfg.model : ''} onChange={e => updateProvider({ model: e.target.value })}><option value="" disabled>选择模型</option>{models.map(name => <option key={name} value={name}>{name}</option>)}</select></label>}
            <Button disabled={!!busy || !cfg.model || !cfg.baseUrl} onClick={() => action('test')} icon={busy === 'test' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Unplug className="w-4 h-4" />}>{busy === 'test' ? '正在调用模型…' : '测试连接'}</Button>
            {editing === 'ollama' && <div className="text-sm bg-ink-100 rounded-lg p-4 space-y-2 text-ink-700"><p>先运行 Ollama，再点击「读取模型列表」。尚未安装时可前往 <a href="https://ollama.com/download" target="_blank" rel="noreferrer" className="text-brand-700 underline">Ollama 官网</a>。</p><p>模型需先在 Ollama 中下载；模型名称应与本机列表一致。默认地址运行在后端所在电脑，修改为远程地址时，资料将发送到那台模型服务器。</p></div>}
          </fieldset>
        </section>
        <section className="card p-5 space-y-3">
          <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" disabled={!!busy} checked={draft.offlineFallback} onChange={e => update({ offlineFallback: e.target.checked })} />云端连接失败时改用 Ollama 本地模型</label>
          <p className="text-sm text-ink-500">仅在网络连接失败或超时时切换；密钥错误、额度不足不会触发。分析记录会标明实际使用的模型。</p>
          {draft.offlineFallback && <p className="text-sm">备用模型：<b>{draft.providers.ollama.model || '尚未配置'}</b><button className="ml-3 text-brand-700 underline" disabled={!!busy} onClick={() => { setEditing('ollama'); setModels([]) }}>配置本地模型</button></p>}
        </section>
        <p className="text-xs text-ink-500 leading-relaxed">生成分析时，会将所选项目的任务、里程碑、依赖、团队姓名、预算和最新基线发送至配置的模型服务。测试连接仅发送简短测试文字。设置不会自动导入月报系统的密钥。</p>
      </>}
    </div>
  )
}
