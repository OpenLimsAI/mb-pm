import { polishChangeGroups } from './polishDiff'
import type { TextChange } from './polishDiff'
import './polishDiffReview.css'

function layoutFragment(text: string): string {
  if (!text) return '此处无内容'
  if (text.trim()) return text
  const lines = (text.match(/\r?\n/g) || []).length
  const spaces = text.replace(/\r?\n/g, '').length
  return [lines && `${lines} 个换行`, spaces && `${spaces} 个空白字符`].filter(Boolean).join('、')
}

export default function PolishDiffReview({ changes, rejected, onToggle, onAcceptAll }: {
  changes: TextChange[]
  rejected: ReadonlySet<number>
  onToggle: (index: number) => void
  onAcceptAll: () => void
}) {
  const groups = polishChangeGroups(changes)
  const label = groups.text.length
    ? `${groups.text.length} 处文字修改${groups.layout.length ? ` · ${groups.layout.length} 处排版调整` : ''}`
    : groups.layout.length ? '仅排版调整' : '文字未变化'
  return <div className="ks-polish-diff" aria-label="AI 修改前后对比">
    <header><strong>{label}</strong><button type="button" className="ks-button" onClick={onAcceptAll}>采纳全部建议</button></header>
    {groups.text.length > 0 && <p className="ks-polish-diff-help">红色为原文，绿色为建议。可逐处保留原文，确认后点击“替换选中文字”写入报告。</p>}
    {!groups.text.length && groups.layout.length > 0 && <p className="ks-polish-layout-note">只调整了空行或间距，没有实质文字修改。下方预览保留完整结果，确认后才写入报告。</p>}
    {!groups.text.length && !groups.layout.length && <p className="ks-polish-layout-note">建议与选中原文相同。</p>}
    {groups.text.map(index => {
      const part = changes[index]
      return <div key={index} data-kept={rejected.has(index)}>
        <del>{part.before || '（此处新增内容）'}</del><ins>{part.after || '（建议删除此处内容）'}</ins>
        <button type="button" className="ks-button" aria-pressed={rejected.has(index)} onClick={() => onToggle(index)}>{rejected.has(index) ? '已保留原文 · 改为采纳' : '保留此处原文'}</button>
      </div>
    })}
    {groups.layout.length > 0 && <details className="ks-polish-layout-details">
      <summary>查看排版调整（{groups.layout.length} 处）</summary>
      <p>空白用换行或空白字符数量标明。仍可逐处保留原排版；所有选择会反映到下方预览。</p>
      {groups.layout.map((index, order) => <div className="ks-polish-layout-change" key={index} data-kept={rejected.has(index)}>
        <strong>排版调整 {order + 1}</strong>
        <div><span>原排版</span><pre>{layoutFragment(changes[index].before)}</pre></div>
        <div><span>建议排版</span><pre>{layoutFragment(changes[index].after)}</pre></div>
        <button type="button" className="ks-button" aria-pressed={rejected.has(index)} onClick={() => onToggle(index)}>{rejected.has(index) ? '已保留原排版 · 改为采纳' : '保留此处原排版'}</button>
      </div>)}
    </details>}
  </div>
}
