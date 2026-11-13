// Takes the README screenshots from the demo page (real UI, fake data) and
// writes them to docs/assets/ and website/public/images/.
//
//   cd web && bunx vite --port 5288 --host 127.0.0.1 &
//   node design/launch/screenshots.mjs

import { copyFileSync, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ASSETS = join(ROOT, 'docs', 'assets')
const WEBSITE_IMAGES = join(ROOT, 'website', 'public', 'images')
const DEMO = process.env.DEMO_URL ?? 'http://127.0.0.1:5288/e2e-fixtures/assistant-panel-demo.html'

function findChrome() {
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH
    const root = join(homedir(), '.cache', 'ms-playwright')
    const dirs = existsSync(root) ? readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : []
    for (const dir of dirs) {
        const path = join(root, dir, 'chrome-linux64', 'chrome')
        if (existsSync(path)) return path
    }
    return undefined
}

const DESKTOP = { width: 1600, height: 900, scale: 1.25 }
const PHONE = { width: 390, height: 844, scale: 2 }

const shots = [
    // The task list, a task in Review, and the assistant asking to message it.
    { file: 'screenshot-desktop.png', query: 'lang=en&path=/sessions/s-handoff', size: DESKTOP },
    { file: 'screenshot-desktop-dark.png', query: 'lang=en&theme=dark&path=/sessions/s-handoff', size: DESKTOP },
    { file: 'screenshot-phone-tasks.png', query: 'lang=en&after=1&path=/', size: PHONE },
    // A task waiting on a command; Allow is one tap.
    { file: 'screenshot-phone-approve.png', query: 'lang=en&after=1&path=/sessions/s-codex', size: PHONE },
    // The task panel: where it is in its life, its branch, its pull request.
    {
        file: 'screenshot-task-detail.png',
        query: 'lang=en&after=1&assistant=0&path=/sessions/s-mobile',
        size: DESKTOP,
        before: async (page) => {
            const row = page.locator('[data-task-id="t-mobile"]')
            await row.hover()
            await row.getByRole('button', { name: 'Details' }).click()
            await page.waitForTimeout(900)
        }
    }
]

const browser = await chromium.launch({ executablePath: findChrome() })
for (const shot of shots) {
    const phone = shot.size === PHONE
    const page = await browser.newPage({
        viewport: { width: shot.size.width, height: shot.size.height },
        deviceScaleFactor: shot.size.scale,
        isMobile: phone,
        hasTouch: phone
    })
    page.on('pageerror', (error) => console.error(`${shot.file}: ${String(error).slice(0, 200)}`))
    await page.goto(`${DEMO}?${shot.query}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1500)
    if (shot.before) await shot.before(page)
    await page.mouse.move(0, shot.size.height - 1)
    await page.screenshot({ path: join(ASSETS, shot.file) })
    copyFileSync(join(ASSETS, shot.file), join(WEBSITE_IMAGES, shot.file))
    console.log(shot.file)
    await page.close()
}
await browser.close()
