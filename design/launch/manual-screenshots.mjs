// Run after: CHOKIDAR_USEPOLLING=1 bun run --cwd web dev -- --port 5288
// Uses production components and synthetic data; never points at a live hub.
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
const base = process.env.DOCS_DEMO_URL ?? 'http://127.0.0.1:5288'
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('Use a local fixture server')
const language = process.env.DOCS_LANG ?? 'zh-CN'
if (!['zh-CN', 'en'].includes(language)) throw new Error('DOCS_LANG must be zh-CN or en')
const english = language === 'en'
const label = (zh, en) => english ? en : zh
const out = new URL(english ? '../../docs/manual/en/assets/' : '../../docs/manual/assets/', import.meta.url).pathname
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ args: ['--no-sandbox'] })
const manifest = []
const mask = { configured: false, source: 'none', hint: null, editable: true }
const totals = { totalTokens: 128000, inputTokens: 100000, outputTokens: 28000, cacheReadTokens: 64000, cacheCreationTokens: 8000, uncachedTokens: 64000, requests: 24, sessions: 4 }
async function mock(route) {
    const url = new URL(route.request().url()); const path = url.pathname
    if (!path.startsWith('/api/')) return route.continue()
    let data = {}
    if (path === '/api/machines') data = { machines: [{ id: 'm-devbox', active: true, activeAt: Date.now(), metadata: { host: 'devbox', displayName: label('演示开发机', 'Demo workstation'), platform: 'linux', homeDir: '/home/demo', workspaceRoots: ['/home/demo/projects'] } }] }
    else if (path === '/api/storage/sqlite') data = { path: '~/.dugong/dugong.db', databaseBytes: 125829120, walBytes: 8388608, shmBytes: 32768, totalBytes: 134250496 }
    else if (path === '/api/usage/summary') data = { totals, daily: [{ date: '2026-11-12', totalTokens: 48000 }, { date: '2026-11-13', totalTokens: 80000 }], byAgent: [{ key: 'codex', ...totals }], byModel: [{ key: label('示例模型', 'Example model'), ...totals }] }
    else if (path === '/api/git-host/tokens') data = { tokens: [] }
    else if (path === '/api/voice/backend') data = { backend: null, backends: [] }
    else if (path.endsWith('/transcription/providers')) data = { providers: [] }
    else if (path.endsWith('/transcription/credentials')) data = { openai: mask, elevenlabs: mask, deepgram: mask, groq: mask, openaiCompatible: { ...mask, baseUrl: null, model: null, baseUrlEditable: true, modelEditable: true, apiKey: mask }, voiceBackends: { elevenlabs: mask, geminiLive: mask, qwenRealtime: mask } }
    else if (path.endsWith('/scratchlist')) data = { entries: [] }
    else if (path === '/api/sessions/demo') data = { session: { id: 'demo', active: true, thinking: false, metadata: { name: label('修复登录页', 'Fix the sign-in page'), path: '/home/demo/projects/dugong', host: 'devbox', flavor: 'claude' }, metadataVersion: 1, agentState: {}, agentStateVersion: 1, permissionMode: 'default' } }
    else if (path.endsWith('/git-status')) data = { success: true, stdout: '# branch.head task/login\n1 .M N... 100644 100644 100644 aaaaaaa aaaaaaa README.md\n1 M. N... 100644 100644 100644 aaaaaaa bbbbbbb src/login.ts\n? docs/guide.md\n', stderr: '', exitCode: 0 }
    else if (path.endsWith('/git-diff-numstat')) data = { success: true, stdout: '4\t1\tREADME.md\n8\t2\tsrc/login.ts\n', stderr: '', exitCode: 0 }
    else if (path.endsWith('/directory')) data = { success: true, entries: [{ name: 'src', type: 'directory' }, { name: 'docs', type: 'directory' }, { name: 'README.md', type: 'file', size: 1024 }, { name: 'package.json', type: 'file', size: 1024 }] }
    else if (path.endsWith('/file')) data = { success: true, content: Buffer.from('# 演示项目\n\n这是文档截图用的示例文件。\n\n| 功能 | 状态 |\n| --- | --- |\n| 登录 | 已完成 |\n').toString('base64') }
    else if (path.endsWith('/git-diff-file')) data = { success: true, stdout: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n-# 项目\n+# 演示项目\n+使用 dugong 管理任务。\n', stderr: '', exitCode: 0 }
    else if (path.includes('paths-exists')) data = { exists: { '/home/demo/projects/dugong': true } }
    else if (path.includes('sessions')) data = { sessions: [] }
    await route.fulfill({ json: data })
}
async function shot(name, fixture, query = '', action, mobile = false) {
    if (process.env.DOCS_SHOTS && !process.env.DOCS_SHOTS.split(',').includes(name)) return
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
    page.setDefaultTimeout(10000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') console.error(name, message.text()) })
    await page.addInitScript(lang => localStorage.setItem('hapi-lang', lang), language)
    const params = new URLSearchParams(query)
    params.set('lang', english ? 'en' : 'zh-CN')
    query = params.toString()
    await page.route('**/api/**', mock)
    await page.goto(`${base}${fixture === 'app' ? '/' : '/e2e-fixtures/' + fixture + '.html'}${query ? '?' + query : ''}`)
    await page.waitForFunction(() => (document.getElementById('root')?.innerText.trim().length ?? 0) > 10)
    await page.waitForTimeout(1000)
    if (action) await action(page)
    await page.waitForTimeout(400)
    await page.mouse.move(0, 0)
    if (errors.length) throw new Error(`${name}: ${errors.join('; ')}`)
    await page.screenshot({ path: out + name + '.png', fullPage: true })
    const text = await page.locator('body').innerText()
    if (text.includes('Something went wrong!')) throw new Error(name + ': error boundary rendered')
    manifest.push({ name, fixture, query, text })
    console.log(name)
    await page.close()
}
try {
    await shot('login', 'app')
    for (const key of ['general','display','chat','voice','machines','git-host','storage','usage','about','voice/voices','voice/advanced']) {
        await shot('settings-' + key.replace('/', '-'), 'manual-fixture', 'path=/settings/' + key)
    }
    for (const key of ['display', 'chat']) await shot('settings-' + key + '-lower', 'manual-fixture', 'path=/settings/' + key, p => p.locator('main').evaluate(el => { el.scrollTop = el.scrollHeight }))
    await shot('new-session', 'manual-fixture', 'path=/sessions/new')
    await shot('files', 'manual-fixture', 'path=/sessions/demo/files')
    await shot('directories', 'manual-fixture', 'path=/sessions/demo/files', p => p.getByRole('tab').nth(1).click())
    await shot('file', 'manual-fixture', 'path=' + encodeURIComponent('/sessions/demo/file?path=' + Buffer.from('README.md').toString('base64')))
    await shot('session-menu', 'manual-fixture', 'path=/sessions/demo/files', p => p.getByRole('button',{name:label('更多操作', 'More actions'),exact:true}).click())
    await shot('session-export', 'manual-fixture', 'path=/sessions/demo/files', async p => {await p.getByRole('button',{name:label('更多操作', 'More actions'),exact:true}).click();await p.getByText(label('导出对话', 'Export conversation'),{exact:true}).click()})
    await shot('terminal', 'manual-fixture', 'path=/sessions/demo/terminal')
    await shot('terminal-mobile', 'manual-fixture', 'path=/sessions/demo/terminal', undefined, true)
    await shot('overview', 'assistant-panel-demo', 'path=/sessions/s-handoff')
    await shot('mobile', 'assistant-panel-demo', 'assistant=0&path=/', undefined, true)
    await shot('approval', 'assistant-panel-demo', 'assistant=0&path=/sessions/s-codex')
    await shot('composer', 'assistant-panel-demo', 'assistant=0&path=/sessions/s-handoff')
    await shot('users', 'assistant-panel-demo', 'assistant=0&path=/sessions/s-handoff', p => p.getByRole('combobox',{name:label('只看谁的任务', 'Show work belonging to')}).selectOption({label:label('管理用户…', 'Manage users…')}))
    await shot('adopt', 'assistant-panel-demo', 'assistant=0&path=/sessions/s-handoff', async p => {await p.getByTitle(label('新建任务', 'New task'),{exact:true}).click();await p.getByRole('button',{name:label('接管已有会话', 'Adopt a session'),exact:true}).click()})
    await shot('new-task', 'assistant-panel-demo', 'assistant=0&path=/sessions/s-handoff', p => p.getByTitle(label('新建任务', 'New task'), {exact:true}).click())
    await shot('task-archive', 'assistant-panel-demo', 'assistant=0&path=/sessions/s-spawn', async p => {const row=p.locator('[data-task-id="t-spawn"]');await row.hover();await row.getByRole('button',{name:label('详情', 'Details'),exact:true}).click()})
    await shot('task-detail', 'assistant-panel-demo', 'assistant=0&path=/sessions/s-mobile', async p => {const row=p.locator('[data-task-id="t-mobile"]');await row.hover();await row.getByRole('button',{name:label('详情', 'Details'),exact:true}).click()})
    await shot('task-schedule', 'assistant-panel-demo', 'assistant=0&path=/sessions/s-mobile', async p => {const row=p.locator('[data-task-id="t-mobile"]');await row.hover();await row.getByRole('button',{name:label('详情', 'Details'),exact:true}).click();await p.getByRole('button',{name:label('定时运行', 'Run on a schedule'),exact:true}).click()})
    await shot('assistant-memory', 'assistant-panel-demo', 'path=/sessions/s-handoff', p => p.locator('button').filter({hasText:english ? /^Memory/ : /^记忆/}).click())
    await shot('assistant-questions', 'assistant-panel-demo', 'path=/sessions/s-handoff', p => p.locator('button').filter({hasText:english ? /^To answer/ : /^待答/}).click())
    await shot('message-schedule', 'assistant-panel-demo', 'assistant=0&path=/sessions/s-handoff', p => p.getByRole('button',{name:label('定时发送', 'Schedule send'),exact:true}).first().click())
    await shot('share', 'share-turn-fixture', '', p => p.getByRole('button',{name:'Open share preview'}).click())
    await shot('scratchlist', 'scratchlist-fixture')
    await shot('terminal-output', 'terminal-wrap-fixture')
} finally {
    writeFileSync(english ? '/tmp/dugong-manual-screenshots-en.json' : '/tmp/dugong-manual-screenshots.json', JSON.stringify(manifest, null, 2))
    await browser.close()
}
