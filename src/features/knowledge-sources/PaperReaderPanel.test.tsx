import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PaperReaderPanel from './PaperReaderPanel'
import type { KnowledgeSourceSnapshot } from './api'
import * as v3Api from './v3-api'
import type { LibraryPaper, PaperDetail } from './v3-api'

vi.mock('./PdfReader', () => ({
  default: ({ url, title }: { url: string; title: string }) => (
    <div data-testid="mock-pdf-reader" data-url={url}>
      PDF 预览：{title}
    </div>
  ),
}))

vi.mock('./PaperMetadataEditor', () => ({ default: () => null }))
vi.mock('./SharedPaperTags', () => ({ default: () => null }))
vi.mock('./SourceInsights', () => ({ PaperVersions: () => null }))
vi.mock('./SourceWatchPanel', () => ({ VersionChangePanel: () => null }))
vi.mock('./PaperActions', () => ({ default: () => null }))
vi.mock('./ManualIndexPanel', () => ({ default: () => null }))

const baseSnapshot: KnowledgeSourceSnapshot = {
  papers: [],
  folders: [],
  sources: [],
  jobs: [],
  documents: [],
  catalogRevision: 1,
  canManage: true,
  canOrganize: true,
  starred: [],
  integration: { status: 'connected', message: '' },
}

const makePaper = (overrides: Partial<LibraryPaper> = {}): LibraryPaper => ({
  id: 'sources/ich-q1a.md',
  title: 'ICH Q1A Stability Guideline',
  folderIds: [],
  saved: true,
  indexStatus: 'ready',
  originalUrl: '/api/v1/knowledge-sources/v3/library/original?paperId=sources%2Fich-q1a.md',
  kbUrl: 'http://localhost:1234/knowledge-base/?paper=sources%2Fich-q1a.md',
  ...overrides,
})

const makeDetail = (paper: LibraryPaper, overrides: Partial<PaperDetail> = {}): PaperDetail => ({
  paper,
  text: 'Stability testing of new drug substances and products.',
  textOffset: 0,
  totalCharacters: 54,
  originalUrl: paper.originalUrl,
  kbUrl: paper.kbUrl,
  canWrite: true,
  ...overrides,
})

describe('PaperReaderPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('defaults to PDF original, places PDF button first, labels text as 解析文本, and opens KB links in new tabs with icon', async () => {
    const paper = makePaper()
    vi.spyOn(v3Api, 'knowledgeV3Post').mockResolvedValue(makeDetail(paper))

    render(
      <PaperReaderPanel
        paper={paper}
        data={baseSnapshot}
        query=""
        onClose={vi.fn()}
        onNext={vi.fn()}
        onPrevious={vi.fn()}
        canNext={false}
        canPrevious={false}
        onChanged={vi.fn()}
      />,
    )

    const pdfButton = screen.getByRole('button', { name: 'PDF 原件' })
    const textButton = screen.getByRole('button', { name: '解析文本' })
    expect(pdfButton.compareDocumentPosition(textButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(pdfButton.className).toContain('primary')
    expect(textButton.className).not.toContain('primary')

    await waitFor(() => {
      expect(screen.getByTestId('mock-pdf-reader')).toBeInTheDocument()
    })

    const kbLink = screen.getByRole('link', { name: '在知识库阅读' })
    const bilingualLink = screen.getByRole('link', { name: '中英对照阅读' })
    expect(kbLink).toHaveAttribute('target', '_blank')
    expect(kbLink).toHaveAttribute('rel', 'noopener noreferrer')
    expect(kbLink.querySelector('svg')).not.toBeNull()
    expect(bilingualLink).toHaveAttribute('target', '_blank')
    expect(bilingualLink).toHaveAttribute('rel', 'noopener noreferrer')
    expect(bilingualLink.querySelector('svg')).not.toBeNull()
    expect(bilingualLink.getAttribute('href')).toContain('bilingual=1')

    fireEvent.click(textButton)
    expect(textButton.className).toContain('primary')
    expect(screen.getByText(/Stability testing of new drug substances/)).toBeInTheDocument()
  })

  it('switches to PDF original when originalUrl arrives asynchronously from detail response', async () => {
    const paper = makePaper({ originalUrl: undefined })
    const detail = makeDetail(paper, {
      originalUrl: '/api/v1/knowledge-sources/v3/library/original?paperId=sources%2Fich-q1a.md',
    })
    vi.spyOn(v3Api, 'knowledgeV3Post').mockResolvedValue(detail)

    render(
      <PaperReaderPanel
        paper={paper}
        data={baseSnapshot}
        query=""
        onClose={vi.fn()}
        onNext={vi.fn()}
        onPrevious={vi.fn()}
        canNext={false}
        canPrevious={false}
        onChanged={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('mock-pdf-reader')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'PDF 原件' }).className).toContain('primary')
    expect(screen.getByRole('button', { name: '解析文本' }).className).not.toContain('primary')
  })

  it('opens parsed text first when jumping from a full-text search hit with initialOffset', async () => {
    const paper = makePaper()
    vi.spyOn(v3Api, 'knowledgeV3Post').mockResolvedValue(makeDetail(paper))

    render(
      <PaperReaderPanel
        paper={paper}
        data={baseSnapshot}
        query="Stability"
        initialOffset={0}
        onClose={vi.fn()}
        onNext={vi.fn()}
        onPrevious={vi.fn()}
        canNext={false}
        canPrevious={false}
        onChanged={vi.fn()}
      />,
    )

    const pdfButton = screen.getByRole('button', { name: 'PDF 原件' })
    const textButton = screen.getByRole('button', { name: '解析文本' })
    expect(pdfButton.compareDocumentPosition(textButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(textButton.className).toContain('primary')

    await waitFor(() => {
      expect(screen.getByText('Stability', { selector: 'mark' })).toBeInTheDocument()
    })
    expect(screen.queryByTestId('mock-pdf-reader')).not.toBeInTheDocument()
  })

  it('keeps 正文 label and omits PDF 原件 button when document has no PDF original', async () => {
    const paper = makePaper({
      id: 'sources/notes.md',
      title: 'Plain Markdown Note',
      originalUrl: undefined,
    })
    vi.spyOn(v3Api, 'knowledgeV3Post').mockResolvedValue(
      makeDetail(paper, {
        text: 'Plain text content directly from source document.',
        originalUrl: undefined,
      }),
    )

    render(
      <PaperReaderPanel
        paper={paper}
        data={baseSnapshot}
        query=""
        onClose={vi.fn()}
        onNext={vi.fn()}
        onPrevious={vi.fn()}
        canNext={false}
        canPrevious={false}
        onChanged={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText(/Plain text content directly from source document/)).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: 'PDF 原件' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '解析文本' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '正文' }).className).toContain('primary')
  })
})
