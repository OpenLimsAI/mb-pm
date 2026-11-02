import { useEffect, useRef, useState } from 'react'
import { Check, CircleAlert, KeyRound, LoaderCircle, Plus, Server, ShieldCheck, Star, Trash2, Zap } from 'lucide-react'
import { MAX_MODEL_PROFILES, modelEndpointIdentity, modelProfileDraft, modelProviderEndpoints, modelProviderLabels, validateModelProfile } from './modelSettings'
import type { ModelProfileDraft, ModelProvider, ModelSettings, ModelSettingsClient } from './modelSettings'
import { ModelPricePicker } from '../../components/settings/ModelPricePicker'
import { notifySearchConfigurationChanged } from '../answerModes/useSearchCapabilities'
import './modelSettings.css'

interface Props { client: ModelSettingsClient; preview: boolean; onChange: (settings: ModelSettings) => void; onClose: () => void }
const toDrafts = (settings: ModelSettings) => settings.profiles.map(modelProfileDraft)

export default function ModelSettingsPanel({ client, preview, onChange, onClose }: Props) {
  const [saved, setSaved] = useState<ModelSettings | null>(null)
  const [drafts, setDrafts] = useState<ModelProfileDraft[]>([]), [selectedId, setSelectedId] = useState<string | null>(null)
  const [defaultId, setDefaultId] = useState<string | null>(null), [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState(''), [saveError, setSaveError] = useState('')
  const [loadedClient, setLoadedClient] = useState<ModelSettingsClient | null>(null)
  const [saving, setSaving] = useState(false), [testing, setTesting] = useState(false), [testMessage, setTestMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [notice, setNotice] = useState(''), [loadAttempt, setLoadAttempt] = useState(0)
  const active = useRef(false), generation = useRef(0)
  const selected = drafts.find(profile => profile.id === selectedId), isLoading = loading || loadedClient !== client, busy = saving || testing
  const stored = saved?.profiles.find(profile => profile.id === selectedId)
  const endpointChanged = !!stored?.keySet && !!selected && (stored.provider !== selected.provider || modelEndpointIdentity(stored.baseUrl) !== modelEndpointIdentity(selected.baseUrl))
  const keyAvailable = !!selected?.apiKey || !!stored?.keySet && !endpointChanged && !selected?.clearKey
  function errorText(error: unknown) {
    let text = error instanceof Error ? error.message : '操作未完成，请重试。'
    for (const profile of drafts) if (profile.apiKey) text = text.split(profile.apiKey).join('[密钥已隐藏]')
    return text
  }
  useEffect(() => {
    active.current = true
    const token = ++generation.current
    client.get().then(value => {
      if (!active.current || token !== generation.current) return
      setSaved(value); setDrafts(toDrafts(value)); setDefaultId(value.defaultProfileId); setSelectedId(value.profiles[0]?.id || null); setDirty(false); setLoadError(''); setSaveError(''); setNotice(''); setSaving(false); setTesting(false); setTestMessage(null)
    }).catch(() => { if (active.current && token === generation.current) setLoadError('无法读取模型设置，请重试。') }).finally(() => { if (active.current && token === generation.current) { setLoading(false); setLoadedClient(client) } })
    return () => { active.current = false; generation.current += 1 }
  }, [client, loadAttempt])

  function update(patch: Partial<ModelProfileDraft>) {
    if (!selected || busy) return
    const changedDestination = patch.provider !== undefined && patch.provider !== selected.provider || patch.baseUrl !== undefined && modelEndpointIdentity(patch.baseUrl) !== modelEndpointIdentity(selected.baseUrl)
    setDrafts(items => items.map(profile => profile.id === selected.id ? { ...profile, ...patch, ...(changedDestination ? { apiKey: undefined } : {}) } : profile))
    setDirty(true); setSaveError(''); setNotice(''); setTestMessage(null)
  }
  function addProfile() {
    if (drafts.length >= MAX_MODEL_PROFILES || busy) return
    const id = crypto.randomUUID()
    setDrafts(items => [...items, { id, name: `模型配置 ${items.length + 1}`, provider: 'deepseek', baseUrl: modelProviderEndpoints.deepseek, model: '' }])
    setSelectedId(id); if (!drafts.length) setDefaultId(id)
    setDirty(true); setNotice(''); setSaveError(''); setTestMessage(null)
  }
  function removeProfile() {
    if (!selected || busy) return
    const remaining = drafts.filter(profile => profile.id !== selected.id)
    setDrafts(remaining); setSelectedId(remaining[0]?.id || null); if (defaultId === selected.id) setDefaultId(null)
    setDirty(true); setTestMessage(null); setSaveError(''); setNotice('配置已从草稿移除。点击“保存全部配置”后生效。')
  }
  function validateAll() {
    for (const profile of drafts) {
      const error = validateModelProfile(profile)
      if (error) { setSelectedId(profile.id); return `“${profile.name || '未命名配置'}”：${error}` }
      const previous = saved?.profiles.find(item => item.id === profile.id)
      if (!preview && previous?.keySet && (previous.provider !== profile.provider || modelEndpointIdentity(previous.baseUrl) !== modelEndpointIdentity(profile.baseUrl)) && !profile.apiKey && !profile.clearKey) { setSelectedId(profile.id); return '服务商或地址已改变，请输入新密钥，或选择清除已保存密钥。' }
    }
    return null
  }
  async function save() {
    if (!saved || busy) return
    const invalid = validateAll()
    if (invalid) { setSaveError(invalid); return }
    const token = generation.current
    setSaving(true); setSaveError(''); setNotice('')
    try {
      const value = await client.save({ profiles: drafts.map(modelProfileDraft), defaultProfileId: defaultId, revision: saved.revision })
      if (!active.current || token !== generation.current) return
      setSaved(value); setDrafts(toDrafts(value)); setDefaultId(value.defaultProfileId); setDirty(false); setTestMessage(null)
      setNotice(preview ? '示例配置已保存到本机，未保存密钥，也未调用模型。' : '全部模型配置已保存。'); onChange(value); notifySearchConfigurationChanged()
    } catch (error) { if (active.current && token === generation.current) setSaveError(errorText(error)) }
    finally { if (active.current && token === generation.current) setSaving(false) }
  }
  async function test() {
    if (!selected || preview || busy) return
    const invalid = validateModelProfile(selected)
    if (invalid) { setTestMessage({ ok: false, text: invalid }); return }
    if (!keyAvailable && selected.provider !== 'custom') { setTestMessage({ ok: false, text: '此服务商尚未配置密钥，请输入 API 密钥后测试。' }); return }
    if (endpointChanged && !selected.apiKey && !selected.clearKey) { setTestMessage({ ok: false, text: '服务商或地址已改变，请输入适用于新地址的密钥。' }); return }
    const token = generation.current
    setTesting(true); setTestMessage(null)
    try {
      const result = await client.test(modelProfileDraft(selected))
      if (active.current && token === generation.current) setTestMessage({ ok: result.ok, text: result.ok ? `连接成功 · ${result.model || selected.model} · ${Math.round(result.ms)} ms` : '连接未成功，请检查地址、模型名称和密钥后重试。' })
    } catch (error) { if (active.current && token === generation.current) setTestMessage({ ok: false, text: errorText(error) }) }
    finally { if (active.current && token === generation.current) setTesting(false) }
  }

  return <div className="ks-model-settings">
    <p className="ks-model-intro">为当前账号保存多组模型配置，供 AI 助手和研究报告使用。</p>
    {preview ? <div className="ks-model-banner" role="note"><CircleAlert size={17} /><span>演示预览：仅在本机保存非秘密配置。无法保存真实密钥或测试连接，预览不调用模型。</span></div> : <div className="ks-model-security"><ShieldCheck size={15} /><span>已保存密钥不会回显；留空保留原密钥。配置草稿在本窗口内保留。</span></div>}
    {isLoading ? <div className="ks-model-loading" role="status"><LoaderCircle size={19} className="ks-spin" />正在读取模型设置…</div> : loadError ? <div className="ks-model-error" role="alert">{loadError}<button type="button" className="ks-button" onClick={() => { setLoading(true); setLoadError(''); setLoadAttempt(value => value + 1) }}>重试加载</button></div> : <>
      <div className="ks-model-config-heading"><span>{drafts.length} / {MAX_MODEL_PROFILES} 组配置{dirty && <small> · 尚未保存</small>}</span><button type="button" className="ks-button" disabled={busy || drafts.length >= MAX_MODEL_PROFILES} onClick={addProfile}><Plus size={15} />添加模型</button></div>
      <div className="ks-model-grid">
        <nav className="ks-model-list" aria-label="模型配置列表">{drafts.map(profile => <button type="button" key={profile.id} disabled={busy} className={selectedId === profile.id ? 'is-selected' : ''} aria-label={`编辑配置：${profile.name || '未命名配置'}`} aria-current={selectedId === profile.id ? 'true' : undefined} onClick={() => { setSelectedId(profile.id); setTestMessage(null) }}><Server size={16} /><span><strong>{profile.name || '未命名配置'}</strong><small>{modelProviderLabels[profile.provider]}</small></span>{defaultId === profile.id && <Star size={13} aria-label="默认模型" />}</button>)}{!drafts.length && <div className="ks-model-empty"><Server size={24} /><p>尚未添加模型</p><small>添加服务地址和模型名称，保存后可选择使用。</small></div>}</nav>
        {selected ? <div className="ks-model-editor"><fieldset disabled={busy}><div className="ks-model-editor-heading"><h3>{selected.name || '未命名配置'}</h3><button type="button" className="ks-button" aria-label="删除当前模型配置" onClick={removeProfile}><Trash2 size={14} />删除</button></div>
          <div className="ks-model-fields"><label className="ks-field">配置名称<input value={selected.name} maxLength={80} onChange={event => update({ name: event.target.value })} placeholder="例如：研究资料分析" /></label><label className="ks-field">服务商<select value={selected.provider} onChange={event => { const provider = event.target.value as ModelProvider; update({ provider, baseUrl: modelProviderEndpoints[provider], ...(provider === 'kimi' ? { model: 'kimi-k3.1-pro' } : {}) }) }}>{Object.entries(modelProviderLabels).map(([provider, label]) => <option key={provider} value={provider}>{label}</option>)}</select></label></div>
          <label className="ks-field">服务地址<input type="url" value={selected.baseUrl} maxLength={500} onChange={event => update({ baseUrl: event.target.value })} placeholder="https://your-model-service.example/v1" autoComplete="off" spellCheck={false} /></label>
          <p className="ks-model-help">填写兼容 OpenAI 的 API 基础地址，不含 /chat/completions。MiniMax 预设为国际地址，可按账号所在地区修改。</p>
          <label className="ks-field">模型名称<input value={selected.model} maxLength={160} onChange={event => update({ model: event.target.value })} placeholder="填写服务商控制台中的完整模型名称" autoComplete="off" spellCheck={false} /></label>
          <ModelPricePicker provider={selected.provider} baseUrl={selected.baseUrl} model={selected.model} onSelect={model => update({ model })} />
          <label className="ks-field">API 密钥<input type="password" value={selected.apiKey || ''} disabled={preview || busy} maxLength={2000} onChange={event => update({ apiKey: event.target.value, clearKey: false })} placeholder={preview ? '预览不接受真实密钥' : stored?.keySet && !endpointChanged && !selected.clearKey ? '已保存；留空保持原密钥' : '输入此服务的 API 密钥'} autoComplete="new-password" spellCheck={false} /></label>
          <div className="ks-model-key-state"><KeyRound size={13} /><span>{preview ? '预览配置不包含密钥' : selected.apiKey ? '新密钥待保存' : endpointChanged ? '地址已改变，原密钥不再适用' : selected.clearKey ? '已选择清除密钥' : keyAvailable ? '密钥已保存' : selected.provider === 'custom' ? '未配置密钥；可用于无密钥的自托管服务' : '尚未配置密钥，无法向此模型提问'}</span></div>
          {endpointChanged && !preview && <p className="ks-model-warning">服务商或地址已改变，原密钥不会复用。请输入新密钥，或勾选清除密钥后保存。</p>}
          {!preview && <label className="ks-model-checkbox"><input type="checkbox" checked={!!selected.clearKey} onChange={event => update({ clearKey: event.target.checked, apiKey: undefined })} />清除已保存密钥</label>}
          <label className="ks-model-checkbox"><input type="checkbox" checked={defaultId === selected.id} onChange={event => { setDefaultId(event.target.checked ? selected.id : null); setDirty(true); setSaveError(''); setNotice('') }} />设为个人默认模型</label>
          <div className="ks-model-test"><button type="button" className="ks-button" disabled={preview || busy} onClick={() => void test()}>{testing ? <LoaderCircle className="ks-spin" size={15} /> : <Zap size={15} />}{testing ? '正在测试…' : '测试连接'}</button><small>{preview ? '预览不调用模型' : '仅发送固定短测试消息，可能消耗少量 token；测试不会保存配置。'}</small></div>
        </fieldset>{testMessage && <div className={testMessage.ok ? 'ks-model-success' : 'ks-model-error'} role={testMessage.ok ? 'status' : 'alert'}>{testMessage.ok ? <Check size={15} /> : <CircleAlert size={15} />}{testMessage.text}</div>}</div> : <div className="ks-model-start"><Server size={30} /><h3>连接你的研究模型</h3><p>可为不同服务或用途建立多组配置，再选择默认模型。</p><button type="button" className="ks-button ks-primary" disabled={busy} onClick={addProfile}><Plus size={15} />添加第一组配置</button></div>}
      </div>
      {!defaultId && drafts.length > 0 && <p className="ks-model-help">尚未设置默认模型，可在问答时选择配置。</p>}
      {saveError && <div className="ks-model-error" role="alert"><CircleAlert size={16} /><span>{saveError} 草稿仍保留。</span></div>}
      {notice && <div className="ks-model-success" role="status"><Check size={15} /><span>{notice}</span></div>}
    </>}
    <footer className="ks-model-footer"><span>{dirty ? '修改在保存后生效' : '仅对当前账号生效'}</span><button type="button" className="ks-button" onClick={onClose}>{dirty ? '取消' : '关闭'}</button><button type="button" className="ks-button ks-primary" disabled={isLoading || !!loadError || busy || !dirty} onClick={() => void save()}>{saving && <LoaderCircle className="ks-spin" size={14} />}{saving ? '正在保存…' : '保存全部配置'}</button></footer>
  </div>
}
