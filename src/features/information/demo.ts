import type { InformationDocument, InformationSnapshot, InformationSource } from './api'

// 首版只体验交互。此模块没有 HTTP、模型、采集或知识库写入能力。
const CREATED = '2026-10-22T08:00:00Z'
const rows = [
  ['q9', 'Q9(R1)', '质量风险管理', 'Q'], ['e6', 'E6(R3)', '临床试验质量管理规范', 'E'], ['s1', 'S1B(R1)', '药物致癌性评价', 'S'],
  ['m4', 'M4', '通用技术文件 CTD', 'M'], ['q2', 'Q2(R2)', '分析方法验证', 'Q'], ['m8', 'M8', '电子通用技术文件 eCTD', 'M'],
  ['q1', 'Q1', '稳定性研究资料', 'Q'], ['s2', 'S2(R1)', '遗传毒性试验', 'S'], ['e8', 'E8(R1)', '临床研究的一般考虑', 'E'], ['m7', 'M7(R2)', '致突变杂质评价', 'M'], ['m9', 'M9', '基于 BCS 的生物豁免', 'M'],
]
const officialPath: Record<string, string> = { Q: 'quality-guidelines', S: 'safety-guidelines', E: 'efficacy-guidelines', M: 'multidisciplinary-guidelines' }
export function demoSeed(): InformationSnapshot {
  const documents: InformationDocument[] = rows.map(([id, code, title, scope], index) => ({ id, sourceId: 'ich', title: `${code} · ${title}`, scopes: [scope], folderIds: index < 6 ? ['ich-folder'] : [], url: `https://www.ich.org/page/${officialPath[scope]}`, format: 'PDF', language: '英文', documentType: '正文', discoveredAt: CREATED, status: index < 6 ? id === 'm4' ? 'archived' : 'ready' : 'discovered', error: id === 'm4' ? '演示：新版解析失败，知识问答仍使用已完成索引的上一版。' : null, versions: index < 6 ? ['02', '01'].map((version, versionIndex) => ({ id: version, sha256: `demo-${id}-content-version-${version}`, size: 142000 + index * 2600 + (1 - versionIndex) * 1200, createdAt: versionIndex ? '2026-10-18T08:00:00Z' : CREATED, parseStatus: id === 'm4' && version === '02' ? 'error' : 'ready', indexStatus: id === 'm4' && version === '02' ? 'pending' : 'ready', error: id === 'm4' && version === '02' ? '演示：解析服务超时，原文已保存。' : null })) : [] }))
  const source: InformationSource = { id: 'ich', name: 'ICH 官方指导原则', url: 'https://www.ich.org', scopes: ['Q', 'S', 'E', 'M'], folderId: 'ich-folder', frequency: 'daily', enabled: true, adapter: 'ich', status: 'partial', lastCheckedAt: CREATED, lastSuccessAt: '2026-10-21T08:00:00Z', error: null, scopeStatus: Object.fromEntries(Object.keys(officialPath).map(scope => [scope, { status: scope === 'M' ? 'error' : 'ok', count: documents.filter(doc => doc.scopes.includes(scope)).length, lastSuccessAt: scope === 'M' ? '2026-10-21T08:00:00Z' : CREATED, error: scope === 'M' ? '演示：M 类目录检查超时，不能判断是否有更新。' : null, url: `https://www.ich.org/page/${officialPath[scope]}` }])) }
  const changeRows = [
    ['q9', '正文与问答修订', '同一指南的正文和关联问答一起变化，合并为一条演示记录。', '原正文说明与关联问答。', '正文说明调整，关联问答增加一项说明。'],
    ['e6', '关联附件新增', '新增关联问答，附件独立保存，正文保持不变。', '指导原则正文已收录。', '增加关联 Q&A，记录与正文的关系。'],
    ['s1', '官方状态变化', '来源页状态信息变化，未重复保存内容相同的正文。', '此前采集的状态字段。', '来源页补充新的状态信息，正文未改变。'],
    ['m4', '新文件待解析', '新版原文已保存，解析待重试。', '采集版 01 可供问答。', '采集版 02 已保存，尚未完成解析。'],
    ['q2', '正文修订', '新旧演示版本分别保留。', '原有说明和参考条目。', '说明段落调整，更新关联参考。'],
    ['m8', '链接迁移', '只有链接变化，文件内容相同。', '原下载地址。', '新下载地址，原文内容一致。'],
  ]
  return { user: { id: '', username: '', displayName: '' }, canManage: true, sources: [source], documents, events: changeRows.map(([id, kind, summary, before, after], index) => ({ id, title: `${documents.find(doc => doc.id === id)?.title} · ${kind}`, kind, createdAt: index < 4 ? CREATED : '2026-10-21T08:00:00Z', sourceId: 'ich', documentId: id, read: index > 3, summary, before, after })), runs: [{ id: 'demo-run', sourceId: 'ich', kind: 'monitor', status: 'partial', startedAt: CREATED, finishedAt: CREATED, error: '演示：M 类来源检查超时；与资料解析状态分别记录。' }], jobs: [], folders: [{ id: 'ich-folder', name: 'ICH', url: '/information/library', writable: true }], follows: ['document:q9', 'document:e6'], integration: { status: 'demo', message: '界面体验 · 全部为演示数据。真实采集、知识库同步和 AI 尚未接入；操作只影响此账号在本机的演示状态。', kbUrl: '' }, cost: { modelCalls: 0, message: '未调用真实模型，无实际费用账单。' }, later: [], note: '待确认：近期指南变化是否需要更新我的资料检查清单？', digest: '每日汇总', minor: false }
}

