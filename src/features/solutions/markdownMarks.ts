import Bold from '@tiptap/extension-bold'
import Italic from '@tiptap/extension-italic'
import Strike from '@tiptap/extension-strike'

/** Empty inline spans separate CommonMark delimiters without changing visible text.
 * Comments cannot be used here: at the beginning of a paragraph they start an HTML block.
 */
export const MARKDOWN_MARK_BOUNDARY = '<span></span>'

export function markdownMark(content: string, delimiter: '**' | '*' | '~~', plainText: string): string {
  const text = plainText.trim()
  const before = /^[\p{P}\p{S}]/u.test(text) ? MARKDOWN_MARK_BOUNDARY : ''
  const after = /[\p{P}\p{S}]$/u.test(text) ? MARKDOWN_MARK_BOUNDARY : ''
  return `${before}${delimiter}${content}${delimiter}${after}`
}

export const MarkdownBold = Bold.extend({
  renderMarkdown(node, helpers, context) {
    return markdownMark(helpers.renderChildren(node), '**', context.meta?.markText ?? '')
  },
})

export const MarkdownItalic = Italic.extend({
  renderMarkdown(node, helpers, context) {
    return markdownMark(helpers.renderChildren(node), '*', context.meta?.markText ?? '')
  },
})

export const MarkdownStrike = Strike.extend({
  renderMarkdown(node, helpers, context) {
    return markdownMark(helpers.renderChildren(node), '~~', context.meta?.markText ?? '')
  },
})
