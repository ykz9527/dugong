import '@fontsource-variable/host-grotesk'

// The stage for the launch video (see launch-video-stage.html). Everything the
// recorder needs is on `window.stage`; the app itself runs in the iframes and
// is driven directly by Playwright.

const CSS = `
html, body { margin: 0; background: #fff; overflow: clip; }
#canvas { position: relative; width: 1920px; height: 1080px; overflow: clip; background: #fff;
    font-family: 'Host Grotesk Variable', 'Noto Sans CJK SC', system-ui, sans-serif; color: #111; }
.scene { position: absolute; inset: 0 0 140px 0; opacity: 0; pointer-events: none; transition: opacity 600ms ease, transform 900ms cubic-bezier(.2,.8,.2,1); }
.scene.on { opacity: 1; pointer-events: auto; }

#terminals { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; gap: 28px; padding: 44px 64px; box-sizing: border-box; }
.term { background: #0d0d0d; border-radius: 14px; overflow: hidden; display: flex; flex-direction: column;
    box-shadow: 0 20px 50px rgba(0,0,0,.18); transition: transform 900ms cubic-bezier(.6,0,.2,1), opacity 700ms ease; }
.term header { display: flex; align-items: center; gap: 8px; padding: 12px 16px; background: #1c1c1c; color: #9a9a9a; font: 500 17px 'Host Grotesk Variable'; }
.term header i { width: 12px; height: 12px; border-radius: 50%; background: #3a3a3a; display: inline-block; }
.term header span { margin-left: 10px; }
.term pre { flex: 1; margin: 0; padding: 14px 18px; color: #d8d8d8; font: 19px/1.45 'DejaVu Sans Mono', ui-monospace, monospace; overflow: hidden;
    display: flex; flex-direction: column; justify-content: flex-end; white-space: pre-wrap; }
.term pre b { color: #fff; font-weight: 600; }
.term pre em { color: #7ee787; font-style: normal; }
.term pre u { color: #ff6b6b; text-decoration: none; }
.term.stuck { outline: 3px solid #d12a1e; outline-offset: -3px; }
.term .ask { color: #fff; background: #d12a1e; padding: 0 6px; animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: .35 } }
#terminals.out .term { transform: translate(-560px, 0) scale(.28); opacity: 0; }

/* clip, not hidden: Playwright scrolls hidden overflow to reach a target. */
#desk, #deskB, .scene { overflow: clip; }
#desk iframe, #deskB iframe { position: absolute; left: 0; top: 0; width: 1600px; height: 780px; border: 0; transform: scale(1.2); transform-origin: 0 0; }
#desk .zoom-box, #deskB .zoom-box { position: absolute; inset: 0; transform-origin: 0 0; transition: transform 1000ms cubic-bezier(.3,0,.2,1); }
#desk.lid { transform: perspective(2600px) rotateX(-86deg); transform-origin: 50% 100%; opacity: 0; transition: transform 1100ms cubic-bezier(.6,0,.4,1), opacity 1100ms ease-in; }

#phone { display: flex; align-items: center; justify-content: center; background: #f4f4f4; transform: translateY(50px); }
#phone.on { transform: none; }
.bezel { position: relative; width: 390px; height: 844px; padding: 12px; border-radius: 60px; background: #111; box-shadow: 0 30px 70px rgba(0,0,0,.25); }
.bezel iframe { width: 390px; height: 844px; border: 0; border-radius: 48px; background: #fff; display: block; }
#lock { position: absolute; inset: 12px; border-radius: 48px; overflow: hidden; color: #fff; text-align: center;
    background: radial-gradient(120% 80% at 30% 10%, #3b3b3b 0%, #121212 60%, #000 100%); transition: opacity 500ms ease; }
#lock.gone { opacity: 0; pointer-events: none; }
.lock-time { margin-top: 110px; font-size: 92px; font-weight: 500; letter-spacing: -.03em; }
.lock-date { font-size: 21px; opacity: .8; }
#notification { position: absolute; left: 14px; right: 14px; top: 300px; display: flex; gap: 12px; align-items: flex-start; text-align: left;
    padding: 14px 16px; border-radius: 22px; background: rgba(245,245,245,.92); color: #111;
    transform: translateY(-40px); opacity: 0; transition: transform 500ms cubic-bezier(.2,.9,.2,1.2), opacity 300ms ease; }
#notification.in { transform: none; opacity: 1; }
#notification .note-head { display: flex; justify-content: space-between; font-size: 14px; color: #555; }
#notification .note-head b { color: #111; font-weight: 600; }
#notification .note-title { font-size: 16px; font-weight: 600; margin-top: 2px; }
#notification .note-body { font-size: 16px; }
#notification > div { flex: 1; }

.mark { flex: none; display: block; width: 38px; height: 38px; }
.mark.big { width: 168px; height: 168px; }

#end { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 26px; }
#end h1 { margin: 0; font-size: 128px; font-weight: 600; letter-spacing: -.045em; line-height: 1; }
#end code { font: 32px 'DejaVu Sans Mono', ui-monospace, monospace; padding: 16px 28px; border: 1px solid #111; }
#end p { margin: 0; font-size: 30px; color: #555; }

#badge { position: absolute; top: 28px; right: 36px; padding: 6px 16px; border-radius: 999px; background: #111; color: #fff;
    font: 600 28px 'Host Grotesk Variable'; opacity: 0; transition: opacity 250ms ease; z-index: 20; pointer-events: none; }
#badge.on { opacity: 1; }

#pointer { position: absolute; left: 0; top: 0; width: 34px; height: 34px; z-index: 30; pointer-events: none; opacity: 0;
    transition-property: transform, opacity; transition-timing-function: cubic-bezier(.4,0,.2,1); }
#pointer.on { opacity: 1; }
#pointer svg { width: 34px; height: 34px; filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); }
#pointer.touch svg { display: none; }
#pointer.touch::before { content: ''; position: absolute; left: -22px; top: -22px; width: 44px; height: 44px; border-radius: 50%;
    background: rgba(17,17,17,.28); border: 2px solid rgba(255,255,255,.9); }
#pointer .ring { position: absolute; left: -24px; top: -24px; width: 48px; height: 48px; border-radius: 50%; border: 3px solid #d12a1e; opacity: 0; }
#pointer .ring.go { animation: ring 450ms ease-out; }
@keyframes ring { from { transform: scale(.3); opacity: 1 } to { transform: scale(1.4); opacity: 0 } }

#title { display: flex; align-items: center; justify-content: center; }
#title h1 { margin: 0; max-width: 1400px; text-align: center; font-size: 88px; font-weight: 600; letter-spacing: -.035em; line-height: 1.05; }
/* Sits in the caption strip, left of the caption, so it never covers the app. */
#label { position: absolute; bottom: 47px; left: 32px; z-index: 26; pointer-events: none; padding: 6px 16px; border-radius: 999px;
    font: 600 22px 'Host Grotesk Variable'; opacity: 0; transition: opacity 250ms ease; border: 2px solid #111; background: #fff; color: #111; }
#label.on { opacity: 1; }
#label.dugong { background: #111; color: #fff; }

#duo { display: flex; align-items: center; justify-content: center; gap: 56px; background: #f4f4f4; }
.duo-desk { width: 1360px; height: 663px; overflow: clip; box-shadow: 0 24px 60px rgba(0,0,0,.18); background: #fff; }
.duo-desk iframe { width: 1600px; height: 780px; border: 0; transform: scale(.85); transform-origin: 0 0; }
.bezel.small { transform: scale(.8); margin: -84px -39px; }

#phoneB { display: flex; align-items: center; justify-content: center; background: #f4f4f4; }
#banner { position: absolute; left: 22px; right: 22px; top: 22px; display: flex; gap: 12px; align-items: flex-start; padding: 14px 16px;
    border-radius: 22px; background: rgba(240,240,240,.97); color: #111; box-shadow: 0 10px 30px rgba(0,0,0,.25);
    transform: translateY(-140px); transition: transform 500ms cubic-bezier(.2,.9,.2,1.15); }
#banner.in { transform: none; }
#banner > div { flex: 1; }
#banner .note-head { display: flex; justify-content: space-between; font-size: 14px; color: #555; }
#banner .note-head b { color: #111; font-weight: 600; }
#banner .note-title { font-size: 16px; font-weight: 600; margin-top: 2px; }
#banner .note-body { font-size: 16px; }

#single { display: flex; align-items: center; justify-content: center; background: #f4f4f4; }
.mock-phone { width: 390px; height: 844px; border-radius: 48px; background: #fff; box-sizing: border-box; padding: 64px 22px 24px; display: flex; flex-direction: column; gap: 16px; font-size: 18px; }
.mock-top { font-weight: 600; font-size: 20px; padding-bottom: 12px; border-bottom: 1px solid #e5e5e5; }
.mock-top small { font-weight: 400; color: #777; font-size: 15px; }
.mock-msg { padding: 10px 14px; border-radius: 14px; background: #f1f1f1; max-width: 86%; }
.mock-msg.me { align-self: flex-end; background: #111; color: #fff; }
.mock-card { border: 1px solid #ddd; border-radius: 14px; padding: 12px 14px; font-weight: 600; }
.mock-card code { font: 400 14px 'DejaVu Sans Mono', monospace; color: #444; }
.mock-buttons { display: flex; gap: 10px; margin-top: 12px; }
.mock-buttons span { padding: 6px 16px; border-radius: 999px; border: 1px solid #111; font-weight: 600; font-size: 15px; }
.mock-buttons span:first-child { background: #111; color: #fff; }
.mock-other { margin-top: auto; text-align: center; color: #999; font-size: 16px; padding: 18px; border: 1px dashed #ccc; border-radius: 14px; }

#procs { display: flex; align-items: center; justify-content: center; background: #0d0d0d; }
.procs { width: 1300px; font: 30px/1 'DejaVu Sans Mono', monospace; color: #d8d8d8; }
.procs > div { display: grid; grid-template-columns: 220px 440px 380px 1fr; padding: 22px 28px; border-bottom: 1px solid #2a2a2a; }
.procs-head { color: #777; font-size: 22px !important; }
.procs .ok { color: #7ee787; }
.procs .really-waiting.reveal { outline: 3px solid #d12a1e; outline-offset: -3px; }
.procs .really-waiting.reveal::after { content: attr(data-note); font-family: 'DejaVu Sans Mono', 'Noto Sans Mono CJK SC', monospace; grid-column: 1 / -1; margin-top: 14px; color: #ff6b6b; font-size: 22px; }

#stuck { display: flex; align-items: center; justify-content: center; background: #f4f4f4; }
.term.big { width: 1400px; height: 640px; }
.term.big pre { font-size: 28px; justify-content: flex-start; padding: 30px 34px; }
.term.big header { font-size: 20px; }
.term.big .waited { margin-left: auto; font-style: normal; color: #ff6b6b; font-weight: 600; }

#table { display: flex; align-items: center; justify-content: center; }
.cmp { width: 1640px; }
.cmp-row { display: grid; grid-template-columns: 360px 1fr 1fr; gap: 40px; padding: 26px 0; border-bottom: 1px solid #e3e3e3; font-size: 30px; line-height: 1.25;
    opacity: 0; transform: translateY(14px); transition: opacity 450ms ease, transform 450ms ease; }
.cmp-row.in { opacity: 1; transform: none; }
.cmp-row > span:first-child { font-weight: 600; }
.cmp-row > span:nth-child(2) { color: #777; }
.cmp-row > span:nth-child(3) { font-weight: 500; }
.cmp-row.head { font-size: 24px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; border-bottom: 2px solid #111; }
.cmp-row.head > span:nth-child(3) { color: #d12a1e; }

#caption { position: absolute; left: 0; right: 0; bottom: 0; height: 140px; border-top: 1px solid #e3e3e3; background: #fff;
    display: flex; align-items: center; justify-content: center; z-index: 25; pointer-events: none; }
#caption p { margin: 0; max-width: 1360px; text-align: center; font-size: 36px; line-height: 1.3; font-weight: 500; letter-spacing: -.01em;
    transition: opacity 160ms ease; }
`

