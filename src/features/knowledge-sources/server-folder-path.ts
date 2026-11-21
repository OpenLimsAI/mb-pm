import type { FolderImportRoot } from './folder-import-api'

/** displayPath names the server location, which can differ from the service's mount point. */
export function serverFolderLocation(root: FolderImportRoot, relativePath: string) {
  if (!root.displayPath) return [root.name, relativePath].filter(Boolean).join('/')
  const base = root.displayPath.replace(/\/+$/, '')
  return relativePath ? `${base}/${relativePath}` : base || '/'
}

export type ServerSelection = { root: FolderImportRoot; path: string }
type Resolution = { selection: ServerSelection; error?: never } | { selection?: never; error: string }

function invalidPathCharacters(input: string) {
  return input.includes('\\') || input.includes(':') || [...input].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
}

export function resolveServerFolder(input: string, roots: FolderImportRoot[], selected?: FolderImportRoot): Resolution {
  if (invalidPathCharacters(input)) {
    return { error: '请输入服务器上的文件夹路径，层级之间用 / 分隔。' }
  }
  const absolute = input.startsWith('/')
  const path = input.replace(/\/+$/, '') || (absolute ? '/' : '')
  if (input.startsWith('//') || path.split('/').some(part => part === '.' || part === '..')) {
    return { error: '请直接选择已连接共享目录中的文件夹。' }
  }
  let root = selected
  let relative = path
  if (absolute) {
    const candidates = roots.filter(entry => {
      if (!entry.displayPath?.startsWith('/')) return false
      const base = entry.displayPath.replace(/\/+$/, '')
      return path === base || path.startsWith(base + '/')
    })
    if (!candidates.length) {
      return { error: roots.some(entry => entry.displayPath)
        ? '该路径不在已连接的共享目录中。请核对服务器路径或选择文件夹。'
        : '此共享目录未提供服务器完整路径。请选择文件夹或输入相对路径。' }
    }
    // When roots overlap, keep the narrowest configured boundary. Prefer the current alias on a tie.
    const longest = Math.max(...candidates.map(entry => entry.displayPath!.replace(/\/+$/, '').length))
    const matches = candidates.filter(entry => entry.displayPath!.replace(/\/+$/, '').length === longest)
    root = matches.find(entry => entry.id === selected?.id) || matches[0]
    relative = path.slice(longest).replace(/^\//, '')
  }
  if (!root) return { error: '请粘贴完整路径，或先选择共享目录再输入相对路径。' }
  if (relative.length > 1500 || relative && relative.split('/').some(part => !part || part.startsWith('.'))) {
    return { error: '请选择共享目录中可见的文件夹，并检查路径是否正确。' }
  }
  return { selection: { root, path: relative } }
}

interface FolderMatches {
  matches: ServerSelection[]
  complete?: ServerSelection
  error?: string
}

// Resolve typed paths on the same registered roots that the server will check on save.
export function matchServerFolders(input: string, roots: FolderImportRoot[]): FolderMatches {
  const query = input.trim()
  if (!query) return { matches: [] }
  if (query.startsWith('/')) {
    const { selection, error } = resolveServerFolder(query, roots)
    return selection ? { matches: [selection], complete: selection } : { matches: [], error }
  }

  const separator = query.indexOf('/')
  const alias = (separator >= 0 ? query.slice(0, separator) : query).toLowerCase()
  if (separator >= 0) {
    const qualified = roots.filter(root => [root.name, root.id].some(name => name.toLowerCase() === alias))
    const relative = query.slice(separator + 1)
    if (relative.startsWith('/')) return { matches: [], error: '请检查文件夹路径。' }
    const matches: ServerSelection[] = []
    for (const root of qualified) {
      const { selection, error } = resolveServerFolder(relative, roots, root)
      if (!selection) return { matches: [], error }
      matches.push(selection)
    }
    if (!matches.length) return { matches, error: '该路径不在已连接的共享目录中。请核对文件夹名称或粘贴完整路径。' }
    return { matches, complete: matches.length === 1 ? matches[0] : undefined }
  }

  if (query.startsWith('.') || invalidPathCharacters(query)) {
    return { matches: [], error: '请输入文件夹名称或服务器上的完整路径。' }
  }
  const matches = roots.filter(root => [root.name, root.id, root.displayPath?.split('/').filter(Boolean).pop()]
    .some(name => name?.toLowerCase().includes(alias))).map(root => ({ root, path: '' }))
  return { matches }
}
