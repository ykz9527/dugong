// Plays the launch video's script on the stage page and records every frame.
//
//   node design/launch/video/record-launch.mjs
//
// See stage-driver.mjs for what it needs and writes.

import { openStage, sleep, t } from './stage-driver.mjs'

const { page, stage, cues, line, pointAt, click, type, finish } = await openStage('launch', 'terminals')
const desk = page.frameLocator('#desk iframe')
const deskB = page.frameLocator('#deskB iframe')
const phone = page.frameLocator('#phone iframe')

// --- the script ---------------------------------------------------------------

await line('terminals')

await line('list', async () => {
    await stage('show', 'desk')
    await stage('terminalsOut')
})

await line('new', async () => {
    await stage('jumpTo', 1100, 600)
    await stage('pointer', true)
    await click(desk.getByTitle(t('New task', '新建任务')))
    await sleep(400)
    await type(desk.getByPlaceholder(t('What should the agent do?', '要智能体做什么？')), t('After a runner heartbeat handoff, sessions started just before it can\'t be stopped. Find out why and fix it.', 'runner 心跳交接后，交接前新起的会话停不掉。查一下原因并修复。'), 14)
    await click(desk.getByRole('button', { name: t('Browse…', '浏览…') }))
    await sleep(500)
    await click(desk.getByText('dugong', { exact: true }).last())
    await sleep(400)
    await click(desk.getByRole('button', { name: t('Use this directory', '用这个目录') }))
    await type(desk.getByText(t('Title (optional)', '标题（可选）')).locator('xpath=following::input[1]'), t('Fix runner handoff losing new sessions', '修复 runner 交接丢新会话句柄'), 22)
    await click(desk.getByText(t('Start immediately', '创建后立即启动')))
    await click(desk.getByRole('button', { name: t('Create', '创建'), exact: true }))
}, { gap: 100 })

await line('review', async () => {
    await click(desk.getByText(t('Fix runner handoff losing new sessions', '修复 runner 交接丢新会话句柄')).first(), 500)
    await stage('badge', '×8')
    const deskFrame = page.frames().find((frame) => frame.url().includes('video=1'))
    await deskFrame.waitForFunction(() => document.querySelector('[data-task-id="t-handoff"] select')?.value === 'review', null, { timeout: 15000 })
    await sleep(1200)
    await stage('badge', null)
})

await line('red', async () => {
    await stage('pointer', false)
    await stage('zoom', 1.75, 0, 60)
    await sleep(Math.max(1200, cues.red.duration * 1000 - 600))
    await stage('zoom', 1)
}, { gap: 900 })

await line('assistant', async () => {
    await stage('pointer', true)
    await click(desk.getByTitle(t('Task assistant', '任务助手')))
    await sleep(900)
    await type(desk.locator('aside').getByRole('textbox'), t('Where is this one at? Can it merge?', '这个任务现在什么情况？能合了吗？'), 40)
}, { gap: 150 })

await line('reads', async () => {
    await desk.locator('aside').getByRole('textbox').press('Enter')
    await sleep(5200)
})

await line('tell', async () => {
    await type(desk.locator('aside').getByRole('textbox'), t('Yes. And from now on, runner changes need a handoff test.', '补。另外记住：以后 runner 相关的改动都要补交接测试。'), 34)
    await desk.locator('aside').getByRole('textbox').press('Enter')
    await sleep(3600)
    await click(desk.locator('aside').getByRole('button', { name: t(/^Allow$/, /^允许$/) }).first())
    await sleep(2400)
})

await line('memory', async () => {
    await click(desk.getByRole('tab', { name: t(/Memory/, /记忆/) }))
    await sleep(900)
    await pointAt(desk.locator('aside').getByText(t('Runner changes need a handoff test', 'runner 相关改动必须补交接场景的测试')).first())
})

await line('questions', async () => {
    await click(desk.getByRole('tab', { name: t(/To answer/, /待答/) }))
    await sleep(1600)
    await pointAt(desk.locator('aside').getByText(t('the assistant went with this', '助手先按这个做了')).first())
    await sleep(Math.max(500, cues.questions.duration * 1000 - 3800))
    await click(desk.locator('aside').getByRole('button', { name: t('Keep it', '就这样') }).first())
})

await line('laptop', async () => {
    await stage('pointer', false)
    await stage('closeLid')
}, { gap: 700 })

await line('phone', async () => {
    await stage('show', 'desk', false)
    await stage('show', 'phone')
    await sleep(700)
    await stage('notify')
    await sleep(900)
    await stage('pointer', true, 'touch')
    await click(page.locator('#notification'), 500)
    await stage('unlock')
    await sleep(1000)
    await click(phone.getByRole('button', { name: t(/^Allow$/, /^允许$/) }).first(), 600)
    await sleep(2200)
})

await line('phonelist', async () => {
    await click(phone.getByRole('button', { name: t('Back', '返回') }), 500)
    await sleep(900)
    await click(phone.getByRole('button', { name: t(/^Assistant$/, /^助手$/) }), 600)
    await sleep(900)
})

await line('schedule', async () => {
    await stage('pointer', false)
    await stage('show', 'phone', false)
    await stage('show', 'deskB')
    await sleep(600)
    await stage('pointer', true, 'mouse')
    const row = deskB.locator('[data-task-id="t-deps"]')
    await pointAt(row, 500)
    await row.hover()
    const details = row.getByRole('button', { name: t('Details', '详情') })
    await click(details, 400)
    await sleep(900)
    await click(deskB.getByRole('button', { name: t('Run on a schedule', '定时运行') }))
    await sleep(500)
    await click(deskB.getByRole('button', { name: t('Weekly', '每周') }))
    await sleep(1100)
    await click(deskB.getByRole('button', { name: t('Save schedule', '保存定时') }))
    await sleep(600)
}, { gap: 200 })

await line('adopt', async () => {
    await click(deskB.getByRole('dialog').getByRole('button', { name: t('Close', '关闭'), exact: true }).first(), 500)
    await sleep(400)
    await click(deskB.getByTitle(t('New task', '新建任务')))
    await sleep(400)
    await click(deskB.getByRole('button', { name: t('Adopt a session', '接管已有会话') }))
    await sleep(900)
    await click(deskB.getByText(t('Why the composer loses focus on iOS', 'iOS 上输入框为什么会丢焦点')).first())
    await sleep(500)
    await click(deskB.getByRole('button', { name: t(/^(Create|Adopt)/, /^(创建|接管)/) }).last())
    await sleep(1200)
})

await line('end', async () => {
    await stage('pointer', false)
    await stage('show', 'deskB', false)
    await stage('show', 'end')
}, { gap: 1600 })

await finish()
