import { useEffect, useMemo, useRef, useState } from 'react'
import { ClipboardCheck, FileSearch, ListTree, LoaderCircle, X } from 'lucide-react'
import type { Answer, KnowledgeSource, Reference, Section, Solution, SolutionClient } from './types'
import { builtInTemplates, checkReport, outlineFromAnswer, reusableContent, searchReportSections, terminologyTitle } from './reportExperience'
import ReportMarkdown from './ReportMarkdown'
import './reportExperience.css'

export interface ReportWorkbenchToolsProps {
  doc: Solution; client: SolutionClient; onClose: () => void; onNavigate: (sectionId: string) => void
  modelProfileId?: string; allowAI?: boolean
  onInsert: (content: string, refs: Reference[], sectionId: string) => void
  onAppendSections: (sections: Section[]) => void
  onSaveTerminology?: (content: string) => void
}
export default function ReportWorkbenchTools(props: ReportWorkbenchToolsProps) { return <ReportWorkbenchToolsSession key={props.doc.id} {...props} /> }
function ReportWorkbenchToolsSession({ doc, client, modelProfileId, allowAI = true, onClose, onNavigate, onInsert, onAppendSections, onSaveTerminology }: ReportWorkbenchToolsProps) {
  const [tab, setTab] = useState<'quality' | 'reuse' | 'plan'>('quality'), [query, setQuery] = useState(''), [reports, setReports] = useState<Solution[]>([])
  const [reuseLoading, setReuseLoading] = useState(false), [sourceLoading, setSourceLoading] = useState(false), [generating, setGenerating] = useState(false), [error, setError] = useState(''), [reload, setReload] = useState(0), [target, setTarget] = useState(doc.sections[0]?.id || '')
  const [question, setQuestion] = useState(''), [sourceQuery, setSourceQuery] = useState(''), [sources, setSources] = useState<KnowledgeSource[]>([]), [chosen, setChosen] = useState<KnowledgeSource[]>([])
  const [outlineOrigin, setOutlineOrigin] = useState(''), [outline, setOutline] = useState(''), [plan, setPlan] = useState<Answer | null>(null), [template, setTemplate] = useState(builtInTemplates[0].id)
  const [preview, setPreview] = useState<string | null>(null), [step, setStep] = useState(1)
  const [termRules, setTermRules] = useState(doc.sections.find(section => section.title === terminologyTitle)?.content || '')
  const editable = doc.canEdit && doc.status === 'draft'
  const root = useRef<HTMLDivElement>(null), generation = useRef(0), generationAbort = useRef<AbortController | null>(null), mounted = useRef(false), closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current += 1; generationAbort.current?.abort() } }, [])
  useEffect(() => {
    const token = ++generation.current
    generationAbort.current?.abort(); generationAbort.current = null
    queueMicrotask(() => { if (mounted.current && generation.current === token) setGenerating(false) })
    return () => { generation.current += 1; generationAbort.current?.abort() }
  }, [client, modelProfileId, editable, allowAI])
  const cancelGeneration = () => { generation.current += 1; generationAbort.current?.abort(); generationAbort.current = null; setGenerating(false) }
  const close = () => { cancelGeneration(); closeRef.current() }
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    root.current?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { generation.current += 1; generationAbort.current?.abort(); closeRef.current() }
      if (event.key !== 'Tab') return
      const controls = Array.from(root.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href]') || [])
      if (event.shiftKey && (document.activeElement === controls[0] || document.activeElement === root.current)) { event.preventDefault(); controls.at(-1)?.focus() }
      else if (!event.shiftKey && (document.activeElement === controls.at(-1) || document.activeElement === root.current)) { event.preventDefault(); controls[0]?.focus() }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); previous?.focus() }
  }, [])
  useEffect(() => {
    if (tab !== 'reuse') return
    let active = true
    void Promise.resolve().then(async () => {
      if (!active) return
      setReuseLoading(true); setError('')
      try { const value = await client.list(); if (active) setReports(value) }
      catch (reason) { if (active) setError(reason instanceof Error ? reason.message : '报告加载失败') }
      finally { if (active) setReuseLoading(false) }
    })
    return () => { active = false }
  }, [client, tab, reload])
  useEffect(() => {
    if (tab !== 'plan') return
    let active = true
    const timer = setTimeout(() => { setSourceLoading(true); setError(''); client.sources(sourceQuery).then(value => { if (active) setSources(value) }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : '资料加载失败') }).finally(() => { if (active) setSourceLoading(false) }) }, 250)
    return () => { active = false; clearTimeout(timer) }
  }, [client, tab, sourceQuery, reload])
  const issues = useMemo(() => checkReport(doc), [doc]), matches = useMemo(() => searchReportSections(reports, query, doc.id), [reports, query, doc.id])
  async function generateOutline() {
    if (!question.trim() || generating || !editable || !allowAI || !doc.sections.length) return
    const token = ++generation.current, controller = new AbortController(), scene = builtInTemplates.find(item => item.id === template)!
    generationAbort.current?.abort(); generationAbort.current = controller
    const current = () => mounted.current && token === generation.current && !controller.signal.aborted
    setGenerating(true); setError('')
    try {
      const result = await client.ask(doc.id, { question: `围绕以下研究问题拟定研究报告大纲。仅输出一级 Markdown 标题，每行一个，不编造研究结果。研究问题：${question}`, context: `报告：${doc.title}\n场景：${scene.name}\n已选资料：${chosen.map(source => source.title).join('；')}`, sourceIds: chosen.map(source => source.id), projectName: doc.projectName, sectionId: doc.sections[0]?.id || '', modelProfileId, answerMode: chosen.length ? 'knowledge' : 'general' }, controller.signal)
      if (!current()) return
      setPlan(result)
      const headings = result.mode === 'ai' ? outlineFromAnswer(result) : []
      setOutlineOrigin(headings.length ? `当前 AI 返回的大纲建议${result.model ? ` · ${result.model}` : ''}，确认后再加入报告。` : result.mode === 'retrieval' ? '本次返回资料检索摘录，未生成 AI 大纲；已载入所选场景的模板大纲供你修改。' : 'AI 返回内容未包含可识别的大纲标题；已载入所选场景的模板大纲供你修改。')
      setOutline((headings.length ? headings : scene.sections.map(section => section.title)).join('\n'))
      setStep(3)
    } catch (reason) { if (current()) setError(reason instanceof Error ? reason.message : '大纲生成失败，请重试。') } finally { if (current()) { setGenerating(false); generationAbort.current = null } }
  }
  return <div className="ks-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close() }}><div className="ks-modal ks-modal-wide ks-workbench-tools" role="dialog" aria-modal="true" aria-label="写作工具" tabIndex={-1} ref={root}>
    <header><h2>写作工具</h2><button type="button" className="ks-button" aria-label="关闭写作工具" onClick={close}><X size={18} /></button></header>
    <nav className="ks-tools-tabs" aria-label="写作工具分类">{([['quality', '质量检查', ClipboardCheck], ['reuse', '复用历史报告', FileSearch], ['plan', '资料到报告', ListTree]] as const).map(([id, label, Icon]) => <button className="ks-button" type="button" key={id} aria-pressed={tab === id} onClick={() => { cancelGeneration(); setTab(id); setError(''); setPreview(null) }}><Icon size={15} />{label}</button>)}</nav>
    {error && <p role="alert">{error}{(tab === 'reuse' || tab === 'plan' && step === 1) && <button className="ks-button" type="button" onClick={() => setReload(value => value + 1)}>重试加载</button>}</p>}
    {tab === 'quality' && <section><p className="ks-muted">检查当前草稿中的空章节、占位内容、重复段落、引用缺失、术语写法及同名指标的数值和单位差异。结果用于辅助核对；不同实验条件下的数值差异可能合理。</p>{onSaveTerminology && <details><summary>设置报告术语规范</summary><label className="ks-field">每行：首选术语=其他写法=其他写法<textarea aria-label="报告术语规范" rows={4} maxLength={10000} value={termRules} onChange={event => setTermRules(event.target.value)} placeholder="例如：检测方法=检测法" /></label><p className="ks-muted">保存到报告的“术语与缩写规范”章节，供团队共同使用和检查。</p><button className="ks-button" type="button" disabled={!editable} onClick={() => onSaveTerminology(termRules)}>保存术语规范</button></details>}<strong>发现 {issues.length} 个待核查项</strong>{issues.length === 0 ? <p>本次规则检查未发现问题。</p> : <ol className="ks-quality-items">{issues.map(issue => <li key={issue.id}><strong>{doc.sections.find(section => section.id === issue.sectionId)?.title}</strong><p>{issue.message}</p>{issue.excerpt && <blockquote>{issue.excerpt}</blockquote>}<button type="button" className="ks-button" onClick={() => { onNavigate(issue.sectionId); close() }}>定位到章节</button></li>)}</ol>}</section>}
    {tab === 'reuse' && <section><label className="ks-field">搜索历史报告的标题、章节与正文<input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="例如：稳定性 验证" /></label><label className="ks-field">插入到<select value={target} onChange={event => setTarget(event.target.value)}>{doc.sections.map(section => <option key={section.id} value={section.id}>{section.title}</option>)}</select></label>{reuseLoading ? <p role="status">正在加载可访问的报告…</p> : !query.trim() ? <p>输入关键词查找已有内容。</p> : !matches.length ? <p>没有找到匹配的历史章节。</p> : <div className="ks-reuse-results">{matches.map(item => <article key={`${item.reportId}-${item.section.id}`}><strong>{item.section.title}</strong><small>{item.reportTitle} · v{item.version} · {item.references.length} 条依据</small><p>{item.section.content.slice(0, 200)}</p><button className="ks-button" type="button" onClick={() => setPreview(preview === `${item.reportId}-${item.section.id}` ? null : `${item.reportId}-${item.section.id}`)}>预览内容</button><button className="ks-button ks-primary" type="button" disabled={!editable || !doc.sections.some(section => section.id === target)} onClick={() => { onInsert(reusableContent(item), item.references, target); close() }}>插入并保留来源…</button>{preview === `${item.reportId}-${item.section.id}` && <ReportMarkdown>{item.section.content}</ReportMarkdown>}</article>)}</div>}</section>}
    {tab === 'plan' && <section><div className="ks-plan-steps" aria-label="报告准备步骤">{['选择资料', '明确问题', '确认大纲'].map((label, index) => <button className="ks-button" type="button" key={label} aria-pressed={step === index + 1} onClick={() => { cancelGeneration(); setStep(index + 1) }}>{index + 1}. {label}</button>)}</div>
      {step === 1 && <><label className="ks-field">查找资料<input value={sourceQuery} onChange={event => setSourceQuery(event.target.value)} placeholder="按标题或关键词搜索" /></label><p>已选 {chosen.length} 份资料</p>{chosen.map(source => <button type="button" className="ks-button" key={source.id} onClick={() => setChosen(items => items.filter(item => item.id !== source.id))}>{source.title} ×</button>)}{sourceLoading ? <p role="status">正在加载资料…</p> : <div className="ks-plan-sources">{sources.slice(0, 50).map(source => <label key={source.id}><input type="checkbox" checked={chosen.some(item => item.id === source.id)} disabled={!chosen.some(item => item.id === source.id) && chosen.length >= 100} onChange={event => setChosen(items => event.target.checked ? [...items.filter(item => item.id !== source.id), source].slice(0, 100) : items.filter(item => item.id !== source.id))} />{source.title}</label>)}</div>}<button className="ks-button ks-primary" type="button" onClick={() => setStep(2)}>下一步：明确问题</button></>}
      {step === 2 && <><label className="ks-field">报告场景<select disabled={generating} value={template} onChange={event => setTemplate(event.target.value)}>{builtInTemplates.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="ks-field">希望回答的研究问题<textarea rows={4} maxLength={2000} disabled={generating} value={question} onChange={event => setQuestion(event.target.value)} /></label><p>使用 {chosen.length} 份已选资料；研究问题和所选资料将交给当前配置的 AI 服务。</p><button className="ks-button ks-primary" type="button" disabled={generating || !question.trim() || !editable || !allowAI} onClick={() => void generateOutline()}>{generating ? <LoaderCircle size={15} className="ks-spin" /> : null}生成研究大纲</button>{generating && <button className="ks-button" type="button" onClick={cancelGeneration}>停止生成</button>}{!allowAI && <p>AI 大纲由报告作者生成；你可以使用场景大纲并参与编辑。</p>}<button className="ks-button" type="button" onClick={() => { cancelGeneration(); setOutlineOrigin('当前使用场景模板大纲，未调用 AI。'); setOutline(builtInTemplates.find(item => item.id === template)!.sections.map(section => section.title).join('\n')); setPlan(null); setStep(3) }}>使用场景大纲</button></>}
      {step === 3 && <>{outlineOrigin && <p role="status">{outlineOrigin}</p>}<label className="ks-field">确认大纲 · 每行一个章节<textarea rows={8} maxLength={3000} value={outline} onChange={event => setOutline(event.target.value)} /></label>{plan && <details><summary>查看大纲生成依据与原始回答</summary><ReportMarkdown>{plan.content}</ReportMarkdown></details>}<p>新增章节附带研究问题、写作要求、所选资料和待补充清单，逐章完成后可删除提示文字。</p><button className="ks-button ks-primary" type="button" disabled={!editable || !outline.trim()} onClick={() => { const titles = outline.split('\n').map(title => title.trim()).filter(Boolean).slice(0, 20); const scene = builtInTemplates.find(item => item.id === template)!; onAppendSections(titles.map((title, index) => ({ id: crypto.randomUUID(), title: title.slice(0, 200), content: `研究问题：${question.trim() || '待补充'}\n\n写作要求：${scene.sections[index]?.instruction || '根据研究问题整理证据，明确适用条件及待验证事项。'}\n\n已选资料：\n${chosen.map(source => `- ${source.title}`).join('\n') || '待补充'}\n\n检查项：\n- [ ] 补充原文依据与适用条件\n- [ ] 区分观察、推断和待验证事项\n` }))); close() }}>确认并添加 {Math.min(20, outline.split('\n').filter(title => title.trim()).length)} 个章节</button></>}
    </section>}
  </div></div>
}
