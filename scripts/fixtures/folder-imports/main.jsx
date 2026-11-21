// Development-only fixture. Every Axios request stays in this synthetic adapter.
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Outlet, Route, Routes } from 'react-router-dom'
import axios from 'axios'
import '../../../src/index.css'
import '../../../src/components/ui/workbenchLink.css'
import '../../../src/styles/efficient-workspace.css'
import '../../../src/styles/forest-theme.css'
import '../../../src/styles/forest-applications.css'
import '../../../src/styles/forest-shell.css'
import '../../../src/styles/blue-workspace.css'

let folders = [{ id: 'topic', name: '上游工艺开发', writable: true, kind: 'topic' }, { id: 'analysis', name: '分析方法与质量表征', writable: true, kind: 'topic' }, { id: 'ich', name: 'ICH', writable: true, kind: 'source' }, { id: 'inbox', name: '待整理', systemRole: 'inbox', writable: true, kind: 'topic' }]
const base = { path: '', folderId: 'topic', includeSubfolders: true, preserveHierarchy: false, schedule: { frequency: 'daily', time: '08:00', timezone: 'Asia/Shanghai', weekday: 0 }, maxFileMb: 100, maxFilesPerScan: 1000, dailyFileLimit: 1000, paused: false, nextScanAt: '2026-11-18T00:00:00Z' }
let tasks = [
  { ...base, id: 'task-server', name: '研究资料自动归档', kind: 'server', serverRootId: 'root', path: 'papers', sourcePath: '研究共享目录 / papers', folderName: '上游工艺开发', status: 'processing', lastScanAt: '2026-11-17T00:00:00Z', lastResult: { new: 3, updated: 1, completed: 7, failed: 1, unchanged: 6 } },
  { ...base, id: 'task-local', name: '我的论文下载文件夹', kind: 'local', sourcePath: '/Users/demo/Downloads/论文', folderId: 'inbox', folderName: '待整理', connectorOnline: false, status: 'offline' },
]
const camel = value => Array.isArray(value) ? value.map(camel) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), camel(entry)])) : value
const names = ['Stability Testing of New Drug Substances and Products.pdf', 'Validation of Analytical Procedures.pdf', 'Analytical Procedure Development.pdf', 'Quality Risk Management.pdf', 'Pharmaceutical Quality System.pdf', 'Development and Manufacture of Drug Substances.pdf', 'Biotechnological Products Stability.pdf', 'Impurities in New Drug Substances.pdf', 'Residual Solvents.pdf', 'Pharmaceutical Development.pdf']
const run = { id: 'run-demo', taskId: 'task-server', status: 'processing', phase: 'index', total: 10, processed: 8, completed: 7, failed: 1, new: 3, updated: 1, unchanged: 6, initial: true, createdAt: '2026-11-17T00:00:00Z' }
const items = names.map((relativePath, i) => ({ id: `item-${i}`, relativePath, size: 1200000, status: i === 9 ? 'failed' : i < 7 ? 'completed' : 'processing', phase: i < 7 ? 'done' : i === 7 ? 'parse' : 'index', originalSaved: true, indexStatus: i < 7 ? 'ready' : i === 9 ? 'failed' : 'pending', change: 'new', ...(i === 9 ? { error: '索引暂不可用，原件已保存，可单独重试。' } : {}) }))
// All examples below are synthetic UI data, not an imported ICH corpus.
const codes = ['Q1A(R2)', 'Q2(R2)', 'Q14', 'Q9(R1)', 'Q10', 'Q11', 'Q5C', 'Q3A(R2)', 'Q3C(R9)', 'Q8(R2)']
let revision = 1
let papers = names.map((name, i) => ({
  id: `sources/fixture-paper-${i + 1}.md`, path: `sources/fixture-paper-${i + 1}.md`, title: name.replace(/\.pdf$/, ''),
  code: codes[i], sourceId: 'ich-source', sourceName: 'ICH', folderIds: i < 4 ? ['ich', 'topic'] : i < 8 ? ['ich', 'analysis'] : ['inbox'],
  saved: true, indexStatus: i === 9 ? 'pending' : 'ready', parseStatus: 'ready', documentId: `doc-${i + 1}`, versionId: `version-${i + 1}`,
  size: 1200000 + i * 40000, createdAt: new Date(Date.now() - i * 3600000).toISOString(), type: 'Guideline', language: 'en', year: '2026',
  authors: ['ICH'], tags: [{ id: i % 2 ? 'quality' : 'stability', name: i % 2 ? '质量研究' : '稳定性' }],
  abstract: '这段摘要为界面演示内容，用于展示资料信息、分类与阅读操作，不是官方指南正文。',
}))
let starred = [papers[0].id, papers[3].id]
let workspace = { revision: 1, collections: [], rules: [], reading: {}, location: { folderId: 'all', query: '', offset: 0, scrollTop: 0 } }
let sources = [{ id: 'ich-source', name: 'ICH 官方指导原则', url: 'https://www.ich.org/page/quality-guidelines', scopes: ['Q', 'S', 'E', 'M'], folderId: 'ich', archiveFolderId: 'ich', frequency: 'manual', enabled: true, adapter: 'ich', status: 'ready', lastCheckedAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), error: null, scopeStatus: Object.fromEntries(['Q', 'S', 'E', 'M'].map(scope => [scope, { status: 'success', count: scope === 'Q' ? 10 : 1 }])), schedule: { frequency: 'off', downloadUpdates: false, indexUpdates: false } }]
let documents = [...papers.map((paper, i) => ({ id: paper.documentId, sourceId: 'ich-source', title: `${paper.code} · ${paper.title}`, url: 'https://www.ich.org/page/quality-guidelines', scopes: ['Q'], folderIds: paper.folderIds, format: 'pdf', language: 'en', documentType: 'Guideline', officialStatus: 'Step 4', officialDate: '2026-01-01', discoveredAt: paper.createdAt, status: 'saved', versionStatus: 'current', isNew: false, unread: false, versions: [{ id: paper.versionId, sha256: `synthetic-${i}`, size: paper.size, createdAt: paper.createdAt, parseStatus: 'ready', indexStatus: paper.indexStatus }] })),
  ...[['S', 'S6(R1)', 'Preclinical Safety Evaluation of Biotechnology-Derived Pharmaceuticals'], ['E', 'E6(R3)', 'Good Clinical Practice'], ['M', 'M4', 'Common Technical Document']].map(([scope, code, title], i) => ({ id: `new-doc-${i}`, sourceId: 'ich-source', title: `${code} · ${title}`, url: 'https://www.ich.org/page/ich-guidelines', scopes: [scope], folderIds: [], format: 'pdf', language: 'en', documentType: 'Guideline', officialStatus: 'Step 4', discoveredAt: new Date().toISOString(), status: 'discovered', versionStatus: 'not_saved', isNew: true, unread: true, versions: [] }))]