const TERMINALS: { title: string; lines: string[]; stuck?: boolean }[] = [
    {
        title: 'claude — ~/code/dugong',
        lines: [
            '<b>⏺</b> Read(cli/src/runner/run.ts)', '  ⎿  Read 812 lines', '<b>⏺</b> Grep(persistSpawnedSession)', '  ⎿  Found 3 matches',
            '<b>⏺</b> Update(cli/src/runner/run.ts)', '  ⎿  Updated with 4 additions', '<b>⏺</b> Bash(bun run test --filter runner)', '  ⎿  <em>86 pass</em> · 0 fail',
            '<b>⏺</b> Read(cli/src/runner/handoff.ts)', '  ⎿  Read 240 lines'
        ]
    },
    {
        title: 'codex — ~/code/api',
        lines: [
            '• Explored', '  └ Search rate limit in src/', '• Ran npm run lint', '  └ <em>0 problems</em>', '• Edited src/middleware/limit.ts (+18 -4)',
            '• Ran npm test', '  └ 112 passing (9s)', '• Working (1m 12s • esc to interrupt)'
        ]
    },
    {
        title: 'claude — ~/code/web',
        stuck: true,
        lines: [
            '<b>⏺</b> Bash(rm -rf node_modules/.vite && bun run build)', '', '  Bash command', '    rm -rf node_modules/.vite && bun run build',
            '    Clear the Vite cache and rebuild', ''
        ]
    },
    {
        title: 'codex — ~/code/docs',
        lines: [
            '• Edited guide/quick-start.md (+42 -9)', '• Ran npm run docs:build', '  └ build complete in 6.4s', '',
            '› Done. Want me to open a PR?', '', '▌'
        ]
    }
]

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = ''): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
    node.innerHTML = html
    return node
}