export function demoStorageKey(namespace?: string) { return namespace && /^[a-f0-9]{64}$/i.test(namespace) ? `mberp:information-demo:v1:${window.location.origin}:${namespace}` : null }
const text = (value: unknown, max = 5000): value is string => typeof value === 'string' && value.length <= max
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 200 && value.every(item => text(item, 200))
const optionalText = (value: unknown, max = 5000) => value == null || text(value, max)
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000000000
const scopes = (value: unknown) => strings(value) && value.every(scope => Object.hasOwn(officialPath, scope))
function scopeRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.entries(value).every(([key, raw]) => {
    if (!Object.hasOwn(officialPath, key) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return false
    const item = raw as Record<string, unknown>
    return text(item.status, 100) && optionalText(item.lastSuccessAt) && optionalText(item.error) && optionalText(item.url, 2000) && (item.count == null || number(item.count))
  })
}
function validState(value: unknown): value is InformationSnapshot {
  if (!value || typeof value !== 'object') return false
  const data = value as InformationSnapshot
  if (![data.sources, data.documents, data.events, data.jobs, data.folders, data.runs].every(list => Array.isArray(list) && list.length <= 200)) return false
  if (!strings(data.follows) || !strings(data.later) || !text(data.note, 800) || !['每日汇总', '即时提醒', '暂停提醒'].includes(data.digest) || typeof data.minor !== 'boolean') return false
  if (!data.sources.every(item => item && text(item.id, 100) && text(item.name, 100) && text(item.url, 2000) && optionalText(item.folderId, 100) && ['daily', 'weekly'].includes(item.frequency) && ['ich', 'unsupported'].includes(item.adapter) && text(item.status, 100) && typeof item.enabled === 'boolean' && scopes(item.scopes) && scopeRecord(item.scopeStatus) && optionalText(item.error) && optionalText(item.lastCheckedAt) && optionalText(item.lastSuccessAt))) return false
  if (!data.documents.every(item => item && text(item.id, 100) && rows.some(row => row[0] === item.id) && text(item.sourceId, 100) && scopes(item.scopes) && strings(item.folderIds) && text(item.title, 500) && text(item.url, 2000) && text(item.format, 100) && text(item.language, 100) && text(item.documentType, 100) && text(item.status, 100) && optionalText(item.error) && text(item.discoveredAt) && Array.isArray(item.versions) && item.versions.length <= 20 && item.versions.every(version => version && text(version.id, 100) && text(version.sha256, 100) && number(version.size) && text(version.createdAt) && text(version.parseStatus, 100) && text(version.indexStatus, 100) && optionalText(version.error) && optionalText(version.archiveUrl, 2000)))) return false
  if (!data.events.every(item => item && text(item.id, 100) && text(item.title, 500) && text(item.kind, 100) && text(item.sourceId, 100) && optionalText(item.documentId, 100) && text(item.createdAt) && typeof item.read === 'boolean' && optionalText(item.summary) && optionalText(item.before) && optionalText(item.after))) return false
  if (!data.folders.every(item => text(item.id, 100) && text(item.name, 60) && text(item.url, 2000) && typeof item.writable === 'boolean')) return false
  if (!data.runs.every(item => item && text(item.id, 100) && text(item.sourceId, 100) && text(item.kind, 100) && text(item.status, 100) && text(item.startedAt) && optionalText(item.finishedAt) && optionalText(item.error) && (item.details == null || (typeof item.details === 'object' && !Array.isArray(item.details) && optionalText(item.details.jobId, 100) && (item.details.scopeStatus == null || scopeRecord(item.details.scopeStatus)))))) return false
  if (!data.jobs.every(job => job && text(job.id, 100) && text(job.sourceId, 100) && text(job.folderId, 100) && typeof job.parse === 'boolean' && text(job.createdAt) && text(job.updatedAt) && optionalText(job.error) && ['running', 'paused', 'completed', 'cancelled'].includes(job.status) && [job.total, job.processed, job.saved, job.failed, job.pending].every(number => Number.isSafeInteger(number) && number >= 0 && number <= 200) && Array.isArray(job.items) && job.items.length === job.total && job.processed <= job.total && job.items.every(item => item && text(item.documentId, 100) && rows.some(row => row[0] === item.documentId) && text(item.status, 100) && optionalText(item.error) && optionalText(item.versionId, 100)))) return false
  return true
}
export function restoreDemo(key: string | null): InformationSnapshot {
  const seed = demoSeed()
  if (!key) return seed
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw || raw.length > 1000000) return seed
    const saved: unknown = JSON.parse(raw)
    if (!validState(saved)) return seed
    const clean = saved as InformationSnapshot
    return { ...clean, user: seed.user, canManage: true, integration: seed.integration, cost: seed.cost, jobs: clean.jobs.map(job => job.status === 'running' ? { ...job, status: 'paused' } : job) }
  } catch { return seed }
}
export function persistDemo(key: string | null, data: InformationSnapshot) { if (!key) return; try { window.localStorage.setItem(key, JSON.stringify({ ...data, user: { id: '', username: '', displayName: '' } })) } catch { /* 隐私模式或空间不足时继续使用内存状态。 */ } }

