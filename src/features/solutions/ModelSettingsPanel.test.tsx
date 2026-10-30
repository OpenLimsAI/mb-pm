import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ModelSettingsPanel from './ModelSettingsPanel'
import { createPreviewModelClient, modelProviderEndpoints } from './modelSettings'
import type { ModelProfileDraft, ModelSettings, ModelSettingsClient, ModelSettingsInput, ModelTestResult } from './modelSettings'

const settings: ModelSettings = { revision: 3, defaultProfileId: 'first', profiles: [
  { id: 'first', name: '主要模型', provider: 'deepseek', baseUrl: modelProviderEndpoints.deepseek, model: 'configured-model', keySet: true },
  { id: 'second', name: '备用模型', provider: 'openai', baseUrl: modelProviderEndpoints.openai, model: 'other-configured-model', keySet: false },
] }
function mockClient(initial = settings): ModelSettingsClient {
  return { get: vi.fn(async () => structuredClone(initial)), save: vi.fn(async (input: ModelSettingsInput) => ({ revision: input.revision + 1, defaultProfileId: input.defaultProfileId, profiles: input.profiles.map(profile => ({ id: profile.id, name: profile.name, provider: profile.provider, baseUrl: profile.baseUrl, model: profile.model, keySet: !profile.clearKey && (!!profile.apiKey || !!initial.profiles.find(item => item.id === profile.id)?.keySet) })) })), test: vi.fn(async (profile: ModelProfileDraft) => ({ ok: true, model: profile.model, ms: 125 })) }
}
async function mount(client = mockClient(), preview = false) {
  const onChange = vi.fn(), onClose = vi.fn()
  const view = render(<ModelSettingsPanel client={client} preview={preview} onChange={onChange} onClose={onClose} />)
  await screen.findByRole('button', { name: '添加模型' })
  return { client, onChange, onClose, ...view }
}
function field(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }) }
function save() { fireEvent.click(screen.getByRole('button', { name: '保存全部配置' })) }
beforeEach(() => { localStorage.clear(); vi.restoreAllMocks() })

