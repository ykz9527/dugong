// Create an offline reader alongside the original Markdown and screenshots.
import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs'
import { createRequire } from 'node:module'
const docsRequire = createRequire(new URL('../../docs/package.json', import.meta.url))
const { createMarkdownRenderer } = await import(docsRequire.resolve('vitepress'))
const source = new URL('../../docs/manual/', import.meta.url).pathname
const output = process.env.DOCS_OFFLINE_OUT ?? '/tmp/dugong-illustrated-manual'
mkdirSync(output, { recursive: true })
cpSync(source, output + '/markdown', { recursive: true })
cpSync(source + '/assets', output + '/assets', { recursive: true })
const index = readFileSync(source + '/index.md', 'utf8')
const order = ['index', ...new Set([...index.matchAll(/\]\(([a-z-]+)\.md(?:#[^)]+)?\)/g)].map(m => m[1]).filter(x => x !== 'index'))]
const md = await createMarkdownRenderer(source, { html: true, linkify: false }, '/')
const originalImage = md.renderer.rules.image
md.renderer.rules.image = (tokens, i, options, env, self) => {
    tokens[i].attrSet('loading', 'lazy')
    return originalImage(tokens, i, options, env, self)
}
let nav = ''; let articles = ''
for (const slug of order) {
    const file = source + '/' + slug + '.md'
    let text = readFileSync(file, 'utf8')
    const title = text.match(/^# (.+)$/m)?.[1] ?? slug
    text = text.replace(/<a name="([\w-]+)"><\/a>/g, (_, anchor) => `<a id="${slug}--${anchor}"></a>`)
    text = text.replace(/\]\(([a-z-]+)\.md(?:#([\w-]+))?\)/g, (_, target, anchor) => `](#${target}${anchor ? '--' + anchor : ''})`)
    text = text.replace(/\]\(\.\.\/([^)]*)\)/g, (_, target) => `](https://github.com/ykz9527/dugong/blob/main/docs/${target})`)
    nav += `<a href="#${slug}">${title}</a>`
    articles += `<article id="${slug}">${md.render(text)}</article>`
}
writeFileSync(output + '/index.html', `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>dugong 功能图文手册</title><style>
:root{color-scheme:light;--ink:#172526;--soft:#f2f6f4;--line:#dce5df;--accent:#136957}*{box-sizing:border-box}body{margin:0;color:var(--ink);background:#fff;font:16px/1.85 system-ui,-apple-system,"Noto Sans CJK SC","Microsoft YaHei",sans-serif}aside{position:fixed;inset:0 auto 0 0;width:286px;padding:28px 22px;background:var(--soft);overflow:auto;border-right:1px solid var(--line)}aside strong{display:block;font-size:27px;margin-bottom:4px}aside small{display:block;color:#536862;margin-bottom:18px}input{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;font:inherit;margin-bottom:18px}nav a{display:block;color:var(--ink);text-decoration:none;padding:7px 9px;font-size:14px;border-radius:6px}nav a[hidden]{display:none}nav a:hover{background:#deebe4}main{margin-left:286px;padding:36px 5vw;max-width:1500px}article{padding-bottom:42px;margin-bottom:48px;border-bottom:1px solid var(--line);scroll-margin-top:20px}h1{font-size:32px;line-height:1.4;margin:0 0 22px}h2{font-size:24px;margin-top:42px;scroll-margin-top:25px}a{color:var(--accent);text-underline-offset:3px}img{max-width:100%;height:auto;max-height:650px;object-fit:contain;object-position:left;border:1px solid var(--line);border-radius:8px;background:#fafcfa;cursor:zoom-in}table{width:100%;border-collapse:collapse;font-size:14px;margin:22px 0}th,td{border:1px solid var(--line);padding:11px 14px;text-align:left;vertical-align:top}th{background:var(--soft)}code{overflow-wrap:anywhere;font-size:.9em;background:var(--soft);padding:2px 5px;border-radius:4px}pre{overflow:auto;padding:18px;background:var(--soft)}pre code{padding:0}li{margin:7px 0}dialog{border:0;padding:12px;max-width:96vw;max-height:96vh;border-radius:10px}dialog::backdrop{background:#172526cc}dialog img{max-height:88vh;max-width:92vw;cursor:zoom-out}dialog button{display:block;margin-left:auto;border:0;padding:5px 12px;cursor:pointer} .meta{color:#536862;border-left:3px solid var(--accent);padding-left:15px;margin-bottom:28px}@media(max-width:800px){aside{position:static;width:auto;max-height:300px;border-bottom:1px solid var(--line)}main{margin:0;padding:26px 18px}h1{font-size:26px}table{display:block;overflow:auto}img{max-height:500px}}@media print{aside{display:none}main{margin:0}article{break-before:page}img{max-height:400px}}
</style></head><body><aside><strong>dugong</strong><small>功能图文手册 · 离线阅读版</small><input id="search" aria-label="筛选目录" placeholder="搜索章节名称"><nav>${nav}</nav></aside><main><p class="meta">真实界面 · 演示数据 · 点击插图可放大。功能说明不代表 1.0.0 已发布。</p>${articles}</main><dialog id="zoom"><button type="button">关闭</button><img alt="放大的界面截图"></dialog><script>
const search=document.getElementById('search');search.addEventListener('input',()=>{for(const a of document.querySelectorAll('nav a'))a.hidden=!a.textContent.toLowerCase().includes(search.value.toLowerCase())});const zoom=document.getElementById('zoom');for(const img of document.querySelectorAll('main img'))img.addEventListener('click',()=>{zoom.querySelector('img').src=img.src;zoom.showModal()});zoom.addEventListener('click',()=>zoom.close());
</script></body></html>`)
writeFileSync(output + '/打开说明.txt', '解压后用浏览器打开 index.html。保持 assets 文件夹在旁边。左侧目录可跳转，图片可点击放大。markdown 目录保留原始文档与截图。\n')
console.log(output + '/index.html')
