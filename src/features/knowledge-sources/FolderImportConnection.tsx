import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, Copy, Download, Laptop, LoaderCircle } from 'lucide-react'
import { folderConnectorScriptUrl, type FolderImportPairing, type FolderImportTask } from './folder-import-api'
import './folder-import-connection.css'

interface Props {
  task: FolderImportTask
  pairing: FolderImportPairing | null
  busy: boolean
  writable: boolean
  onClose: () => void
  onPair: () => void
}

// Values entered by the user remain one argument in the selected shell.
const shellQuote = (value: string, windows: boolean) => windows
  ? `'${value.replaceAll("'", "''")}'`
  : `'${value.replaceAll("'", "'\\''")}'`

export default function FolderImportConnection({ task, pairing, busy, writable, onClose, onPair }: Props) {
  const [windows, setWindows] = useState(() => /Windows/i.test(navigator.userAgent))
  const [path, setPath] = useState(task.sourcePath || task.path || '')
  const [message, setMessage] = useState(''), [copyError, setCopyError] = useState('')
  const [now, setNow] = useState(Date.now)
  const heading = useRef<HTMLHeadingElement>(null), alive = useRef(true)
  useEffect(() => {
    alive.current = true
    heading.current?.focus()
    return () => { alive.current = false }
  }, [])
  useEffect(() => {
    if (!pairing) return
    const expires = Date.parse(pairing.expiresAt)
    if (!Number.isFinite(expires)) return
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(2147483647, Math.max(0, expires - Date.now() + 1)))
    return () => window.clearTimeout(timer)
  }, [pairing])

  const expiry = pairing ? Date.parse(pairing.expiresAt) : NaN
  const expired = !!pairing && (!Number.isFinite(expiry) || expiry <= now)
  const folder = path.trim()
  const validPath = (windows ? /^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\)/ : /^(?:\/|~\/)/).test(folder) && !/[\r\n\0]/.test(folder)
  const commandBase = `${windows ? 'py -3' : 'python3'} knowledge-folder-connector.py`
  const config = `~/.mberp/folder-${task.id}.json`
  const command = pairing ? `${commandBase} --server ${shellQuote(window.location.origin, windows)} --code ${shellQuote(pairing.code, windows)} --folder ${shellQuote(folder, windows)} --config ${shellQuote(config, windows)}` : ''
  const startupCommand = `${commandBase} --config ${shellQuote(config, windows)} --install-startup`
  async function copy(value: string, connection = false) {
    setMessage(''); setCopyError('')
    if (connection && (!validPath || !pairing || Date.now() >= expiry)) {
      setCopyError(!validPath ? '请填写本机文件夹的完整路径。' : '连接码已过期，请生成新的连接码。')
      setNow(Date.now())
      return
    }
    try {
      await navigator.clipboard.writeText(value)
      if (alive.current) setMessage('已复制，请在下载目录的终端中粘贴并运行。')
    } catch {
      if (alive.current) setCopyError(connection ? '复制未成功，请展开“查看运行命令”手动复制。' : '复制未成功，请手动选中上方命令复制。')
    }
  }
  function clearFeedback() { setMessage(''); setCopyError('') }

  return <section className="kso-connect-page" aria-label="连接我的电脑">
    <button type="button" className="kso-btn quiet kso-connect-back" aria-label="关闭电脑连接" disabled={busy} onClick={onClose}><ArrowLeft />返回自动导入</button>
    <header className="kso-connect-heading"><h1 ref={heading} tabIndex={-1}>连接我的电脑</h1><p>{task.name} · 只需在保存文件的电脑上配置一次。</p></header>
    {task.connectorOnline && !pairing && !busy ? <div className="kso-connect-success" role="status"><Check /><div><h2>电脑已连接</h2><p>{task.sourcePath || task.path || '文件夹连接已建立'}</p><button type="button" className="kso-btn primary" onClick={onClose}>返回查看导入进度</button></div></div> : <>
      <div className="kso-connect-card">
        <section className="kso-connect-step" aria-labelledby="kso-connect-download">
          <span className="kso-connect-number" aria-hidden="true">1</span>
          <div className="kso-connect-step-body"><h2 id="kso-connect-download">下载连接程序</h2><p>这台电脑需已安装 Python 3.10 或以上版本。</p>
            <a className="kso-btn" href={folderConnectorScriptUrl} download="knowledge-folder-connector.py"><Download />下载电脑连接程序</a>
          </div>
        </section>
        <section className="kso-connect-step" aria-labelledby="kso-connect-run">
          <span className="kso-connect-number" aria-hidden="true">2</span>
          <div className="kso-connect-step-body"><h2 id="kso-connect-run">连接要扫描的文件夹</h2>
            <div className="kso-connect-platform" role="group" aria-label="电脑系统"><button type="button" aria-pressed={!windows} onClick={() => { setWindows(false); clearFeedback() }}>Mac / Linux</button><button type="button" aria-pressed={windows} onClick={() => { setWindows(true); clearFeedback() }}>Windows</button></div>
            <label className="kso-field">本机文件夹路径<input aria-label="本机文件夹路径" value={path} placeholder={windows ? '例如 C:\\Users\\你的名字\\Documents\\论文' : '例如 /Users/你的名字/Documents/论文'} disabled={busy || !writable} autoComplete="off" spellCheck={false} onChange={event => { setPath(event.target.value); clearFeedback() }} /><small>填写完整路径。只扫描这个文件夹，不会删除其中的文件。</small></label>
            {busy ? <p className="kso-connect-pending" role="status"><LoaderCircle className="if-spin" />正在准备连接…</p> : !pairing || expired ? <div className="kso-connect-renew"><p>{expired ? '连接码已过期，重新生成后即可继续。' : '生成一次性连接码，将这台电脑连接到当前任务。'}</p><button type="button" className="kso-btn primary" disabled={!writable} onClick={() => { clearFeedback(); onPair() }}>生成新的连接码</button></div> : <>
              <div className="kso-connect-code"><span>连接码 <strong>{pairing.code}</strong></span><span>{new Date(expiry).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 前有效 · 请勿分享</span></div>
              <button type="button" className="kso-btn primary kso-connect-copy" disabled={!validPath || !writable} onClick={() => void copy(command, true)}><Copy />复制连接命令</button>
              <p>在下载目录打开{windows ? ' PowerShell' : '终端'}，粘贴命令并运行。</p>
              <details className="kso-connect-details"><summary>查看运行命令</summary>{validPath ? <pre>{command}</pre> : <p>填写上方完整文件夹路径后，会生成可直接运行的命令。</p>}</details>
            </>}
            {message && <p className="kso-connect-feedback" role="status"><Check />{message}</p>}
            {copyError && <p className="kso-error" role="alert">{copyError}</p>}
          </div>
        </section>
      </div>
      <p className="kso-connect-footnote"><Laptop />电脑开机并保持连接后，资料会按计划自动导入。关闭网页不影响运行。</p>
      <details className="kso-connect-startup"><summary>登录电脑后自动连接（可选）</summary><p>首次连接成功后，按 Ctrl+C 停止前台程序，再运行以下命令。</p><pre>{startupCommand}</pre><button type="button" className="kso-btn" disabled={busy || !writable} onClick={() => void copy(startupCommand)}><Copy />复制自动连接命令</button></details>
    </>}
  </section>
}
