import { describe, expect, it } from 'vitest'
import { continueEditorList, formatEditorText, preserveSelectionWhitespace } from './editorFormatting'

describe('report text formatting', () => {
  it('keeps selected paragraph separators and indentation when polish trims the snippet', () => {
    expect(preserveSelectionWhitespace('\n  原文\n\n', ' 建议文字 ')).toBe('\n  建议文字\n\n')
    expect(preserveSelectionWhitespace('pH 5.5 [1]', '  pH 5.5 [1]  ')).toBe('pH 5.5 [1]')
  })
  it('wraps a selection and keeps it selected for toggling the format off', () => {
    const bold = formatEditorText('研究目标：验证', 5, 7, 'bold')
    expect(bold).toEqual({ value: '研究目标：**验证**', start: 7, end: 9 })
    expect(formatEditorText(bold.value, bold.start, bold.end, 'bold')).toEqual({ value: '研究目标：验证', start: 5, end: 7 })
  })
  it('selects a placeholder at an empty caret and preserves emoji boundaries', () => {
    expect(formatEditorText('🧪研究', 2, 4, 'italic')).toEqual({ value: '🧪*研究*', start: 3, end: 5 })
    expect(formatEditorText('', 0, 0, 'bold')).toEqual({ value: '**文字**', start: 2, end: 4 })
  })
  it('formats full selected lines without including the following unselected line', () => {
    const list = formatEditorText('前文\n观察一\n观察二\n后文', 3, 11, 'list')
    expect(list.value).toBe('前文\n- 观察一\n- 观察二\n后文')
    expect(formatEditorText(list.value, list.start, list.end, 'list').value).toBe('前文\n观察一\n观察二\n后文')
  })
  it('handles the beginning of an empty first line and headings within a document', () => {
    expect(formatEditorText('\n正文', 0, 0, 'quote').value).toBe('> \n正文')
    expect(formatEditorText('前文\n研究目标\n后文', 5, 5, 'heading').value).toBe('前文\n## 研究目标\n后文')
  })
  it('continues unordered, numbered and quoted lines at the caret', () => {
    expect(continueEditorList('- 观察', 4, 4)).toEqual({ value: '- 观察\n- ', start: 7, end: 7 })
    expect(continueEditorList('9. 观察', 5, 5)?.value).toBe('9. 观察\n10. ')
    expect(continueEditorList('> 原文', 4, 4)?.value).toBe('> 原文\n> ')
  })
  it('leaves an empty list and does not intercept plain paragraphs or selected text', () => {
    expect(continueEditorList('- 观察\n- ', 7, 7)).toEqual({ value: '- 观察\n', start: 5, end: 5 })
    expect(continueEditorList('正文', 2, 2)).toBeNull()
    expect(continueEditorList('- 观察', 2, 4)).toBeNull()
  })
})