const style = el('style')
style.textContent = CSS
document.head.appendChild(style)

const $ = (selector: string) => document.querySelector(selector) as HTMLElement

// Terminals: each scrolls on its own clock; the stuck one waits on y/n.
const terminalTimers: number[] = []
function buildTerminals(): void {
    const host = $('#terminals')
    for (const spec of TERMINALS) {
        const term = el('div', { class: `term${spec.stuck ? ' stuck' : ''}` })
        term.appendChild(el('header', {}, `<i></i><i></i><i></i><span>${spec.title}</span>`))
        const pre = el('pre')
        term.appendChild(pre)
        host.appendChild(term)
        let index = 0
        const step = () => {
            if (index < spec.lines.length) {
                pre.innerHTML += `${spec.lines[index]}\n`
                index += 1
            } else if (spec.stuck) {
                pre.innerHTML += '  Allow this command? <span class="ask">(y/n)</span>'
                return
            } else {
                index = 0
            }
            terminalTimers.push(window.setTimeout(step, spec.stuck ? 420 : 260 + Math.random() * 360))
        }
        step()
    }
}
buildTerminals()

// `?lang=zh` (the Chinese-caption cut) runs the app in Chinese too: the
// demo's default, so drop the iframes' `lang=en`.
const appInChinese = new URLSearchParams(location.search).get('lang') === 'zh'
for (const frame of document.querySelectorAll<HTMLIFrameElement>('iframe[data-src]')) {
    const src = appInChinese ? (frame.dataset.src ?? '').replace(/lang=en&?/, '') : frame.dataset.src
    frame.src = `/e2e-fixtures/assistant-panel-demo.html${src}`
}

