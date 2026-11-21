import type { Page } from './types'

type RequestPage = { page: number; pageSize: number; consistent: true }

/** Read a whole scoped list. Reject a changed membership or order instead of displaying partial data. */
export async function readCompleteList<T extends { id: string }>(
  read: (params: RequestPage) => Promise<Page<T>>,
  pageSize: number,
): Promise<T[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const first = await read({ page: 1, pageSize, consistent: true })
    const { total, snapshot, pageSize: effectiveSize } = first.meta
    const rows = new Map<string, T>()
    const addPage = (value: Page<T>, page: number) => {
      if (value.meta.page !== page || value.meta.total !== total
        || value.meta.pageSize !== effectiveSize || value.meta.snapshot !== snapshot
        || value.items.length !== Math.max(0, Math.min(effectiveSize, total - (page - 1) * effectiveSize))) return false
      for (const row of value.items) {
        if (rows.has(row.id)) return false
        rows.set(row.id, row)
      }
      return true
    }

    if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(effectiveSize)
      || effectiveSize < 1 || (total > effectiveSize && !snapshot) || !addPage(first, 1)) continue
    const pages = Math.ceil(total / effectiveSize)
    for (let page = 2; page <= pages; page++) {
      if (!addPage(await read({ page, pageSize: effectiveSize, consistent: true }), page)) break
    }
    if (rows.size === total) return [...rows.values()]
  }
  throw new Error('同步期间列表发生变化，未替换已有数据，请重试。')
}
