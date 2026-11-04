/** Keep action payloads available in the stored report, but out of readable prose. */
export function projectAnalysisText(content: string): string {
  const visible: string[] = []
  let fence: { marker: string; length: number; actions: boolean } | null = null
  for (const line of content.split(/\r?\n/)) {
    if (fence) {
      const closing = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/)
      if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) {
        if (!fence.actions) visible.push(line)
        fence = null
      } else if (!fence.actions) visible.push(line)
      continue
    }
    const opening = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/)
    if (opening) {
      fence = { marker: opening[1][0], length: opening[1].length, actions: /^pm-actions(?:\s|$)/i.test(opening[2].trim()) }
      if (fence.actions) continue
    }
    visible.push(line)
  }
  // A truncated action block remains hidden through EOF; ordinary unclosed code stays readable.
  return visible.join('\n').trim()
}