function id() { return `demo-${crypto.randomUUID()}` }
function limitHistory(data: InformationSnapshot) { return { ...data, runs: data.runs.slice(-200), events: data.events.slice(0, 200), jobs: data.jobs.slice(-200) } }
function publicUrl(value: string) {
  const url = new URL(value)
  const host = url.hostname.toLowerCase()
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /^localhost$|\.localhost$|\.local$|^127\.|^10\.|^192\.168\.|^169\.254\.|^0\.|^172\.(1[6-9]|2\d|3[01])\.|^\[/.test(host)) throw new Error('请填写有效的公开官方网站地址。')
  return url
}
export function demoMutation(current: InformationSnapshot, path: string, body: Record<string, unknown>): InformationSnapshot {
  const data = structuredClone(current)
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent)
  const now = new Date().toISOString()
  if (segments[0] === 'reset') return demoSeed()
  if (segments[0] === 'sources') {
    const source = data.sources.find(item => item.id === segments[1])
    if (segments.length === 1) {
      if (data.sources.length >= 100) throw new Error('演示来源已达到 100 个，请重置演示后继续。')
      const url = publicUrl(String(body.url))
      if (data.sources.some(item => new URL(item.url).host === url.host)) throw new Error('演示来源已存在，请在该来源中调整设置。')
      data.sources.push({ id: id(), name: String(body.name).slice(0, 100), url: url.href, scopes: body.scopes as string[], frequency: String(body.frequency || 'daily'), folderId: typeof body.folderId === 'string' ? body.folderId : null, enabled: false, adapter: 'unsupported', status: 'unsupported', scopeStatus: {} })
    } else if (!source) throw new Error('找不到演示来源。')
    else if (segments[2] === 'check') {
      if (source.adapter !== 'ich') throw new Error('该来源尚未适配，不能执行演示检查。')
      source.status = 'ok'; source.lastCheckedAt = now; source.lastSuccessAt = now
      for (const scope of source.scopes) source.scopeStatus[scope] = { ...source.scopeStatus[scope], status: 'ok', lastSuccessAt: now, error: null }
      data.runs.push({ id: id(), sourceId: source.id, kind: 'discovery', status: 'ok', startedAt: now, finishedAt: now, error: null })
    } else {
      if (source.adapter === 'unsupported' && body.enabled === true) throw new Error('待适配来源不能开启演示监控。')
      if (typeof body.enabled === 'boolean') source.enabled = body.enabled
      if (Array.isArray(body.scopes)) source.scopes = body.scopes as string[]
      if (body.frequency) source.frequency = String(body.frequency)
      if ('folderId' in body) source.folderId = typeof body.folderId === 'string' ? body.folderId : null
    }
  } else if (segments[0] === 'events') {
    const event = data.events.find(item => item.id === segments[1])
    if (event) event.read = typeof body.read === 'boolean' ? body.read : true
  } else if (segments[0] === 'later') {
    data.later = data.later.includes(segments[1]) ? data.later.filter(item => item !== segments[1]) : [...data.later, segments[1]]
  } else if (segments[0] === 'preferences') {
    if (typeof body.note === 'string') data.note = body.note.slice(0, 800)
    if (typeof body.digest === 'string') data.digest = body.digest
    if (typeof body.minor === 'boolean') data.minor = body.minor
  } else if (segments[0] === 'follows') {
    data.follows = body.enabled ? [...new Set([...data.follows, segments[1]])] : data.follows.filter(item => item !== segments[1])
  } else if (segments[0] === 'documents' && segments[2] === 'retry') {
    const doc = data.documents.find(item => item.id === segments[1])
    if (doc) { doc.status = 'ready'; doc.error = null; for (const version of doc.versions) { version.parseStatus = 'ready'; version.indexStatus = 'ready'; version.error = null } }
  } else if (segments[0] === 'jobs' && segments.length === 1) {
    if (data.jobs.some(job => job.status === 'running')) throw new Error('请先完成或暂停当前演示任务。')
    let folderId = String(body.folderId || '')
    if (typeof body.newFolder === 'string' && body.newFolder.trim()) { const name = body.newFolder.trim().slice(0, 60); const existing = data.folders.find(folder => folder.name === name); if (!existing && data.folders.length >= 100) throw new Error('演示文件夹已达到 100 个，请重置演示后继续。'); folderId = existing?.id || id(); if (!existing) data.folders.push({ id: folderId, name, url: '/information/library', writable: true }) }
    const documentIds = [...new Set(body.documentIds as string[])].filter(documentId => data.documents.some(doc => doc.id === documentId))
    if (!documentIds.length || !data.folders.some(folder => folder.id === folderId)) throw new Error('请选择演示文件及目标文件夹。')
    data.jobs.push({ id: id(), sourceId: String(body.sourceId), folderId, parse: body.parse !== false, status: 'running', createdAt: now, updatedAt: now, total: documentIds.length, processed: 0, saved: 0, failed: 0, pending: documentIds.length, items: documentIds.map(documentId => ({ documentId, status: 'pending', error: null })) })
  } else if (segments[0] === 'jobs') {
    const job = data.jobs.find(item => item.id === segments[1])
    if (!job) throw new Error('演示任务不存在。')
    if (body.action === 'pause') job.status = 'paused'
    if (body.action === 'cancel') job.status = 'cancelled'
    if (body.action === 'resume' || body.action === 'retry') {
      if (data.jobs.some(item => item.id !== job.id && item.status === 'running')) throw new Error('已有其他演示任务执行中，请先暂停。')
      job.status = 'running'
      if (body.action === 'retry') { for (const item of job.items) if (['download-failed', 'parse-failed'].includes(item.status)) { item.status = 'retry-pending'; item.error = null } }
    }
  }
  return limitHistory(data)
}

