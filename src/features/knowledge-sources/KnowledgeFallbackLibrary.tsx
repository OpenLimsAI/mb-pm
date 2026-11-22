import {
  ArrowUpRight,
  Check,
  Download,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Link2,
  Search,
  Star,
  X,
} from 'lucide-react'
import PaperActions from './PaperActions'
import { PaperVersions } from './SourceInsights'
import {
  isInboxFolder,
  safeExternalHref,
  type KnowledgeSourceSnapshot,
  type SourceFolder,
  type SourcePaper,
} from './api'
import { formatKnowledgeDate } from './types'
import {
  KnowledgeButton,
  type KnowledgeModalState,
  type KnowledgeMutation,
} from './KnowledgeDialogs'

const formatPaperSize = (n?: number) =>
  !n
    ? '大小未提供'
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(0)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`

function IndexStateChip({ status }: { status: string }) {
  const labels: Record<string, [string, string]> = {
    parse_failed: ['解析待重试', 'warn'],
    ready: ['可问答', 'green'],
    pending: ['索引处理中', 'blue'],
    failed: ['索引待重试', 'warn'],
    not_requested: ['未建问答索引', ''],
    none: ['未建问答索引', ''],
  }
  const [label, tone] = labels[status] || ['索引状态待确认', '']
  return <span className={`kso-chip ${tone}`}>{label}</span>
}

interface FallbackLibraryProps {
  data: KnowledgeSourceSnapshot
  papers: SourcePaper[]
  paper?: SourcePaper
  currentFolder?: SourceFolder
  folder: string
  search: string
  filter: string
  sort: string
  details: boolean
  shown: number
  picks: string[]
  visiblePicks: string[]
  busy: boolean
  folderName: (id: string) => string
  mutate: KnowledgeMutation
  onSearchChange: (value: string) => void
  onFilterChange: (value: string) => void
  onSortChange: (value: string) => void
  onToggleDetails: () => void
  onSelectPaper: (id: string) => void
  onPicksChange: (ids: string[]) => void
  onShowMore: () => void
  onOpenModal: (modal: KnowledgeModalState) => void
  onGo: (view: 'library' | 'sources', target?: string) => void
  onNotice: (text: string) => void
  onCloseDetails: () => void
}

export default function KnowledgeFallbackLibrary({
  data,
  papers,
  paper,
  currentFolder,
  folder,
  search,
  filter,
  sort,
  details,
  shown,
  picks,
  visiblePicks,
  busy,
  folderName,
  mutate,
  onSearchChange,
  onFilterChange,
  onSortChange,
  onToggleDetails,
  onSelectPaper,
  onPicksChange,
  onShowMore,
  onOpenModal,
  onGo,
  onNotice,
  onCloseDetails,
}: FallbackLibraryProps) {
  return (
    <section className="kso-workspace" aria-label="论文文件夹管理器">
      <div className="kso-toolbar">
        <label className="kso-search">
          <Search />
          <input
            aria-label="搜索论文"
            placeholder="搜索标题、指南编号或关键词"
            value={search}
            onChange={e => onSearchChange(e.target.value)}
          />
        </label>
        <select
          className="kso-select"
          aria-label="筛选资料"
          value={filter}
          onChange={e => onFilterChange(e.target.value)}
        >
          <option value="all">全部类型与状态</option>
          {[...new Set(data.papers.map(p => p.type).filter(Boolean))].map(t => (
            <option key={t}>{t}</option>
          ))}
          <option value="ready">可问答</option>
          <option value="failed">索引待重试</option>
        </select>
        <select
          className="kso-select"
          aria-label="论文排序"
          value={sort}
          onChange={e => onSortChange(e.target.value)}
        >
          <option value="recent">最近下载</option>
          <option value="name">按标题排列</option>
        </select>
        <button
          type="button"
          className="kso-btn quiet"
          aria-label={details ? '隐藏论文详情' : '显示论文详情'}
          aria-pressed={details}
          onClick={onToggleDetails}
        >
          {details ? '收起详情' : '展开详情'}
        </button>
      </div>
      {visiblePicks.length > 0 && (
        <div className="kso-bulk" role="group" aria-label="批量论文操作">
          <strong>已选 {visiblePicks.length} 篇</strong>
          {data.canOrganize && (
            <>
              <KnowledgeButton
                disabled={busy}
                onClick={() => onOpenModal({ kind: 'assign', ids: visiblePicks })}
              >
                <FolderPlus />
                放入文件夹
              </KnowledgeButton>
              {currentFolder && !isInboxFolder(currentFolder) && (
                <>
                  <KnowledgeButton
                    disabled={busy}
                    onClick={() =>
                      onOpenModal({ kind: 'move', ids: visiblePicks, folderId: folder })
                    }
                  >
                    移动到…
                  </KnowledgeButton>
                  <KnowledgeButton
                    disabled={busy}
                    onClick={() =>
                      void mutate(
                        'post',
                        '/papers/folders',
                        {
                          paperIds: visiblePicks,
                          folderIds: [],
                          fromFolderId: folder,
                          mode: 'remove',
                          revision: data.catalogRevision,
                        },
                        '已批量从当前文件夹移除，原件保留。',
                      )
                    }
                  >
                    从当前文件夹移除
                  </KnowledgeButton>
                </>
              )}
            </>
          )}
          <KnowledgeButton primary onClick={() => onPicksChange([])}>
            取消
          </KnowledgeButton>
        </div>
      )}
      <div className={`kso-manager${details && paper ? '' : ' no-detail'}`}>
        <div className="kso-list">
          <table className="kso-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="全选当前论文"
                    checked={papers.length > 0 && papers.every(p => visiblePicks.includes(p.id))}
                    onChange={e => onPicksChange(e.target.checked ? papers.map(p => p.id) : [])}
                  />
                </th>
                <th>
                  论文名称 <span className="kso-small">{papers.length}</span>
                </th>
                <th className="kso-folder-col">所属文件夹</th>
                <th className="kso-status-col">服务器 / 知识库</th>
              </tr>
            </thead>
            <tbody>
              {papers.slice(0, shown).map(p => (
                <tr key={p.id} className={paper?.id === p.id ? 'is-current' : ''}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`选择 ${p.title}`}
                      checked={visiblePicks.includes(p.id)}
                      onChange={e =>
                        onPicksChange(
                          e.target.checked ? [...picks, p.id] : picks.filter(id => id !== p.id),
                        )
                      }
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="kso-paper-button"
                      onClick={() => onSelectPaper(p.id)}
                    >
                      <span className="kso-doc-icon">
                        <FileText />
                      </span>
                      <span>
                        <span className="kso-paper-title">
                          {p.title}
                          {data.starred.includes(p.id) && ' ☆'}
                        </span>
                        <span className="kso-paper-sub">
                          {p.sourceName || '知识库已有资料'} · {p.type || '论文资料'}
                          {p.size ? ` · ${formatPaperSize(p.size)}` : ''}
                          {p.createdAt ? ` · ${formatKnowledgeDate(p.createdAt)}` : ''}
                        </span>
                      </span>
                    </button>
                  </td>
                  <td className="kso-folder-col">
                    <div className="kso-folders-cell">
                      {p.folderIds.length ? (
                        p.folderIds.map(id => (
                          <span key={id} className="kso-chip">
                            {folderName(id)}
                          </span>
                        ))
                      ) : (
                        <span className="kso-small">未分配文件夹</span>
                      )}
                    </div>
                  </td>
                  <td>
                    <div className="kso-status">
                      <span className="kso-small">
                        <Check />
                        {p.saved ? '原件已保存' : '知识库资料'}
                      </span>
                      <IndexStateChip
                        status={p.parseStatus === 'failed' ? 'parse_failed' : p.indexStatus}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {papers.length > shown && (
            <KnowledgeButton onClick={onShowMore}>
              加载更多论文（已显示 {shown} / {papers.length}）
            </KnowledgeButton>
          )}
          {!papers.length && (
            <div className="kso-empty">
              <FolderOpen />
              <h3>
                {currentFolder && !search
                  ? '这个文件夹还是空的'
                  : data.papers.length
                    ? '没有匹配的论文'
                    : '还没有已保存的论文'}
              </h3>
              <div>
                {currentFolder && !search
                  ? '从已有论文中勾选资料，再放入这个文件夹；也可以从来源下载。'
                  : data.papers.length
                    ? '调整搜索或分类条件，也可从全部论文重新选择。'
                    : '已有知识库论文会显示在这里，也可以添加来源并下载到服务器。'}
                <div className="kso-actions kso-empty-actions">
                  {data.papers.length > 0 && (
                    <KnowledgeButton
                      onClick={() => {
                        onGo('library', 'all')
                        if (currentFolder) {
                          onNotice(`勾选论文后，可在文件夹卡片中直接放入「${currentFolder.name}」。`)
                        }
                      }}
                    >
                      从全部论文选择
                    </KnowledgeButton>
                  )}
                  {data.canManage && (
                    <KnowledgeButton primary onClick={() => onGo('sources')}>
                      <Download />
                      从来源下载
                    </KnowledgeButton>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
        {details && paper && (
          <PaperInspector
            paper={paper}
            data={data}
            busy={busy}
            onClose={onCloseDetails}
            folder={folder}
            open={onOpenModal}
            mutate={mutate}
          />
        )}
      </div>
      <div className="kso-list-footer">
        <span>{papers.length} 篇唯一论文 · 多个文件夹共用服务器原件</span>
        <span>读取自知识库与服务器归档</span>
      </div>
    </section>
  )
}

function PaperInspector({
  paper: p,
  data,
  busy,
  folder,
  onClose,
  open,
  mutate,
}: {
  paper: SourcePaper
  data: KnowledgeSourceSnapshot
  busy: boolean
  folder: string
  onClose: () => void
  open: (m: KnowledgeModalState) => void
  mutate: KnowledgeMutation
}) {
  const original = safeExternalHref(p.originalUrl)
  const kb = safeExternalHref(p.kbUrl)
  return (
    <aside className="kso-inspector" aria-label="论文详情">
      <div className="kso-inspector-label">
        论文详情
        <button type="button" className="kso-icon-btn" aria-label="关闭详情" onClick={onClose}>
          <X />
        </button>
      </div>
      <div>
        <div className="kso-inspector-icon">
          <FileText />
        </div>
        <h2>{p.title}</h2>
        <p>{p.code || p.type || '知识库论文'}</p>
        <div className="kso-actions" style={{ marginTop: 10 }}>
          {original ? (
            <a className="kso-btn" href={original} target="_blank" rel="noopener noreferrer">
              <FileText />
              查看原文
            </a>
          ) : kb ? (
            <a className="kso-btn" href={kb} target="_blank" rel="noopener noreferrer">
              在知识库阅读
              <ArrowUpRight />
            </a>
          ) : (
            <span className="kso-small">原文入口暂不可用</span>
          )}
          <button
            type="button"
            className="kso-icon-btn"
            aria-label={data.starred.includes(p.id) ? '取消收藏论文' : '收藏论文'}
            disabled={busy}
            onClick={() => {
              void mutate(
                'post',
                '/stars',
                { paperId: p.id, enabled: !data.starred.includes(p.id) },
                '个人收藏已保存。',
              )
            }}
          >
            <Star fill={data.starred.includes(p.id) ? 'currentColor' : 'none'} />
          </button>
        </div>
      </div>
      <div className="kso-inspector-section">
        <h3>文件信息</h3>
        <dl>
          <dt>下载来源</dt>
          <dd>{p.sourceName || '知识库已有资料'}</dd>
          <dt>文件大小</dt>
          <dd>{formatPaperSize(p.size)}</dd>
          <dt>收录日期</dt>
          <dd>{formatKnowledgeDate(p.createdAt)}</dd>
          <dt>服务器</dt>
          <dd>{p.saved ? <span className="kso-chip green">原件已保存</span> : '知识库已有资料'}</dd>
          <dt>问答状态</dt>
          <dd>
            <IndexStateChip status={p.parseStatus === 'failed' ? 'parse_failed' : p.indexStatus} />
          </dd>
        </dl>
        {p.error && <p className="kso-error">{p.error}</p>}
        {p.indexStatus !== 'ready' && p.documentId && data.canManage && (
          <KnowledgeButton
            disabled={busy}
            onClick={() => {
              void mutate(
                'post',
                `/documents/${encodeURIComponent(p.documentId!)}/retry`,
                {},
                '解析与索引重试任务已提交。',
              )
            }}
          >
            {p.parseStatus === 'failed'
              ? '重试解析'
              : p.indexStatus === 'failed'
                ? '重试问答索引'
                : '建立问答索引'}
          </KnowledgeButton>
        )}
        {kb && (
          <a className="kso-btn" href={kb} target="_blank" rel="noopener noreferrer">
            在知识库查看
            <ArrowUpRight />
          </a>
        )}
      </div>
      <div className="kso-inspector-section">
        <h3>所属文件夹</h3>
        <div className="kso-folders-cell">
          {p.folderIds.map(id => (
            <span key={id} className="kso-folder-tag">
              <Folder />
              {data.folders.find(f => f.id === id)?.name || '未指定'}
            </span>
          ))}
        </div>
        {data.canOrganize && (
          <>
            <KnowledgeButton disabled={busy} onClick={() => open({ kind: 'assign', ids: [p.id] })}>
              <FolderPlus />
              放入文件夹
            </KnowledgeButton>
            {p.folderIds.includes(folder) &&
              !data.folders.some(f => f.id === folder && isInboxFolder(f)) && (
                <KnowledgeButton
                  quiet
                  disabled={busy}
                  onClick={() => {
                    void mutate(
                      'post',
                      '/papers/folders',
                      {
                        paperIds: [p.id],
                        folderIds: [],
                        fromFolderId: folder,
                        mode: 'remove',
                        revision: data.catalogRevision,
                      },
                      '已从当前文件夹移除，论文原件保留。',
                    )
                  }}
                >
                  从当前文件夹移除
                </KnowledgeButton>
              )}
          </>
        )}
        <div className="kso-note">
          <Link2 />
          同一论文可以加入多个文件夹，不复制服务器原件。
        </div>
      </div>
      <PaperVersions paper={p} data={data} />
      <PaperActions paper={p} />
    </aside>
  )
}
