import type { KnowledgeReference } from './client'

export default function KnowledgeSources({ sources, onSource }: { sources: KnowledgeReference[]; onSource?: (path: string, offset?: number) => void }) {
  return <details className="aa-knowledge-sources"><summary>查看本轮知识库来源</summary>{sources.map(source => <section key={source.path}>
    <button type="button" className="aa-button" onClick={() => onSource?.(source.path)}>{source.title} · {source.cited ? '回答中提到此路径' : source.kind === 'read' ? '已阅读' : source.kind === 'retrieved' ? '检索命中' : '目录条目'}</button>
    {source.cited && <p className="aa-field-help">路径匹配仅说明回答提到了此来源，请对照片段核实具体表述。</p>}
    {source.excerpts?.map((excerpt, index) => <div className="aa-source-excerpt" key={`${excerpt.kind}:${excerpt.offset}:${index}`}><p>{excerpt.kind === 'read' ? '本轮读取片段' : '检索命中片段'}{excerpt.offset !== null ? ` · 提取正文第 ${excerpt.offset + 1}–${excerpt.offset + excerpt.length} 字符` : ' · 未提供原文字符位置'}</p><blockquote>{excerpt.text}</blockquote>{excerpt.offset !== null && <button type="button" className="aa-button" onClick={() => onSource?.(source.path, excerpt.offset!)}>定位原文</button>}</div>)}
  </section>)}</details>
}
