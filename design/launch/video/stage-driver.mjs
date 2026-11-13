// Shared by the record-*.mjs scripts: open the stage page, record every frame
// through the Chrome screencast, and play narration lines with a pointer.
//
// Needs the web dev server (cd web && bunx vite --port 5288 --host 127.0.0.1)
// and out/<video>/audio/cues.json from tts.py: each line lasts as long as its
// voice, or as long as its actions when those take longer.
// Writes out/<video>/frames/*.jpg and out/<video>/timeline.json for assemble.py.
//
// CAPTIONS=zh records the Chinese-caption cut instead: the same voice
// (out/<video>/audio), the `zh` captions from lines-<video>.json, the stage's
// own words and the app in Chinese; written to out/<video>-zh/.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const HERE = dirname(fileURLToPath(import.meta.url))
const STAGE = process.env.STAGE_URL ?? 'http://127.0.0.1:5288/e2e-fixtures/launch-video-stage.html'
export const ZH = process.env.CAPTIONS === 'zh'
/** The stage's own words in the cut being recorded. */
export const t = (en, zh) => (ZH ? zh : en)

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

/** Opens the stage with `firstScene` showing and starts recording;
 *  `setup` runs on the stage before the first frame. */
export async function openStage(video, firstScene, setup = async () => {}) {
    const out = join(HERE, 'out', ZH ? `${video}-zh` : video)
    const framesDir = join(out, 'frames')
    const cues = JSON.parse(readFileSync(join(HERE, 'out', video, 'audio', 'cues.json'), 'utf8'))
    const zhCaptions = Object.fromEntries(
        JSON.parse(readFileSync(join(HERE, `lines-${video}.json`), 'utf8')).lines.map((line) => [line.id, line.zh ?? []]))
    rmSync(framesDir, { recursive: true, force: true })
    mkdirSync(framesDir, { recursive: true })

    const browser = await chromium.launch({ executablePath: findChrome() })
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
    page.on('dialog', (dialog) => { console.error('unexpected dialog:', dialog.message()); void dialog.accept() })
    page.on('pageerror', (error) => console.error('page error:', String(error).slice(0, 300)))
    await page.goto(ZH ? `${STAGE}?lang=zh` : STAGE, { waitUntil: 'networkidle' })
    await sleep(2500)

    const stage = (name, ...args) => page.evaluate(([n, a]) => window.stage[n](...a), [name, args])

    const frames = []
    const cdp = await page.context().newCDPSession(page)
    cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
        const file = `f${String(frames.length).padStart(6, '0')}.jpg`
        writeFileSync(join(framesDir, file), Buffer.from(data, 'base64'))
        frames.push({ file, t: metadata.timestamp })
        void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
    })
    await stage('setLang', ZH ? 'zh' : 'en')
    await setup(stage)
    await stage('show', firstScene)
    await sleep(300)
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 })
    const t0 = Date.now() / 1000
    await sleep(800)

    const lines = []
    /** One narration line: its captions on the voice's clock, its actions alongside. */
    async function line(id, actions = async () => {}, { gap = 350 } = {}) {
        const cue = cues[id]
        if (!cue) throw new Error(`no audio for line ${id}; run tts.py ${video}`)
        const start = Date.now() / 1000 - t0
        lines.push({ id, start })
        console.log(`${start.toFixed(2).padStart(6)}s  ${id}`)
        const timers = cue.chunks.map((chunk, index) => {
            const text = ZH ? zhCaptions[id][index] : chunk.text
            return setTimeout(() => void stage('caption', text), index === 0 ? 0 : chunk.start * 1000)
        })
        await Promise.all([actions(), sleep(cue.duration * 1000)])
        timers.forEach(clearTimeout)
        await sleep(gap)
    }

    async function centre(locator) {
        await locator.waitFor({ state: 'visible', timeout: 15000 })
        const box = await locator.boundingBox()
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }
    async function pointAt(locator, ms = 700) {
        const { x, y } = await centre(locator)
        await stage('moveTo', x, y, ms)
    }
    async function click(locator, ms) {
        await pointAt(locator, ms)
        await stage('tap')
        await locator.click()
        await sleep(150)
    }
    async function type(locator, text, delay = 30) {
        await locator.click()
        await locator.pressSequentially(text, { delay })
    }

    async function finish() {
        await stage('caption', null)
        await sleep(600)
        await cdp.send('Page.stopScreencast')
        const end = Date.now() / 1000 - t0
        await browser.close()
        const timeline = {
            end,
            lines,
            frames: frames.map((frame) => ({ file: frame.file, t: frame.t - t0 })).filter((frame) => frame.t >= 0)
        }
        writeFileSync(join(out, 'timeline.json'), JSON.stringify(timeline, null, 2))
        console.log(`recorded ${timeline.frames.length} frames over ${end.toFixed(1)}s`)
    }

    return { page, stage, cues, line, pointAt, click, type, finish }
}