// Each desktop iframe sits in a box the zoom transforms.
for (const id of ['desk', 'deskB']) {
    const frame = $(`#${id} iframe`)
    const box = el('div', { class: 'zoom-box' })
    $(`#${id}`).appendChild(box)
    box.appendChild(frame)
}

const pointer = $('#pointer')
pointer.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 2l15 11.5-6.8 1.1 3.9 7.2-2.6 1.4-3.9-7.3L4 20.6z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg><div class="ring"></div>'
let pointerAt = { x: 960, y: 520 }

const stage = {
    show(scene: string, on = true): void {
        $(`#${scene}`).classList.toggle('on', on)
    },
    caption(text: string | null): void {
        const p = $('#caption p')
        p.style.opacity = '0'
        window.setTimeout(() => {
            p.textContent = text ?? ''
            p.style.opacity = text ? '1' : '0'
        }, text ? 120 : 0)
    },
    badge(text: string | null): void {
        const badge = $('#badge')
        if (text) badge.textContent = text
        badge.classList.toggle('on', Boolean(text))
    },
    terminalsOut(): void {
        $('#terminals').classList.add('out')
        window.setTimeout(() => stage.show('terminals', false), 700)
    },
    zoom(scale: number, originX = 0, originY = 0, scene = 'desk'): void {
        const box = $(`#${scene} .zoom-box`)
        box.style.transformOrigin = `${originX}px ${originY}px`
        box.style.transform = scale === 1 ? '' : `scale(${scale})`
    },
    title(text: string): void {
        $('#title h1').textContent = text
    },
    label(text: string | null): void {
        const label = $('#label')
        if (text) {
            label.textContent = text
            label.classList.toggle('dugong', text === 'dugong')
        }
        label.classList.toggle('on', Boolean(text))
    },
    banner(): void {
        $('#banner').classList.add('in')
    },
    revealWaiting(): void {
        $('.procs .really-waiting').classList.add('reveal')
    },
    /** Swap the stage's own words (not the app's) for their `data-zh` versions. */
    setLang(lang: 'en' | 'zh'): void {
        if (lang !== 'zh') return
        for (const node of document.querySelectorAll<HTMLElement>('[data-zh]')) node.textContent = node.dataset.zh ?? ''
        for (const node of document.querySelectorAll<HTMLElement>('[data-zh-note]')) node.dataset.note = node.dataset.zhNote
    },
    tableRow(index: number): void {
        document.querySelectorAll('.cmp-row')[index]?.classList.add('in')
    },
    closeLid(): void {
        $('#desk').classList.add('lid')
    },
    notify(): void {
        $('#notification').classList.add('in')
    },
    unlock(): void {
        $('#lock').classList.add('gone')
    },
    pointer(on: boolean, mode: 'mouse' | 'touch' = 'mouse'): void {
        pointer.classList.toggle('on', on)
        pointer.classList.toggle('touch', mode === 'touch')
    },
    /** Glide the pointer to (x, y) over `ms`; resolves when it arrives. */
    moveTo(x: number, y: number, ms = 700): Promise<void> {
        const distance = Math.hypot(x - pointerAt.x, y - pointerAt.y)
        const duration = Math.min(ms, Math.max(250, distance * 0.9))
        pointer.style.transitionDuration = `${duration}ms`
        pointer.style.transform = `translate(${x}px, ${y}px)`
        pointerAt = { x, y }
        return new Promise((resolve) => window.setTimeout(resolve, duration + 30))
    },
    jumpTo(x: number, y: number): void {
        pointer.style.transitionDuration = '0ms'
        pointer.style.transform = `translate(${x}px, ${y}px)`
        pointerAt = { x, y }
    },
    tap(): void {
        const ring = pointer.querySelector('.ring') as HTMLElement
        ring.classList.remove('go')
        void ring.offsetWidth
        ring.classList.add('go')
    }
}

declare global {
    interface Window { stage: typeof stage }
}
window.stage = stage
