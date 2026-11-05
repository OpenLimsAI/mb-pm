import { fireEvent, render, screen } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'
import { AISettingsPanel } from './AISettingsPanel'
import { server } from '../../test/setup'

const legacyProviders = {
  deepseek: { base_url: 'https://api.deepseek.com', model: 'named-shared-model', key_set: true },
  minimax: { base_url: 'https://api.minimaxi.com/v1', model: '', key_set: false },
  kimi: { base_url: 'https://api.moonshot.cn/v1', model: '', key_set: false },
  ollama: { base_url: 'http://127.0.0.1:11434', model: '', key_set: false },
}
function setup(provider: string) {
  const settings = { provider, providers: { ...legacyProviders, ...(provider in legacyProviders ? {} : { [provider]: { base_url: 'https://model.example/v1', model: 'shared-default-model', key_set: true } }) }, offline_fallback: false, analysis_prompt: '原项目提示', finance_analysis_prompt: '原财务提示', default_analysis_prompt: '默认项目提示', default_finance_analysis_prompt: '默认财务提示' }
  const writes: Record<string, unknown>[] = []
  server.use(
    http.get('*/api/v1/ai/settings', () => HttpResponse.json(settings)),
    http.put('*/api/v1/ai/settings', async ({ request }) => {
      const body = await request.json() as Record<string, unknown>
      writes.push(body)
      return HttpResponse.json({ ...settings, analysis_prompt: body.analysis_prompt, finance_analysis_prompt: body.finance_analysis_prompt })
    }),
  )
  render(<AISettingsPanel />)
  return writes
}

describe('legacy project AI settings with a shared registry', () => {
  it.each(['openai', 'custom', 'glm'])('shows a %s shared default and saves only prompts without changing it', async provider => {
    const writes = setup(provider)
    await screen.findByLabelText('项目分析提示词')
    expect(screen.getByRole('region', { name: '当前组织共享默认模型' })).toHaveTextContent('shared-default-model')
    expect(screen.getByRole('link', { name: '打开统一 AI 模型设置' })).toHaveAttribute('href', '/model-settings')
    expect(screen.queryByLabelText('项目分析使用')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('项目分析提示词'), { target: { value: '调整项目提示' } })
    fireEvent.click(screen.getByRole('button', { name: /保存设置/ }))
    await screen.findByText('提示词已保存；组织共享模型和默认选择未改变。')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ provider: 'deepseek', providers: {}, preserve_shared_models: true, analysis_prompt: '调整项目提示', finance_analysis_prompt: '原财务提示' })
    expect(screen.getByRole('region', { name: '当前组织共享默认模型' })).toHaveTextContent('shared-default-model')
  })

  it('also preserves a named shared default when only the prompt changes for a legacy provider', async () => {
    const writes = setup('deepseek')
    await screen.findByLabelText('财务分析提示词')
    fireEvent.change(screen.getByLabelText('财务分析提示词'), { target: { value: '调整财务提示' } })
    fireEvent.click(screen.getByRole('button', { name: /保存设置/ }))
    await screen.findByText('提示词已保存；组织共享模型和默认选择未改变。')
    expect(writes[0]).toMatchObject({ providers: {}, preserve_shared_models: true, finance_analysis_prompt: '调整财务提示' })
  })

  it('sends only supported legacy slots after an explicit model edit', async () => {
    const writes = setup('deepseek')
    await screen.findByLabelText('模型名称')
    fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'explicit-new-model' } })
    fireEvent.click(screen.getByRole('button', { name: /保存设置/ }))
    await screen.findByText('共享模型设置已保存，项目分析将使用此配置。')
    expect(writes[0]).toMatchObject({ provider: 'deepseek', preserve_shared_models: false, providers: { deepseek: { model: 'explicit-new-model' } } })
    expect(Object.keys(writes[0].providers as object).sort()).toEqual(['deepseek', 'kimi', 'minimax', 'ollama'])
  })
})
