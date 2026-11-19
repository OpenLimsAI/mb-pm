import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import FolderImportProbeResult from './FolderImportProbeResult'

describe('server folder probe feedback', () => {
  it('shows zero readable files and groups the reason without a success indicator', () => {
    const errors = Array.from({ length: 42 }, (_, index) => ({
      relativePath: `${index}.pdf`, error: '知识源没有读取该文件的权限',
    }))
    render(<FolderImportProbeResult result={{ valid: true, fileCount: 42, totalBytes: 0, errors }} />)
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('发现 42 份 PDF，可读取 0 份。')
    expect(within(status).getAllByRole('listitem')).toHaveLength(1)
    expect(status).toHaveTextContent('知识源没有读取该文件的权限（42 份）')
    expect(status).not.toHaveClass('kso-import-probe')
  })

  it('reports partial results within the checked batch and distinguishes an empty directory', () => {
    const { rerender } = render(<FolderImportProbeResult result={{
      valid: true, fileCount: 3, totalBytes: 112, truncated: true, errors: [
        { relativePath: 'a.pdf', error: '文件为空' },
        { relativePath: 'b.pdf', error: '知识源没有读取该文件的权限' },
      ],
    }} />)
    expect(screen.getByRole('status')).toHaveTextContent('发现 3 份 PDF（本次检查范围），可读取 1 份。')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    rerender(<FolderImportProbeResult result={{ valid: true, fileCount: 0, totalBytes: 0 }} />)
    expect(screen.getByRole('status')).toHaveTextContent('此目录暂未发现 PDF')
    expect(screen.queryByRole('list')).toBeNull()
  })
})