export function demoTick(current: InformationSnapshot): InformationSnapshot {
  if (!current.jobs.some(job => job.status === 'running')) return current
  const data = structuredClone(current), now = new Date().toISOString()
  for (const job of data.jobs.filter(item => item.status === 'running')) {
    const item = job.items.find(candidate => ['pending', 'retry-pending'].includes(candidate.status))
    if (item) {
      const doc = data.documents.find(candidate => candidate.id === item.documentId)
      const retry = item.status === 'retry-pending', parse = job.parse
      item.error = null
      if (!doc) { item.status = 'download-failed'; item.error = '演示资料不存在。' }
      else if (doc.id === 'm9' && !retry) { item.status = 'download-failed'; item.error = '演示：下载失败，原文尚未保存，可仅重试失败项。' }
      else if (doc.versions.length && !retry) { item.status = doc.folderIds.includes(job.folderId) ? 'skipped' : 'linked'; doc.folderIds = [...new Set([...doc.folderIds, job.folderId])] }
      else {
        doc.folderIds = [...new Set([...doc.folderIds, job.folderId])]
        const parseFailed = doc.id === 'm7' && !retry && parse
        doc.status = parseFailed || !parse ? 'archived' : 'ready'; doc.error = parseFailed ? '演示：原文已保存，但解析服务超时。' : null
        if (!doc.versions.length) doc.versions.push({ id: '01', sha256: `demo-${doc.id}-version01`, size: 154000, createdAt: now, parseStatus: parseFailed ? 'error' : parse ? 'ready' : 'not_requested', indexStatus: parseFailed || !parse ? 'pending' : 'ready', error: doc.error })
        else if (retry) for (const version of doc.versions) { version.parseStatus = parse ? 'ready' : 'not_requested'; version.indexStatus = parse ? 'ready' : 'pending'; version.error = null }
        item.status = parseFailed ? 'parse-failed' : parse ? 'ready' : 'stored'; item.error = doc.error; item.versionId = doc.versions[0]?.id
      }
    }
    job.processed = job.items.filter(item => !['pending', 'retry-pending'].includes(item.status)).length
    job.saved = job.items.filter(item => ['ready', 'stored', 'parse-failed', 'skipped', 'linked'].includes(item.status)).length
    job.failed = job.items.filter(item => ['download-failed', 'parse-failed'].includes(item.status)).length
    job.pending = job.total - job.processed; job.updatedAt = now
    if (!job.pending) { job.status = 'completed'; data.runs.push({ id: id(), sourceId: job.sourceId, kind: 'import', status: job.failed ? 'partial' : 'ok', startedAt: job.createdAt, finishedAt: now, error: job.failed ? `演示：${job.failed} 个失败项待处理。` : null }); data.events.unshift({ id: id(), title: `演示收录任务结束 · 已保存 ${job.saved} / ${job.total}`, kind: '演示收录汇总', createdAt: now, sourceId: job.sourceId, read: false }) }
  }
  return limitHistory(data)
}
