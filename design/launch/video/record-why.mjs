// Plays the "why dugong" video's script on the stage page and records every frame.
//
//   node design/launch/video/record-why.mjs
//
// Each difference is two shots: the usual setup (drawn on the stage, no
// product named), then dugong doing it in the real app. See stage-driver.mjs
// for what it needs and writes.

import { openStage, sleep, t } from './stage-driver.mjs'

const { page, stage, cues, line, pointAt, click, finish } = await openStage('why', 'title', async (stage) => {
    await stage('title', t('What dugong does differently', 'dugong 有什么不同'))
})
const deskB = page.frameLocator('#deskB iframe')
const duoDesk = page.frameLocator('#duo .duo-desk iframe')
const duoPhone = page.frameLocator('#duo .bezel iframe')
const phoneB = page.frameLocator('#phoneB iframe')

/** Swap the scene on screen and say whose setup it is. */
async function cut(from, to, label) {
    if (from) await stage('show', from, false)
    await stage('show', to)
    await stage('label', label)
}

await line('intro', async () => {}, { gap: 500 })

await line('where-usual', async () => {
    await cut('title', 'terminals', t('The usual setup', '常见做法'))
})

await line('where-dugong', async () => {
    await cut('terminals', 'duo', 'dugong')
    await sleep(1600)
    await stage('jumpTo', 900, 700)
    await stage('pointer', true)
    await click(duoDesk.getByText(t('Phones open on the task list', '手机端打开就是任务列表')).first())
    await sleep(1200)
    await stage('pointer', true, 'touch')
    await click(duoPhone.getByText(t('Phones open on the task list', '手机端打开就是任务列表')).first(), 600)
    await sleep(600)
})

await line('phone-usual', async () => {
    await stage('pointer', false)
    await cut('duo', 'single', t('The usual setup', '常见做法'))
})

await line('phone-dugong', async () => {
    await cut('single', 'phoneB', 'dugong')
    await sleep(1500)
    await stage('banner')
    await sleep(1600)
    await stage('pointer', true, 'touch')
    await click(phoneB.getByText(t('Codex gets Auto mode too', 'Codex 也用 Auto 模式')).first(), 600)
    await sleep(800)
})

await line('signal-usual', async () => {
    await stage('pointer', false)
    await cut('phoneB', 'procs', t('The usual setup', '常见做法'))
    await sleep(Math.max(1500, cues['signal-usual'].duration * 1000 - 2200))
    await stage('revealWaiting')
})

await line('signal-dugong', async () => {
    await cut('procs', 'deskB', 'dugong')
    await sleep(400)
    await stage('zoom', 1.75, 0, 0, 'deskB')
    await sleep(Math.max(1500, cues['signal-dugong'].duration * 1000 - 1300))
    await stage('zoom', 1, 0, 0, 'deskB')
}, { gap: 900 })

await line('unsure-usual', async () => {
    await cut('deskB', 'stuck', t('The usual setup', '常见做法'))
})

await line('unsure-dugong', async () => {
    await cut('stuck', 'deskB', 'dugong')
    await sleep(500)
    await stage('jumpTo', 900, 600)
    await stage('pointer', true, 'mouse')
    await click(deskB.getByTitle(t('Task assistant', '任务助手')), 600)
    await sleep(700)
    await click(deskB.getByRole('tab', { name: t(/To answer/, /待答/) }), 500)
    await sleep(700)
    await pointAt(deskB.locator('aside').getByText(t('the assistant went with this', '助手先按这个做了')).first(), 500)
})

await line('table', async () => {
    await stage('pointer', false)
    await stage('label', null)
    await stage('show', 'deskB', false)
    await stage('show', 'table')
    for (let row = 0; row < 5; row += 1) {
        await stage('tableRow', row)
        await sleep(380)
    }
}, { gap: 2600 })

await line('honest', async () => {}, { gap: 400 })

await stage('show', 'table', false)
await stage('show', 'end')
await stage('caption', null)
await sleep(2800)

await finish()