let jobs = [{ id: 'job-completed', sourceId: 'ich-source', folderId: 'ich', kind: 'download', parse: true, status: 'completed', createdAt: new Date(Date.now() - 3600000).toISOString(), updatedAt: new Date().toISOString(), total: 4, processed: 4, saved: 4, failed: 0, pending: 0, summary: { new: 4, ready: 4 }, items: documents.slice(0, 4).map(document => ({ documentId: document.id, status: 'saved', versionId: document.versions[0].id, phase: 'done' })) }]
const tagCatalog = [{ id: 'stability', name: '稳定性' }, { id: 'quality', name: '质量研究' }]
const folderCounts = () => Object.fromEntries(folders.map(folder => [folder.id, papers.filter(paper => paper.folderIds.includes(folder.id)).length]))
const snapshot = () => ({ papers, folders, sources, jobs, documents, catalogRevision: revision, canManage: true, canOrganize: true, canEdit: true, starred, libraryV3: true, libraryTotal: papers.length, folderCounts: folderCounts(), tags: tagCatalog, changes: [], integration: { status: 'ready', message: '合成资料 · 未连接真实知识库' } })
const detailText = paper => `${paper.title}\n\n界面预览资料\n以下内容仅用于验证页内阅读、选择和归档等交互，不是官方指南正文。\n\n研究背景\n在药物研发中，需要系统整理实验观察、质量研究记录与参考文献，并保留资料来源与版本信息。\n\n资料整理\n用户可以将同一篇资料归类到多个文件夹；按标题、分类或共享标签检索，然后在页面中阅读。\n\n使用示例\n先阅读资料，再勾选需要整理的文件，选择拷贝到文件夹或移动到文件夹。`
window.__folderImportFixtureRequests = []
const scenario = new URLSearchParams(window.location.search).get('scenario')
const fixtureRoot = scenario === 'unreadable'
  ? { id: 'root', name: 'USP_EP', displayPath: '/srv/research/USP_EP' }
  : { id: 'root', name: '研究共享目录', displayPath: '/srv/research' }
