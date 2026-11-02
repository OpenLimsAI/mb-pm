export interface MaterialPart { id: string; title: string; content: string; start: number; end: number }
// Split at headings / paragraphs and retain exact character locations in parsed text.
export function materialSections(text: string): MaterialPart[] {
  const parts: MaterialPart[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + 6000, text.length)
    const boundary = text.lastIndexOf('\n\n', end)
    if (end < text.length && boundary > start + 1000) end = boundary + 2
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
    const content = text.slice(start, end), title = content.split('\n').find(line => line.trim())?.replace(/^#+\s*/, '').slice(0, 70) || `片段 ${parts.length + 1}`
    parts.push({ id: String(start), title, content, start, end }); start = end
  }
  return parts
}
export function selectedMaterial(name: string, parts: MaterialPart[], selected: string[]) {
  return parts.filter(part => selected.includes(part.id)).map(part => `[资料：${name} · 提取正文第 ${part.start + 1}–${part.end} 字]\n\n${part.content}`).join('\n\n')
}
