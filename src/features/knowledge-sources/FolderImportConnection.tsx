import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, Copy, Download, LoaderCircle } from 'lucide-react'
import { folderConnectorScriptUrl, type FolderImportPairing, type FolderImportTask } from './folder-import-api'
import './folder-import-connection.css'

interface Props {
  task: FolderImportTask
  pairing: FolderImportPairing | null
  busy: boolean
  writable: boolean
  onClose: () => void
  onPair: () => void
  inline?: boolean
  sourceFolderName?: string
  sourceFolderPath?: string
}

// Keep each user-provided value a single literal argument in the selected shell.
function shellQuote(value: string, windows: boolean) {
  if (!windows) return `'${value.replaceAll("'", "'\\''")}'`
  const quoted = `'${value.replaceAll("'", "''")}'`
  // PowerShell treats typographic apostrophes as delimiters too. Insert those
  // characters by their code points so the exact directory name is preserved.
  const literal = quoted.replace(/[‘’‚‛]/g, char => `' + [char]${char.charCodeAt(0)} + '`)
  return literal === quoted ? quoted : `(${literal})`
}

const windowsAbsolute = /^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\)/
const scriptName = 'knowledge-folder-connector.py'

export default function FolderImportConnection({
  task, pairing, busy, writable, onClose, onPair, inline = false, sourceFolderName, sourceFolderPath,
}: Props) {
  // sourcePath is also used for display text when a computer has not paired.
  const savedPath = task.path || (task.sourcePath && (windowsAbsolute.test(task.sourcePath) || task.sourcePath.startsWith('/')) ? task.sourcePath : '')
  const [windows, setWindows] = useState(() => {
    if (sourceFolderPath || savedPath) return windowsAbsolute.test(sourceFolderPath || savedPath)
    return /Windows/i.test(navigator.userAgent)
  })
  const [path, setPath] = useState(savedPath)
  const [message, setMessage] = useState('')
  const [copyError, setCopyError] = useState('')
  const [now, setNow] = useState(Date.now)
  const heading = useRef<HTMLHeadingElement>(null)
  const alive = useRef(true)
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
  const folder = (inline ? sourceFolderPath || savedPath : path).trim()
  const pickedName = !folder ? sourceFolderName || task.localFolderName : undefined
  const validName = !!pickedName && pickedName !== '.' && pickedName !== '..' && !/[/\r\n\0]/.test(pickedName)
  const validPath = (windows ? windowsAbsolute : /^(?:\/|~\/)/).test(folder) && !/[\r\n\0]/.test(folder)
  const commandReady = validPath || validName
  const interpreter = windows ? 'py -3' : 'python3'
  // A web picker supplies a directory name. The terminal's working directory
  // supplies its actual path and the connector checks the name before pairing.
  const script = pickedName
    ? windows ? '"$HOME\\Downloads\\knowledge-folder-connector.py"' : '"$HOME/Downloads/knowledge-folder-connector.py"'
    : scriptName
  const commandBase = `${interpreter} ${script}`
  const config = `~/.mberp/folder-${task.id}.json`
  const folderArgument = pickedName
    ? `--folder . ${shellQuote('--expected-folder-name=' + pickedName, windows)}`
    : `--folder ${shellQuote(folder, windows)}`
  const command = pairing ? `${commandBase} --server ${shellQuote(window.location.origin, windows)} --code ${shellQuote(pairing.code, windows)} ${folderArgument} --config ${shellQuote(config, windows)}` : ''
  const startupCommand = `${commandBase} --config ${shellQuote(config, windows)} --install-startup`
  const terminal = windows ? 'PowerShell' : '终端'
  const whereToRun = pickedName ? `在刚选的「${pickedName}」文件夹中打开${terminal}` : `在下载目录打开${terminal}`
  const connected = task.connectorOnline && (inline || !pairing) && !busy

  function clearFeedback() {
    setMessage('')
    setCopyError('')
  }
  async function copy(value: string, connection = false) {
    clearFeedback()
    if (connection && (!commandReady || !pairing || !Number.isFinite(expiry) || Date.now() >= expiry)) {
      setCopyError(!commandReady ? '请填写本机文件夹的完整路径。' : '连接码已过期，请生成新的连接码。')
      setNow(Date.now())
      return
    }
    try {
      await navigator.clipboard.writeText(value)
      if (alive.current) setMessage(`已复制。${whereToRun}，粘贴并运行。`)
    } catch {
      if (alive.current) setCopyError(connection ? '复制未成功，请展开“查看运行命令”手动复制。' : '复制未成功，请手动选中上方命令复制。')
    }
  }
  const platform = <div className="kso-connect-platform" role="group" aria-label="电脑系统">
    <button type="button" aria-pressed={!windows} onClick={() => { setWindows(false); clearFeedback() }}>Mac / Linux</button>
    <button type="button" aria-pressed={windows} onClick={() => { setWindows(true); clearFeedback() }}>Windows</button>
  </div>
  const downloadLink = <a className="kso-btn" href={folderConnectorScriptUrl} download={scriptName}><Download />下载电脑连接程序</a>

  return <section className={`kso-connect-page${inline ? ' kso-connect-inline' : ''}`} aria-label="连接我的电脑">
    {!inline && <button type="button" className="kso-btn quiet kso-connect-back" aria-label="关闭电脑连接" disabled={busy} onClick={onClose}><ArrowLeft />返回自动导入</button>}
    <header className="kso-connect-heading">
      {inline ? <h2 ref={heading} tabIndex={-1}>连接我的电脑</h2> : <h1 ref={heading} tabIndex={-1}>连接我的电脑</h1>}
      {!inline && <p>{task.name}</p>}
    </header>
    {connected ? <div className="kso-connect-success" role="status">
      <Check /><div><h3>电脑已连接</h3><p>{task.sourcePath || task.path || '文件夹连接已建立'}</p>
        <button type="button" className="kso-btn" onClick={onClose}>返回查看导入进度</button>
      </div>
    </div> : <div className="kso-connect-card">
      {!inline && <div className="kso-connect-fields">
        {platform}
        <label className="kso-field">本机文件夹路径
          <input aria-label="本机文件夹路径" value={path} placeholder={windows ? '例如 C:\\Users\\你的名字\\Documents\\论文' : '例如 /Users/你的名字/Documents/论文'} disabled={busy || !writable} autoComplete="off" spellCheck={false} onChange={event => { setPath(event.target.value); clearFeedback() }} />
        </label>
      </div>}
      <p className="kso-connect-instructions">
        {pickedName ? `将连接程序保存到个人下载目录（Downloads）。${whereToRun}，粘贴连接命令并运行。` : `下载连接程序后，${whereToRun}，粘贴连接命令并运行。`}
      </p>
      <div className="kso-connect-actions">
        {downloadLink}
        {busy ? <span className="kso-connect-pending" role="status"><LoaderCircle className="if-spin" />正在准备连接…</span>
          : !pairing || expired ? <button type="button" className="kso-btn primary" disabled={!writable} onClick={() => { clearFeedback(); onPair() }}>生成新的连接码</button>
          : <button type="button" className="kso-btn primary" disabled={!commandReady || !writable} onClick={() => void copy(command, true)}><Copy />复制连接命令</button>}
      </div>
      {expired && <p role="status">连接码已过期，重新生成后即可继续。</p>}
      {message && <p className="kso-connect-feedback" role="status"><Check />{message}</p>}
      {copyError && <p className="kso-error" role="alert">{copyError}</p>}
      {pairing && !expired && !busy && <details className="kso-connect-details">
        <summary>查看运行命令</summary>
        {inline && platform}
        {commandReady ? <pre>{command}</pre> : <p>填写完整文件夹路径后会显示运行命令。</p>}
        <p className="kso-connect-code">连接码 <strong>{pairing.code}</strong> · {new Date(expiry).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 前有效</p>
      </details>}
      <p className="kso-connect-footnote">电脑需安装 Python 3.10 或以上版本。定时扫描时请保持开机、联网并运行连接程序。</p>
      <details className="kso-connect-startup"><summary>登录电脑后自动连接（可选）</summary><p>首次连接成功后，按 Ctrl+C 停止前台程序，再运行以下命令。</p><pre>{startupCommand}</pre><button type="button" className="kso-btn" disabled={busy || !writable} onClick={() => void copy(startupCommand)}>复制自动连接命令</button></details>
    </div>}
  </section>
}
