import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type FormEvent,
  type ReactNode,
} from 'react'
import { Folder, LoaderCircle, X } from 'lucide-react'
import FolderMaintenance from './FolderMaintenance'
import {
  SCOPE_NAMES,
  isInboxFolder,
  type KnowledgeSourceSnapshot,
} from './api'

export type KnowledgeModalState = {
  kind:
    | 'new-folder'
    | 'rename-folder'
    | 'delete-folder'
    | 'manage-folder'
    | 'assign'
    | 'move'
    | 'source'
  ids?: string[]
  folderId?: string
}

export type KnowledgeMutation = (
  method: 'post' | 'patch',
  path: string,
  body: unknown,
  success: string,
) => Promise<boolean>

export function KnowledgeButton({
  children,
  primary,
  quiet,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean; quiet?: boolean }) {
  return (
    <button
      type="button"
      className={`kso-btn${primary ? ' primary' : ''}${quiet ? ' quiet' : ''} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

export function KnowledgeEmpty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="kso-empty">
      <Folder />
      <h3>{title}</h3>
      <div>{children}</div>
    </div>
  )
}

interface KnowledgeDialogProps {
  modal: KnowledgeModalState
  data: KnowledgeSourceSnapshot
  folderCount: (folderId: string) => number
  busy: boolean
  remoteError: string
  mutate: KnowledgeMutation
  onClose: () => void
  onDone: () => void
  onNavigate: (view: 'sources' | 'downloads') => void
}

export function KnowledgeDialog({
  modal,
  data,
  folderCount,
  busy,
  remoteError,
  mutate,
  onClose,
  onDone,
  onNavigate,
}: KnowledgeDialogProps) {
  const box = useRef<HTMLDivElement>(null)
  const [revision] = useState(data.catalogRevision)
  const [name, setName] = useState(
    modal.folderId ? data.folders.find(f => f.id === modal.folderId)?.name || '' : '',
  )
  const [url, setUrl] = useState('')
  const isIch = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, '') === 'ich.org'
    } catch {
      return false
    }
  })()
  const [destinations, setDestinations] = useState<string[]>([])
  const [scopes, setScopes] = useState(['Q', 'S', 'E', 'M'])
  const [localError, setLocalError] = useState('')

  useEffect(() => {
    const previous = document.activeElement as HTMLElement
    box.current
      ?.querySelector<HTMLElement>(
        modal.kind === 'delete-folder' ? '[data-cancel-delete]' : 'input,select,button',
      )
      ?.focus()
    return () => {
      if (previous?.isConnected) previous.focus()
    }
  }, [modal.kind])

  const titles = {
    'new-folder': '新建论文文件夹',
    'rename-folder': '重命名文件夹',
    'delete-folder': '删除文件夹',
    'manage-folder': '文件夹设置',
    assign: '放入论文文件夹',
    move: '移动到文件夹',
    source: '添加论文搜索源',
  }
  const targetFolder = data.folders.find(item => item.id === modal.folderId)
  const defaultSource = data.sources.find(item => item.folderId === modal.folderId)
  const pendingDownload = data.jobs.some(
    item =>
      item.folderId === modal.folderId && ['queued', 'running', 'paused'].includes(item.status),
  )
  const deletionBlocked = !!defaultSource || pendingDownload

  async function submit(event: FormEvent) {
    event.preventDefault()
    setLocalError('')
    if (busy) return
    let ok = false
    if (modal.kind === 'new-folder' || modal.kind === 'rename-folder') {
      if (!name.trim()) return setLocalError('请填写文件夹名称。')
      ok = await mutate(
        modal.kind === 'new-folder' ? 'post' : 'patch',
        modal.kind === 'new-folder'
          ? '/folders'
          : `/folders/${encodeURIComponent(modal.folderId!)}`,
        { name: name.trim(), revision },
        '文件夹已保存。',
      )
    } else if (modal.kind === 'assign' || modal.kind === 'move') {
      if (!destinations.length) return setLocalError('请选择目标文件夹。')
      ok = await mutate(
        'post',
        '/papers/folders',
        {
          paperIds: modal.ids,
          folderIds: destinations,
          fromFolderId: modal.folderId,
          mode: modal.kind === 'move' ? 'move' : 'add',
          revision,
        },
        '论文分类已保存，共用原件。',
      )
    } else if (modal.kind === 'delete-folder') {
      if (deletionBlocked) return
      ok = await mutate(
        'post',
        `/folders/${encodeURIComponent(modal.folderId!)}/actions`,
        { action: 'delete', revision },
        '文件夹已删除，论文和原件保留。',
      )
    } else if (modal.kind === 'source') {
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        return setLocalError('请填写有效的 HTTPS 来源地址。')
      }
      if (!name.trim() || parsed.protocol !== 'https:' || !scopes.length) {
        return setLocalError('请填写名称、HTTPS 地址，并选择范围。')
      }
      ok = await mutate(
        'post',
        '/sources',
        { name: name.trim(), url: parsed.href, scopes, enabled: false },
        '来源已保存，默认使用同名文件夹。其他来源适配后才能下载。',
      )
    }
    if (ok) onDone()
  }

  return (
    <div
      className="kso-dialog-layer"
      onKeyDown={event => {
        if (event.key === 'Escape' && !busy) onClose()
        if (event.key === 'Tab') {
          const nodes = Array.from(
            box.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]',
            ) || [],
          )
          const first = nodes[0]
          const last = nodes.at(-1)
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          }
        }
      }}
    >
      <div
        ref={box}
        className="kso-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kso-dialog-title"
      >
        <form
          onSubmit={event => {
            void submit(event)
          }}
        >
          <div className="kso-dialog-head">
            <h2 id="kso-dialog-title">{titles[modal.kind]}</h2>
            <button
              type="button"
              className="kso-icon-btn"
              aria-label="关闭窗口"
              onClick={onClose}
              disabled={busy}
            >
              <X />
            </button>
          </div>
          <div className="kso-dialog-body">
            {modal.kind === 'delete-folder' && (
              <div className="kso-delete-folder-copy">
                <p>删除「{targetFolder?.name}」？</p>
                <p className="kso-small">只删除文件夹，论文和原件会保留。</p>
                {defaultSource ? (
                  <div className="kso-note">
                    这是「{defaultSource.name}」的默认文件夹，请先更换保存位置。
                    <KnowledgeButton onClick={() => onNavigate('sources')}>
                      去来源设置
                    </KnowledgeButton>
                  </div>
                ) : pendingDownload ? (
                  <div className="kso-note">
                    此文件夹还有未完成的下载，请先处理任务。
                    <KnowledgeButton onClick={() => onNavigate('downloads')}>
                      查看下载记录
                    </KnowledgeButton>
                  </div>
                ) : null}
              </div>
            )}
            {modal.kind === 'manage-folder' && targetFolder && (
              <FolderMaintenance
                folder={targetFolder}
                data={data}
                busy={busy}
                mutate={mutate}
                onRemoved={onDone}
              />
            )}
            {(modal.kind === 'new-folder' ||
              modal.kind === 'rename-folder' ||
              modal.kind === 'source') && (
              <label className="kso-field">
                {modal.kind === 'source' ? '来源名称' : '文件夹名称'}
                <input
                  value={name}
                  onChange={event => setName(event.target.value)}
                  maxLength={60}
                  required
                  placeholder={modal.kind === 'source' ? '例如 ICH' : '例如 稳定性研究'}
                />
              </label>
            )}
            {modal.kind === 'source' && (
              <>
                <label className="kso-field">
                  官方网站或栏目地址
                  <input
                    type="url"
                    value={url}
                    onChange={event => setUrl(event.target.value)}
                    required
                    placeholder="https://www.ich.org/page/quality-guidelines"
                  />
                </label>
                {isIch && (
                  <div className="kso-scope-options">
                    {Object.entries(SCOPE_NAMES).map(([key, value]) => (
                      <label key={key} className="kso-check kso-scope">
                        <input
                          type="checkbox"
                          checked={scopes.includes(key)}
                          onChange={event =>
                            setScopes(
                              event.target.checked
                                ? [...scopes, key]
                                : scopes.filter(code => code !== key),
                            )
                          }
                        />
                        <span>
                          {key} {value}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
                <div className="kso-note">
                  {isIch ? '已支持 ICH 搜索和下载。' : '当前网站仅登记来源，暂不能搜索或下载。'}
                  默认创建或复用同名论文文件夹。下载由你主动启动，历史监控保持关闭。当前仅 ICH 已适配。
                </div>
              </>
            )}
            {(modal.kind === 'assign' || modal.kind === 'move') && (
              <>
                <p className="kso-small">
                  已选择 {modal.ids?.length || 0} 篇。
                  {modal.kind === 'move'
                    ? `将从「${data.folders.find(f => f.id === modal.folderId)?.name}」移出，保留其他分类。`
                    : '保留已有文件夹关联，不复制服务器原件。'}
                </p>
                <div className="kso-folder-options">
                  {data.folders
                    .filter(f => f.id !== modal.folderId && !isInboxFolder(f))
                    .map(f => (
                      <label className="kso-folder-option" key={f.id}>
                        <input
                          type={modal.kind === 'move' ? 'radio' : 'checkbox'}
                          name="destination"
                          checked={destinations.includes(f.id)}
                          onChange={event =>
                            setDestinations(
                              modal.kind === 'move'
                                ? [f.id]
                                : event.target.checked
                                  ? [...destinations, f.id]
                                  : destinations.filter(id => id !== f.id),
                            )
                          }
                        />
                        <Folder />
                        <span>{f.name}</span>
                        <small>{folderCount(f.id)} 篇</small>
                      </label>
                    ))}
                </div>
                {!data.folders.length && <p className="kso-small">请先返回列表新建文件夹。</p>}
              </>
            )}
            {(localError || remoteError) && (
              <p role="alert" className="kso-error">
                {localError || remoteError}
              </p>
            )}
          </div>
          <div className="kso-dialog-foot">
            <KnowledgeButton data-cancel-delete disabled={busy} onClick={onClose}>
              {modal.kind === 'manage-folder' ? '关闭' : '取消'}
            </KnowledgeButton>
            {modal.kind !== 'manage-folder' && (
              <button
                type="submit"
                className={`kso-btn ${modal.kind === 'delete-folder' ? 'danger' : 'primary'}`}
                disabled={busy || (modal.kind === 'delete-folder' && deletionBlocked)}
              >
                {busy && <LoaderCircle className="if-spin" />}
                {modal.kind === 'delete-folder'
                  ? '删除文件夹'
                  : modal.kind === 'source'
                    ? '保存来源'
                    : '确认保存'}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}