describe('model settings panel', () => {
  it('loads every profile without returning a saved secret and submits all edits in one save', async () => {
    const { client, onChange } = await mount()
    expect(screen.getByLabelText('API 密钥')).toHaveValue('')
    expect(screen.getByLabelText('API 密钥')).toHaveAttribute('type', 'password')
    expect(screen.getByText('密钥已保存')).toBeInTheDocument()
    field('配置名称', '改名的主要模型')
    fireEvent.click(screen.getByRole('button', { name: '编辑配置：备用模型' }))
    field('模型名称', 'updated-model')
    fireEvent.click(screen.getByRole('checkbox', { name: '设为个人默认模型' }))
    save()
    await screen.findByText('全部模型配置已保存。')
    expect(client.save).toHaveBeenCalledOnce()
    expect(client.save).toHaveBeenCalledWith({ revision: 3, defaultProfileId: 'second', profiles: [
      { id: 'first', name: '改名的主要模型', provider: 'deepseek', baseUrl: modelProviderEndpoints.deepseek, model: 'configured-model' },
      { id: 'second', name: '备用模型', provider: 'openai', baseUrl: modelProviderEndpoints.openai, model: 'updated-model' },
    ] })
    expect(onChange).toHaveBeenCalledOnce()
    expect(screen.getByLabelText('API 密钥')).toHaveValue('')
  })

  it('creates a profile with a provider endpoint but requires a manually entered model', async () => {
    const { client } = await mount(mockClient({ profiles: [], defaultProfileId: null, revision: 0 }))
    fireEvent.click(screen.getByRole('button', { name: '添加第一组配置' }))
    field('服务商', 'minimax')
    expect(screen.getByLabelText('服务地址')).toHaveValue(modelProviderEndpoints.minimax)
    expect(screen.getByLabelText('模型名称')).toHaveValue('')
    save()
    expect(await screen.findByRole('alert')).toHaveTextContent('模型名称')
    expect(client.save).not.toHaveBeenCalled()
    field('服务商', 'glm')
    expect(screen.getByLabelText('服务地址')).toHaveValue(modelProviderEndpoints.glm)
    field('配置名称', '云端模型')
    field('模型名称', 'account-enabled-model')
    save()
    await screen.findByText('全部模型配置已保存。')
    expect(client.save).toHaveBeenCalledWith(expect.objectContaining({ profiles: [expect.objectContaining({ name: '云端模型', provider: 'glm', model: 'account-enabled-model' })] }))
    expect(screen.getByText('尚未配置密钥，无法向此模型提问')).toBeInTheDocument()
  })

  it('retains names, default and the typed secret after save failure, then clears the input on success', async () => {
    const client = mockClient()
    vi.mocked(client.save).mockRejectedValueOnce(new Error('暂时无法保存 private-test-key'))
    const { onChange } = await mount(client)
    field('配置名称', '未保存的名字')
    field('API 密钥', 'private-test-key')
    save()
    expect(await screen.findByRole('alert')).toHaveTextContent('草稿仍保留')
    expect(screen.getByRole('alert')).not.toHaveTextContent('private-test-key')
    expect(screen.getByLabelText('配置名称')).toHaveValue('未保存的名字')
    expect(screen.getByLabelText('API 密钥')).toHaveValue('private-test-key')
    expect(screen.getByRole('checkbox', { name: '设为个人默认模型' })).toBeChecked()
    expect(onChange).not.toHaveBeenCalled()
    save()
    await screen.findByText('全部模型配置已保存。')
    expect(screen.getByLabelText('API 密钥')).toHaveValue('')
    expect(client.save).toHaveBeenCalledTimes(2)
    expect(localStorage.length).toBe(0)
  })

  it('never carries a typed or stored key to a changed endpoint without explicit replacement or clearing', async () => {
    const { client } = await mount()
    field('API 密钥', 'temporary-key')
    field('服务地址', 'https://new-provider.example/v1')
    expect(screen.getByLabelText('API 密钥')).toHaveValue('')
    expect(screen.getByText(/原密钥不会复用/)).toBeInTheDocument()
    save()
    expect(await screen.findByRole('alert')).toHaveTextContent('服务商或地址已改变')
    expect(client.save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    expect(client.test).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox', { name: '清除已保存密钥' }))
    save()
    await screen.findByText('全部模型配置已保存。')
    expect(client.save).toHaveBeenCalledWith(expect.objectContaining({ profiles: [expect.objectContaining({ baseUrl: 'https://new-provider.example/v1', clearKey: true }), expect.anything()] }))
    expect(vi.mocked(client.save).mock.calls[0][0].profiles[0]).not.toHaveProperty('apiKey')
    expect(screen.getByText('尚未配置密钥，无法向此模型提问')).toBeInTheDocument()
  })

  it('preserves a saved key for hostname case and trailing slash changes without sending it back', async () => {
    const { client } = await mount()
    field('服务地址', 'HTTPS://API.DEEPSEEK.COM/')
    expect(screen.queryByText(/原密钥不会复用/)).not.toBeInTheDocument()
    expect(screen.getByText('密钥已保存')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    await screen.findByText('连接成功 · configured-model · 125 ms')
    expect(vi.mocked(client.test).mock.calls[0][0]).not.toHaveProperty('apiKey')
    save()
    await screen.findByText('全部模型配置已保存。')
    expect(vi.mocked(client.save).mock.calls[0][0].profiles[0]).not.toHaveProperty('apiKey')
  })

  it('requires explicit key handling when adding a default port because the backend keeps it distinct', async () => {
    const { client } = await mount()
    field('服务地址', 'https://api.deepseek.com:443')
    expect(screen.getByText(/原密钥不会复用/)).toBeInTheDocument()
    save()
    expect(await screen.findByRole('alert')).toHaveTextContent('服务商或地址已改变')
    expect(client.save).not.toHaveBeenCalled()
  })

  it('tests only on request, retains an unsaved draft and does not mistake ok:false for success', async () => {
    const { client } = await mount()
    expect(client.test).not.toHaveBeenCalled()
    field('模型名称', 'model-to-test')
    expect(screen.getByText(/可能消耗少量 token/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    await screen.findByText('连接成功 · model-to-test · 125 ms')
    expect(client.test).toHaveBeenCalledWith({ id: 'first', name: '主要模型', provider: 'deepseek', baseUrl: modelProviderEndpoints.deepseek, model: 'model-to-test' })
    expect(client.save).not.toHaveBeenCalled()
    vi.mocked(client.test).mockResolvedValueOnce({ ok: false, model: 'model-to-test', ms: 20 })
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('连接未成功')
    expect(screen.queryByText(/连接成功/)).not.toBeInTheDocument()
    expect(screen.getByLabelText('模型名称')).toHaveValue('model-to-test')
  })

  it('deletes the default only in the draft and saves the explicit no-default state', async () => {
    const { client } = await mount()
    fireEvent.click(screen.getByRole('button', { name: '删除当前模型配置' }))
    expect(screen.queryByRole('button', { name: '编辑配置：主要模型' })).not.toBeInTheDocument()
    expect(client.save).not.toHaveBeenCalled()
    expect(screen.getByRole('checkbox', { name: '设为个人默认模型' })).not.toBeChecked()
    save()
    await screen.findByText('全部模型配置已保存。')
    expect(client.save).toHaveBeenCalledWith(expect.objectContaining({ defaultProfileId: null, profiles: [expect.objectContaining({ id: 'second' })] }))
  })

  it('disables secrets and connection tests in preview while preserving non-secret configurations across refresh', async () => {
    const client = createPreviewModelClient('preview:author'), { onChange } = await mount(client, true)
    fireEvent.click(screen.getByRole('button', { name: '添加第一组配置' }))
    expect(screen.getByLabelText('API 密钥')).toBeDisabled()
    expect(screen.getByRole('button', { name: '测试连接' })).toBeDisabled()
    expect(screen.getByRole('note')).toHaveTextContent('预览不调用模型')
    field('配置名称', '本机示例模型')
    field('模型名称', 'example-configured-model')
    save()
    await screen.findByText('示例配置已保存到本机，未保存密钥，也未调用模型。')
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ profiles: [expect.objectContaining({ keySet: false })] }))
    expect((await createPreviewModelClient('preview:author').get()).profiles[0].name).toBe('本机示例模型')
    const stored = localStorage.getItem(localStorage.key(0)!)!
    expect(stored).not.toContain('apiKey')
    expect(stored).not.toContain('clearKey')
  })

  it('offers a safe load retry and ignores late connection results after closing', async () => {
    const client = mockClient(), onChange = vi.fn()
    vi.mocked(client.get).mockRejectedValueOnce(new Error('secret provider payload'))
    const view = render(<ModelSettingsPanel client={client} preview={false} onChange={onChange} onClose={() => {}} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('无法读取模型设置')
    expect(screen.getByRole('alert')).not.toHaveTextContent('secret provider payload')
    fireEvent.click(screen.getByRole('button', { name: '重试加载' }))
    await screen.findByLabelText('配置名称')
    let resolve!: (result: ModelTestResult) => void
    vi.mocked(client.test).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    await waitFor(() => expect(client.test).toHaveBeenCalledOnce())
    expect(screen.getByLabelText('配置名称')).toBeDisabled()
    view.unmount()
    await act(async () => resolve({ ok: true, model: 'late', ms: 1 }))
    expect(onChange).not.toHaveBeenCalled()
    expect(client.save).not.toHaveBeenCalled()
  })
})
