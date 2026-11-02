import SafeMarkdown from '../../components/SafeMarkdown'
export default function MarkdownView({ children }: { children: string }) {
  return <div className="aa-markdown"><SafeMarkdown>{children}</SafeMarkdown></div>
}
