import { readFile, writeFile } from 'node:fs/promises'

// 唯一内容源：docs/releases/notes.json。HTML 不依赖网络、业务 API 或登录数据。
const root = new URL('../', import.meta.url)
const notes = JSON.parse(await readFile(new URL('docs/releases/notes.json', root), 'utf8'))
const css = await readFile(new URL('docs/releases/style.css', root), 'utf8')
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const list = (items) => `<ul>${items.map((item) => `<li>${escape(item)}</li>`).join('')}</ul>`
const ids = new Set()
let previousDate = '9999-12-31'
for (const release of notes.releases) {
  if (!/^[a-z0-9-]+$/.test(release.id) || ids.has(release.id)) throw new Error(`Invalid or duplicate release id: ${release.id}`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(release.date) || release.date > previousDate) throw new Error('Release dates must be newest first')
  ids.add(release.id)
  previousDate = release.date
}
const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="CMC-PMS 新功能说明、旧新版本对照与历次更新记录。">
<title>${escape(notes.product)} · ${escape(notes.title)}</title>
<style>${css}</style>
</head>
<body>
<a class="skip" href="#main">跳转到正文</a>
<header class="topbar"><a class="wordmark" href="#main"><span class="mark">C</span> ${escape(notes.product)} <span class="wordmark-sub">产品手册</span></a><a class="download" href="release-notes.html" download="CMC-PMS-功能说明与更新记录.html">下载 HTML <span aria-hidden="true">↗</span></a></header>
<main id="main" class="shell">
<section class="hero" aria-labelledby="page-title">
  <div class="eyebrow">WHAT’S NEW <span></span> ${escape(notes.edition)}</div>
  <h1 id="page-title">${escape(notes.title)}</h1>
  <p class="lead">${escape(notes.intro)}</p>
  <div class="hero-meta"><span class="pill">功能说明 · ${escape(notes.releases[0].date)}</span><span>面向管理者与项目执行团队</span></div>
  <div class="hero-bottom"><span><b>01</b> AI 分析</span><span><b>02</b> 团队协作</span><span><b>03</b> 统一身份</span></div>
</section>
<nav class="contents" aria-label="说明章节"><a href="#features">新功能亮点</a><a href="#comparison">旧新版本对照</a><a href="#getting-started">按角色上手</a><a href="#releases">Release notes <span>${notes.releases.length}</span></a></nav>
<section id="features" class="section" aria-labelledby="features-title">
  <div class="section-heading"><div><p class="eyebrow">FEATURE HIGHLIGHTS</p><h2 id="features-title">这次升级，带来了什么</h2></div><p>找到入口，了解用途，再开始使用。</p></div>
  <div class="feature-grid">${notes.features.map((f) => `<article class="feature${f.highlight ? ' feature-major' : ''}"><div class="feature-top"><span class="feature-number">${escape(f.number)}</span><div class="feature-badges"><span class="tag">${escape(f.tag)}</span>${f.highlight ? `<span class="major-badge">${escape(f.highlight)}</span>` : ''}</div></div><h3>${escape(f.title)}</h3><p>${escape(f.description)}</p><footer><div><span class="label">在哪里</span>${escape(f.entry)}</div><div><span class="label">谁能用</span>${escape(f.audience)}</div></footer></article>`).join('')}</div>
</section>
<section id="comparison" class="section" aria-labelledby="comparison-title">
  <div class="section-heading"><div><p class="eyebrow">BEFORE & AFTER</p><h2 id="comparison-title">旧版与新版，一页对照</h2></div></div>
  <p class="section-note">${escape(notes.comparisonNote)}</p>
  <div class="table-wrap" role="region" aria-label="旧新功能对照表，可横向滚动" tabindex="0"><table><caption class="sr-only">旧版 Lite 与新版 IAM 协作版功能对照</caption><thead><tr><th scope="col">功能</th><th scope="col">旧版 Lite</th><th scope="col">新版 IAM 协作版</th><th scope="col">变化</th></tr></thead><tbody>${notes.comparison.map((row) => `<tr><th scope="row">${escape(row[0])}</th><td>${escape(row[1])}</td><td>${escape(row[2])}</td><td><span class="${row[3] === '重大升级' ? 'major-badge' : 'tag'}">${escape(row[3])}</span></td></tr>`).join('')}</tbody></table></div>
</section>
<section id="getting-started" class="section" aria-labelledby="roles-title">
  <div class="section-heading"><div><p class="eyebrow">GET STARTED</p><h2 id="roles-title">从适合你的入口开始</h2></div></div>
  <div class="role-grid">${notes.roles.map((role) => `<article class="role-card"><h3>${escape(role.name)}</h3><ol>${role.steps.map((step) => `<li>${escape(step)}</li>`).join('')}</ol></article>`).join('')}</div>
  <aside class="boundary" aria-labelledby="boundary-title"><h3 id="boundary-title">使用前，了解这些边界</h3>${list(notes.boundaries)}</aside>
</section>
<section id="releases" class="section" aria-labelledby="releases-title">
  <div class="section-heading"><div><p class="eyebrow">RELEASE NOTES</p><h2 id="releases-title">每一次变化，都有记录</h2></div><p>按时间倒序 · 展开查看详情</p></div>
  <p class="section-note">以下名称用于区分功能阶段。历史日期依据代码提交记录整理，不等同于客户环境的上线日期。</p>
  <div class="release-list">${notes.releases.map((r, i) => `<details class="release" id="${escape(r.id)}"${i < 2 ? ' open' : ''}><summary><span class="release-date"><time datetime="${escape(r.date)}">${escape(r.date)}</time><span class="release-version">${escape(r.version)}</span></span><span class="release-title">${escape(r.title)}${i === 0 ? '<span class="latest">本次更新</span>' : ''}</span><span class="expand" aria-hidden="true">+</span></summary><div class="release-body"><p>${escape(r.summary)}</p>${r.changes.map((group) => `<div class="change-group"><h3>${escape(group.type)}</h3>${list(group.items)}</div>`).join('')}</div></details>`).join('')}</div>
</section>
<footer class="page-footer"><span>${escape(notes.product)} · ${escape(notes.title)}</span><span>功能随版本持续完善，权限以实际账号为准。</span></footer>
</main>
</body>
</html>
`
await writeFile(new URL('public/release-notes.html', root), html)
console.log(`Generated public/release-notes.html (${notes.releases.length} releases)`)
