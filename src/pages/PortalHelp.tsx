import { Link } from 'react-router-dom'
import { ArrowUpRight, BookOpen, FolderKanban, ShieldCheck } from 'lucide-react'
import PortalLayout from '../components/portal/PortalLayout'
import { usePortal } from '../store/portal'
import { iamLoginUrl } from '../lib/site'

const questions = [
  ['如何登录？', '在门户登录页点击“使用迈博账号登录”，进入 IAM 验证身份。成功后回到工作台，选择项目管理或知识库。'],
  ['为什么应用显示“待开通”？', '账号登录权限和应用访问权限分别管理。请联系管理员在 IAM 中分配对应应用角色；项目管理还需要关联有效的业务用户。角色调整后，请退出并重新登录工作台。'],
  ['如何开通账号或修改密码？', '账号由管理员在 IAM 平台开通。修改个人信息和密码请登录 IAM 平台；门户不提供自助注册。'],
  ['打开应用后还需要再次登录吗？', '两个应用分别建立自己的登录会话。IAM 会话有效时通常可直接完成验证；若身份已过期，按提示重新登录即可。'],
  ['如何完整退出？', '门户、项目管理和知识库各自保留会话。请分别在已打开的应用内退出，再退出工作台；工作台退出也会请求 IAM 结束单点登录。'],
  ['登录失败或页面打不开怎么办？', '先重试并检查网络。若仍失败，请将页面地址、出现时间与错误提示提供给管理员。请勿发送密码或登录令牌。'],
] as const

export default function PortalHelp() {
  const { user, status, logout } = usePortal()
  return <PortalLayout user={status === 'ready' ? user : null} logout={logout}>
    <div className="portal-page-heading"><div className="workspace-section-label">GETTING STARTED</div><h1>使用帮助</h1><p>从统一登录开始，找到您的工作应用。</p></div>
    <section className="portal-help-steps" aria-label="使用步骤">
      {[{ Icon: ShieldCheck, title: '登录迈博账号', text: '通过 IAM 验证身份' }, { Icon: FolderKanban, title: '选择工作应用', text: '进入项目管理或知识库' }, { Icon: BookOpen, title: '继续您的工作', text: '按应用权限访问数据' }].map(({ Icon, title, text }, i) => <div className="portal-panel" key={title}><div className="portal-step-top"><span className="workspace-app-icon"><Icon size={24} aria-hidden="true" /></span><span>0{i + 1}</span></div><h2>{title}</h2><p className="portal-secondary-copy">{text}</p></div>)}
    </section>
    <section className="portal-panel portal-faq" aria-labelledby="portal-faq-title"><h2 id="portal-faq-title">常见问题</h2>{questions.map(([question, answer]) => <details key={question}><summary>{question}</summary><p>{answer}</p></details>)}</section>
    <aside className="workspace-help"><div><strong>账号与权限支持</strong><p>请联系企业管理员开通账号、调整角色或处理访问问题。</p></div><a href={iamLoginUrl} target="_blank" rel="noopener noreferrer">前往 IAM 平台<ArrowUpRight size={16} aria-hidden="true" /></a></aside>
    <Link className="portal-text-link" to="/">返回工作台</Link>
  </PortalLayout>
}
