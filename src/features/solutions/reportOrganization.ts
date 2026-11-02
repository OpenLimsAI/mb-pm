import type { Section, Solution } from './types'
export function chapterDescendants(sections: Section[], id: string): Set<string> {
  const ids = new Set([id]); let changed = true
  while (changed) { changed = false; for (const section of sections) if (section.parentId && ids.has(section.parentId) && !ids.has(section.id)) { ids.add(section.id); changed = true } }
  return ids
}
export function chapterDepth(sections: Section[], id: string): number {
  const seen = new Set<string>(); let item = sections.find(s => s.id === id), depth = 0
  while (item?.parentId && !seen.has(item.parentId)) { seen.add(item.parentId); item = sections.find(s => s.id === item!.parentId); if (item) depth++ }
  return Math.min(depth, 5)
}
export function moveChapter(sections: Section[], id: string, targetId: string): Section[] {
  const ids = chapterDescendants(sections,id), target = sections.find(s => s.id === targetId)
  if (!target || ids.has(targetId)) return sections
  const moving = sections.filter(s => ids.has(s.id)).map(s => s.id === id ? { ...s, parentId: target.parentId || null } : s)
  const rest = sections.filter(s => !ids.has(s.id)), index = rest.findIndex(s => s.id === targetId)
  const next = [...rest.slice(0,index), ...moving, ...rest.slice(index)]
  if (next.some(section => { let current: Section | undefined = section, depth = 0; const seen = new Set<string>(); while(current?.parentId) { if(seen.has(current.parentId) || ++depth > 5)return true; seen.add(current.parentId);current=next.find(item=>item.id===current!.parentId) } return false })) return sections
  return next
}
export function filterReports(reports: Solution[], query: string, project: string, tag: string, sort: string): Solution[] {
  return reports.filter(s => (!project || s.projectName === project) && (!tag || s.tags?.includes(tag)) && `${s.title} ${s.projectName} ${s.productName} ${(s.tags || []).join(' ')}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a,b) => Number(!!b.pinned)-Number(!!a.pinned) || (sort === 'title' ? a.title.localeCompare(b.title,'zh-CN') : b.updatedAt.localeCompare(a.updatedAt)))
}
export interface ReportCursor { sectionId: string; from: number; to: number; text: string; content: string }
export function insertionRange(content: string, sectionId: string, mode: string, cursor: ReportCursor | null): {from:number;to:number} {
  if (mode === 'end') return {from:content.length,to:content.length}
  if (!cursor || cursor.sectionId !== sectionId || cursor.content !== content || cursor.from < 0 || cursor.to < cursor.from || cursor.to > content.length || content.slice(cursor.from,cursor.to) !== cursor.text) throw new Error('正文或选区已变化，请重新选择插入位置。')
  if ((mode === 'after' || mode === 'replace') && cursor.from === cursor.to) throw new Error('请先选中文字。')
  return {from:mode === 'after' ? cursor.to : cursor.from,to:mode === 'replace' ? cursor.to : mode === 'after' ? cursor.to : cursor.from}
}
