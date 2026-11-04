import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import SmartCollections from './SmartCollections'
import ReadingQueue from './ReadingQueue'
import ResearchTools from './ResearchTools'
import type { WorkspaceState } from './workspace-v3-types'

const api = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }))
vi.mock('./v3-api', () => ({ knowledgeV3Post: api.post, knowledgeV3Get: api.get }))
const state: WorkspaceState = { revision: 2, collections: [{id: 'quality', name: '质量待读', query: {scopes: ['Q'], readingStates: ['unread']}}], rules: [{id: 'rule', name: '归档质量', query: {text: 'Quality'}, targetFolderIds: ['f'], enabled: false}], reading: {}, location: {} }
beforeEach(() => { vi.resetAllMocks() })

it('saves a dynamic collection and passes criteria to the library instead of freezing IDs', async () => {
  api.post.mockResolvedValue({...state, revision: 3})
  const changed = vi.fn(), choose = vi.fn()
  render(<SmartCollections state={state} query={{text: '稳定性', readingStates: ['unread']}} onChoose={choose} onChanged={changed} />)
  fireEvent.click(screen.getByText('质量待读'))
  expect(choose).toHaveBeenCalledWith(state.collections[0].query, 'quality')
  fireEvent.change(screen.getByLabelText('集合或规则名称'), {target: {value: '稳定性待读'}})
  fireEvent.click(screen.getByRole('button', {name: /保存当前筛选/}))
  await waitFor(() => expect(changed).toHaveBeenCalled())
  expect(api.post).toHaveBeenCalledWith('/workspace/collections', {name: '稳定性待读', query: {text: '稳定性', readingStates: ['unread']}, revision: 2})
})

it('previews a rule and requires an explicit confirmation before classification', async () => {
  api.post.mockResolvedValueOnce({total: 2, changeCount: 1, papers: [{id: 'p', title: 'Paper'}], previewDigest: 'digest'}).mockResolvedValueOnce({saved: true, count: 1, revision: 5, undoTokens: ['undo']})
  const organized = vi.fn()
  render(<SmartCollections state={state} folders={[{id: 'f', name: '研究'}]} canOrganize onChoose={vi.fn()} onChanged={vi.fn()} onOrganized={organized} />)
  fireEvent.click(screen.getByRole('button', {name: '预览匹配'}))
  await screen.findByText('Paper')
  expect(api.post).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', {name: /确认归档 1 篇/}))
  await waitFor(() => expect(organized).toHaveBeenCalledWith({saved: true, count: 1, revision: 5, undoTokens: ['undo']}))
  expect(api.post).toHaveBeenLastCalledWith('/workspace/rules/rule/apply', {previewDigest: 'digest'})
})

it('does not forward server-only rule timestamps back into the strict input schema', async () => {
  api.post.mockResolvedValue({...state, revision: 3})
  const timestamped = {...state, rules: [{...state.rules[0], createdAt: 'now', updatedAt: 'now'}]}
  render(<SmartCollections state={timestamped} folders={[{id: 'f', name: '研究'}]} canOrganize onChoose={vi.fn()} onChanged={vi.fn()} />)
  fireEvent.click(screen.getByRole('checkbox', {name: /自动归档/}))
  await waitFor(() => expect(api.post).toHaveBeenCalled())
  expect(api.post.mock.calls[0][1]).not.toHaveProperty('createdAt')
  expect(api.post.mock.calls[0][1]).toMatchObject({enabled: true, revision: 2})
})

it('keeps reading state and actual character position distinct from update read flags', async () => {
  api.post.mockResolvedValue({state: 'reading', position: {offset: 120}, versionId: 'v1'})
  const changed = vi.fn()
  render(<ReadingQueue paperId="paper" versionId="v1" position={{offset: 120}} onChanged={changed} />)
  fireEvent.click(screen.getByRole('button', {name: '记住当前阅读位置'}))
  await waitFor(() => expect(changed).toHaveBeenCalledWith({state: 'reading', position: {offset: 120}, versionId: 'v1'}))
  expect(api.post).toHaveBeenCalledWith('/workspace/reading', {paperId: 'paper', versionId: 'v1', state: 'reading', position: {offset: 120}})
})

it('does not invoke a model on opening tools, and stops applying an old result after scope changes', async () => {
  api.get.mockResolvedValue({models: [{id: 'system', name: '默认模型', available: true}], defaultModelId: 'system'})
  api.post.mockResolvedValue({answer: '结论 [E1]', mode: 'classify', citations: ['E1'], suggestions: [{paperId: 'p1', folderIds: ['f'], reason: '研究质量', evidenceIds: ['E1']}], evidence: [{id: 'E1', paperId: 'p1', title: 'First', hash: 'abcdef', excerpts: [{offset: 8, length: 5, text: 'source'}]}], cached: false, createdAt: '2026-11-04T10:00:00Z', cost: null, usage: {totalTokens: 30}})
  const apply = vi.fn(), open = vi.fn()
  const props = {paperIds: ['p1'], folders: [{id: 'f', name: '质量'}], canOrganize: true, onApplyClassification: apply, onOpenEvidence: open}
  const {rerender} = render(<ResearchTools {...props} />)
  expect(api.get).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', {name: /基于所选资料研究/}))
  await screen.findByRole('option', {name: '默认模型'})
  expect(api.post).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('研究方式'), {target: {value: 'classify'}})
  fireEvent.click(screen.getByRole('button', {name: '开始研究'}))
  await screen.findByText('研究质量')
  expect(screen.getByText(/费用未计量/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', {name: '定位正文第 9 字符'}))
  expect(open).toHaveBeenCalledWith('p1', 8)
  rerender(<ResearchTools {...props} paperIds={['p2']} />)
  expect(screen.getByRole('button', {name: '确认加入建议文件夹'})).toBeDisabled()
  expect(apply).not.toHaveBeenCalled()
})

it('shows actual research receipts and unknown token use without a fabricated zero price', async () => {
  const { default: SourceInsights } = await import('./SourceInsights')
  const data = {papers: [], folders: [], sources: [], jobs: [], documents: [], catalogRevision: 0, canManage: true, canOrganize: true, starred: [], integration: {status: 'ready', message: ''}, resources: {researchRequests: 3, confirmedModelResponses: 1, unconfirmedModelRequests: 2, modelTokens: null, modelTokenReceiptsMissing: 3, modelCost: null, indexCost: null}}
  render(<SourceInsights data={data} busy={false} mutate={vi.fn()} />)
  expect(screen.getByLabelText('AI研究实际回执')).toHaveTextContent('AI研究请求3')
  expect(screen.getByLabelText('AI研究实际回执')).toHaveTextContent('尚无模型回执2')
  expect(screen.getByLabelText('AI研究实际回执')).toHaveTextContent('已回执 Token未计量')
  expect(screen.getByText(/AI 研究费用尚无费用回执，显示未计量/)).toBeInTheDocument()
  expect(screen.queryByText('¥0')).not.toBeInTheDocument()
})
