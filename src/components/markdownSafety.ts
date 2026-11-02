export function safeMarkdownLink(value: string | undefined): string | undefined {
  if (!value || [...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 || char === '\\')) return undefined
  if (value.startsWith('/') && !value.startsWith('//')) return value
  if (value.startsWith('#')) return value
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? value : undefined
  } catch { return undefined }
}