const fixtureRoots = scenario === 'unreadable' ? [fixtureRoot] : [fixtureRoot, { id: 'archive', name: '存档', displayPath: '/srv/archive' }]
const fixtureDirectories = scenario === 'unreadable'
  ? { root: { '': ['USP', '欧洲药典'], USP: [], 欧洲药典: [] } }
  : {
    root: { '': ['papers', 'USP_EP'], papers: ['2026'], 'papers/2026': [], USP_EP: ['USP', '欧洲药典'], 'USP_EP/USP': [], 'USP_EP/欧洲药典': [] },
    archive: { '': ['培训'], 培训: ['欧洲药典'], '培训/欧洲药典': [] },
  }
let snapshotRequests = 0, importBootstrapRequests = 0
axios.defaults.adapter = async config => {
  const rawPath = `${config.baseURL || ''}${config.url || ''}`
  const path = rawPath.split('?')[0]
  window.__folderImportFixtureRequests.push({ method: config.method, path: rawPath })
  if (scenario === 'retry' && (path.endsWith('/snapshot') && ++snapshotRequests === 2 ||
      path.endsWith('/folder-imports/bootstrap') && ++importBootstrapRequests === 1)) {
    throw new axios.AxiosError('测试连接中断', 'ERR_NETWORK', config)
  }
  const body = typeof config.data === 'string' ? camel(JSON.parse(config.data)) : config.data || {}
  let data
  if (path.endsWith('/snapshot')) data = snapshot()
  else if (path.endsWith('/jobs/status')) data = { jobs, refreshedAt: new Date().toISOString() }
  else if (path.endsWith('/workspace')) data = workspace
  else if (path.endsWith('/workspace/location')) { workspace.location = { ...workspace.location, ...body }; data = workspace }
  else if (path.endsWith('/workspace/reading')) { const entry = { state: body.state || 'reading', position: body.position || {}, versionId: body.versionId, updatedAt: new Date().toISOString() }; workspace.reading[body.paperId] = entry; data = entry }
  else if (path.endsWith('/workspace/duplicates')) data = { groups: [] }
  else if (path.endsWith('/library/query')) {
    const term = (body.query || '').toLocaleLowerCase()
    const batch = body.folderId?.startsWith('batch:') ? jobs.find(job => job.id === body.folderId.slice(6)) : null
    const result = papers.filter(paper => (!body.folderId || ['all', 'recent'].includes(body.folderId) || body.folderId === 'starred' && starred.includes(paper.id) || batch && batch.items.some(item => item.versionId === paper.versionId) || paper.folderIds.includes(body.folderId)) && (!term || `${paper.title} ${paper.code} ${paper.tags.map(tag => tag.name).join(' ')}`.toLocaleLowerCase().includes(term)) && (!body.type || paper.type === body.type) && (!body.indexStatus || paper.indexStatus === body.indexStatus) && (!body.tagIds?.length || body.tagIds.every(id => paper.tags.some(tag => tag.id === id))) && (!body.readingStatus || (workspace.reading[paper.id]?.state || 'unread') === body.readingStatus))
    if (body.sort === 'title') result.sort((a, b) => a.title.localeCompare(b.title))
    const offset = body.offset || 0, limit = body.limit || 50
    data = { papers: result.slice(offset, offset + limit).map(paper => ({ ...paper, reading: workspace.reading[paper.id] })), total: result.length, offset, limit, nextOffset: offset + limit < result.length ? offset + limit : null, revision, folderCounts: folderCounts(), tags: tagCatalog, searchIndex: { indexing: false, complete: true, indexed: papers.length, total: papers.length, failed: 0 } }
  }
  else if (path.endsWith('/library/detail')) { const paper = papers.find(paper => paper.id === body.paperId); if (!paper) throw new Error('Synthetic paper does not exist'); const text = detailText(paper); data = { paper, text, textOffset: 0, totalCharacters: text.length, canWrite: true, revision, metadataRevision: revision, insightRevision: revision, references: [], positionUnit: 'utf16' } }
  else if (path.endsWith('/library/metadata')) { papers = papers.map(paper => paper.id === body.paperId ? { ...paper, ...body.metadata } : paper); revision++; data = { saved: true } }
  else if (path.endsWith('/library/tags')) {
    const results = body.paperIds.map(paperId => ({ paperId, saved: papers.some(paper => paper.id === paperId) }))
    papers = papers.map(paper => body.paperIds.includes(paper.id)
      ? { ...paper, tags: [...paper.tags, ...body.tags.filter(name => !paper.tags.some(tag => tag.name === name)).map(name => ({ id: name, name }))] }
      : paper)
    revision++
    data = { savedCount: results.filter(item => item.saved).length, results }
  }
  else if (path.endsWith('/library/delete-preview')) { const paper = papers.find(paper => paper.id === body.paperId); data = { planId: `fixture-delete-${paper.id}`, path: paper.id, title: paper.title, expiresAt: new Date(Date.now() + 600000).toISOString(), pages: [], sharedCount: 0, unverifiedCount: 0 } }
  else if (path.endsWith('/library/delete')) { papers = papers.filter(paper => paper.id !== body.paperId); revision++; data = { operationId: body.planId, path: body.paperId, status: 'succeeded', completed: 1, total: 1 } }
  else if (path.endsWith('/papers/folders')) { papers = papers.map(paper => body.paperIds.includes(paper.id) ? { ...paper, folderIds: [...new Set([...paper.folderIds.filter(id => id !== 'inbox' && (body.mode !== 'move' && body.mode !== 'remove' || id !== body.fromFolderId)), ...body.folderIds])]} : paper); papers = papers.map(paper => paper.folderIds.length ? paper : { ...paper, folderIds: ['inbox'] }); revision++; data = { saved: true } }
  else if (path.endsWith('/folders') && config.method === 'post') { folders = [...folders, { id: `fixture-folder-${folders.length}`, name: body.name, parentId: body.parentId || null, kind: 'topic', writable: true }]; revision++; data = { saved: true } }
  else if (path.endsWith('/stars')) { starred = body.enabled ? [...new Set([...starred, body.paperId])] : starred.filter(id => id !== body.paperId); data = { saved: true } }
  else if (path.endsWith('/changes/read')) { documents = documents.map(document => body.documentIds.includes(document.id) ? { ...document, unread: false } : document); data = { saved: true } }
  else if (/\/sources\/[^/]+$/.test(path) && config.method === 'patch') { sources = sources.map(source => source.id === path.split('/').pop() ? { ...source, ...body } : source); data = { saved: true } }
  else if (/\/sources\/[^/]+\/(check|verify)$/.test(path)) { sources = sources.map(source => ({ ...source, lastCheckedAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString() })); data = { saved: true } }
  else if (path.endsWith('/jobs') && config.method === 'post') { const id = `fixture-job-${jobs.length}`, selected = documents.filter(document => body.documentIds.includes(document.id)); jobs = [...jobs, { id, sourceId: body.sourceId, folderId: body.folderId || 'ich', kind: 'download', parse: body.parse, status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), total: selected.length, processed: 0, saved: 0, failed: 0, pending: selected.length, items: selected.map(document => ({ documentId: document.id, status: 'pending', phase: 'download' })) }]; data = { jobId: id } }
  else if (/\/jobs\/[^/]+\/control$/.test(path)) { jobs = jobs.map(job => job.id === path.split('/').at(-2) ? { ...job, status: body.action === 'cancel' ? 'cancelled' : body.action === 'pause' ? 'paused' : 'queued' } : job); data = { saved: true } }
  else if (path.endsWith('/bootstrap')) data = { tasks, roots: new URLSearchParams(window.location.search).get('roots') === 'empty' ? [] : fixtureRoots, canWrite: true, workerEnabled: true, maxFileMb: 100, connectorOnlineSeconds: 90 }
  else if (path.endsWith('/directories/search')) {
    const query = (config.params.q || '').trim().toLocaleLowerCase()
    const directories = Object.entries(fixtureDirectories).flatMap(([rootId, entries]) =>
      Object.keys(entries).filter(entry => query && entry.split('/').at(-1).toLocaleLowerCase().includes(query))
        .map(entry => ({ rootId, path: entry })))
    data = { directories, truncated: false }
  }
  else if (path.endsWith('/directories')) {
    const directories = fixtureDirectories[config.params.root_id]
    if (!directories || !Object.hasOwn(directories, config.params.path)) throw new Error('目录不可访问')
    const query = (config.params.q || '').toLocaleLowerCase()
    data = { directories: directories[config.params.path].filter(name => name.toLocaleLowerCase().includes(query)), truncated: false }
  }
  else if (path.endsWith('/probe')) data = scenario === 'unreadable' ? {
    valid: true, fileCount: 42, totalBytes: 0,
    errors: Array.from({ length: 42 }, (_, i) => ({ relativePath: `测试资料-${i + 1}.pdf`, error: '没有读取该文件的权限' })),
  } : { valid: true, fileCount: 10, totalBytes: 12000000 }
  else if (path.endsWith('/tasks') && config.method === 'post') { const task = { ...body, id: `task-new-${tasks.length}`, status: body.kind === 'local' ? 'offline' : 'queued', paused: false }; tasks = [...tasks, task]; data = { task } }
  else if (/\/tasks\/[^/]+$/.test(path) && config.method === 'patch') { const id = path.split('/').pop(); tasks = tasks.map(task => task.id === id ? { ...task, ...body } : task); data = { task: tasks.find(task => task.id === id) } }
  else if (/\/tasks\/[^/]+$/.test(path) && config.method === 'delete') { const id = path.split('/').pop(); tasks = tasks.filter(task => task.id !== id); data = { deleted: true } }
  else if (path.endsWith('/pairing')) data = { code: 'DEMO-ONLY-1234', expiresAt: new Date(Date.now() + 600000).toISOString() }
  else if (/\/tasks\/[^/]+\/runs$/.test(path)) data = { runs: path.includes('task-local') ? [] : [run] }
  else if (/\/runs\/[^/]+$/.test(path)) data = { run, items }
  else if (/\/(scan|pause|resume|retry|read)$/.test(path)) { const id = path.split('/').at(-2); tasks = tasks.map(task => task.id === id ? { ...task, paused: path.endsWith('/pause'), status: path.endsWith('/pause') ? 'paused' : 'processing' } : task); data = { task: tasks.find(task => task.id === id), run } }
  else if (path.endsWith('/watches')) data = { items: [] }
  else if (path.endsWith('/digest')) data = { days: 7, new: 0, updated: 0, unread: 0, items: [] }
  else throw new Error(`Fixture blocks unsupported API: ${rawPath}`)
  return { data: structuredClone(data), status: 200, statusText: 'OK', headers: {}, config }
}
window.fetch = async () => { throw new Error('Fixture blocks fetch requests') }
const { default: KnowledgeSourceApp } = await import('../../../src/features/knowledge-sources/KnowledgeSourceApp')
const context = { preview: false, identityNamespace: 'fixture-workspace-v2', user: { id: 'fixture', username: 'fixture', displayName: '界面核对' }, applications: [{ id: 'knowledge-sources', enabled: true }], refresh: async () => {}, logout: () => {} }
function Shell() { return <><div className="ks-simple-preview-notice">界面核对 · 所有资料与连接码均为合成内容，未连接真实知识库</div><Outlet context={context} /></> }
const entry = new URL(window.location.href)
if (!['view', 'folder', 'paper', 'source', 'document', 'job'].some(key => entry.searchParams.has(key))) { entry.searchParams.set('folder', 'all'); window.history.replaceState({}, '', entry) }
createRoot(document.getElementById('root')).render(<BrowserRouter><Routes><Route element={<Shell />}><Route path="*" element={<KnowledgeSourceApp />} /></Route></Routes></BrowserRouter>)
window.__folderImportFixtureReady = true
