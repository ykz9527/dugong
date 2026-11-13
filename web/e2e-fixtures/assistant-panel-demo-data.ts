import type { AssistantMemory, AssistantQuestion, Task, TaskColumn, WorkspaceUser } from '@hapi/protocol'
import { assistantRepoKey } from '@hapi/protocol'
import type { DecryptedMessage, SessionSummary } from '../src/types/api'

// Demo data for the task assistant: fiction shaped like real hub payloads, so
// the real sidebar, chat pipeline and assistant panel render it unchanged.
// Every visible string comes in Chinese and English; `?lang=en` picks English.

const params = new URLSearchParams(window.location.search)
export const LANG: 'zh' | 'en' = params.get('lang') === 'en' ? 'en' : 'zh'
/** `?video=1`: the launch video's run. The handoff task does not exist yet;
 *  the video creates it through the New task dialog. Implies `?play=1`. */
export const VIDEO = params.get('video') === '1'
const L = (zh: string, en: string): string => (LANG === 'en' ? en : zh)

// Anchored to the current minute so relative times ("2 hours ago", a pending
// tool's elapsed time) read sensibly whenever the demo is opened or recorded.
const MIN = 60_000
export const NOW = Math.floor(Date.now() / MIN) * MIN

export const WORKDIR = '/home/kai/code/dugong'
export const REPO_KEY = assistantRepoKey(WORKDIR)

export const WORKSPACE_USER: WorkspaceUser = {
    id: 'wu-kai',
    namespace: 'default',
    name: 'Kai',
    paths: ['/home/kai/code'],
    createdAt: NOW - 30 * 24 * 60 * MIN,
    updatedAt: NOW - 30 * 24 * 60 * MIN
} as WorkspaceUser

function task(id: string, title: string, column: TaskColumn, sessionId: string | null, ageMin: number): Task {
    return {
        id,
        namespace: 'default',
        title,
        prompt: title,
        column,
        machineId: 'm-1',
        workdir: WORKDIR,
        isolation: 'worktree',
        worktreeName: null,
        baseRef: null,
        branch: sessionId ? `dugong-${id}` : null,
        worktreePath: sessionId ? `/home/kai/code/dugong-worktrees/${id}` : null,
        spawn: { flavor: 'claude' },
        currentSessionId: sessionId,
        lastRunId: null,
        lastRunStatus: null,
        lastError: null,
        pullRequest: null,
        archivedAt: null,
        createdAt: NOW - ageMin * MIN,
        updatedAt: NOW - ageMin * MIN,
        seq: 1
    } as Task
}

export const HANDOFF_TASK = task('t-handoff', L('修复 runner 交接丢新会话句柄', 'Fix runner handoff losing new sessions'), 'review', 's-handoff', 25)

export const TASKS: Task[] = [
    task('t-release', L('发布 v0.18：schema v30 迁移', 'Release v0.18: schema v30 migration'), 'blocked', 's-release', 12),
    ...(VIDEO ? [] : [HANDOFF_TASK]),
    {
        ...task('t-mobile', L('手机端打开就是任务列表', 'Phones open on the task list'), 'review', 's-mobile', 90),
        pullRequest: {
            url: 'https://github.com/ykz9527/dugong/pull/128',
            number: 128,
            state: 'open',
            title: L('手机端打开就是任务列表', 'Phones open on the task list'),
            headBranch: 'dugong-t-mobile',
            baseBranch: 'main',
            isDraft: false,
            mergeable: true,
            checks: 'passing',
            checkedAt: NOW
        }
    },
    // Waiting on a permission, so in Review, as the hub files it.
    task('t-codex', L('Codex 也用 Auto 模式', 'Codex gets Auto mode too'), 'review', 's-codex', 5),
    task('t-push', L('推送按 workspace user 隔离', 'Push notifications per workspace user'), 'ready', null, 300),
    task('t-deps', L('检查依赖更新并开 PR', 'Check dependency updates and open a PR'), 'backlog', null, 600),
    task('t-zstd', L('给压缩的消息加查询脚本', 'Script to query compressed messages'), 'backlog', null, 900),
    task('t-spawn', L('spawn 超时提示文案', 'Clearer spawn timeout message'), 'done', 's-spawn', 2000)
]

export function sessionSummary(id: string, title: string, opts: { thinking?: boolean; pending?: number } = {}): SessionSummary {
    return {
        id,
        active: true,
        thinking: opts.thinking ?? false,
        activeAt: NOW,
        updatedAt: NOW,
        metadata: { path: WORKDIR, host: 'devbox', name: title, flavor: 'claude' },
        metadataVersion: 1,
        agentStateVersion: 1,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: opts.pending ?? 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: 'opus',
        effort: null
    } as unknown as SessionSummary
}

export const SESSIONS: SessionSummary[] = [
    sessionSummary('s-release', TASKS[0].title, { pending: 1 }),
    sessionSummary('s-handoff', HANDOFF_TASK.title),
    sessionSummary('s-mobile', L('手机端打开就是任务列表', 'Phones open on the task list')),
    sessionSummary('s-codex', L('Codex 也用 Auto 模式', 'Codex gets Auto mode too'), { pending: 1 }),
    sessionSummary('s-spawn', L('spawn 超时提示文案', 'Clearer spawn timeout message'))
]

// ---------------------------------------------------------------------------
// Message builders — the same envelope the CLI sends for a Claude session.

let seqCounter = 0
let uuidCounter = 0
const nextUuid = () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`

export function user(text: string, at: number, localId: string | null = null): DecryptedMessage {
    seqCounter += 1
    return {
        id: `m-${seqCounter}`,
        seq: seqCounter,
        localId,
        createdAt: at,
        invokedAt: at,
        content: { role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'webapp' } }
    } as DecryptedMessage
}

type AssistantPart =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }

export function assistant(parts: AssistantPart[], at: number): DecryptedMessage {
    seqCounter += 1
    return {
        id: `m-${seqCounter}`,
        seq: seqCounter,
        localId: null,
        createdAt: at,
        content: {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: nextUuid(),
                    parentUuid: null,
                    timestamp: new Date(at).toISOString(),
                    message: { role: 'assistant', model: 'claude-opus-5-5', content: parts }
                }
            }
        }
    } as unknown as DecryptedMessage
}

export function toolResult(toolUseId: string, content: string, at: number): DecryptedMessage {
    seqCounter += 1
    return {
        id: `m-${seqCounter}`,
        seq: seqCounter,
        localId: null,
        createdAt: at,
        content: {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: nextUuid(),
                    parentUuid: null,
                    timestamp: new Date(at).toISOString(),
                    message: {
                        role: 'user',
                        content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: false }]
                    }
                }
            }
        }
    } as unknown as DecryptedMessage
}

// ---------------------------------------------------------------------------
// The task sessions (centre pane).

/** The Codex task waits on this command; the video approves it from a phone. */
export const CODEX_TOOL_ID = 'tu-c1'
export const CODEX_REQUEST = { tool: 'Bash', arguments: { command: 'bun run test', description: 'Run the full test suite' } }
export function codexAfterApproval(at: () => number): (() => DecryptedMessage)[] {
    return [
        () => toolResult(CODEX_TOOL_ID, ' 2953 pass\n 0 fail\nRan 2953 tests across 283 files. [41.2s]', at()),
        () => assistant([{ type: 'text', text: L('全部通过。Codex 会话现在默认用 Auto，存下来的 Default 保持不变。', 'All green. Codex sessions now start in Auto; saved Default sessions stay as they were.') }], at())
    ]
}

const T0 = NOW - 40 * MIN

export const TASK_MESSAGES: Record<string, DecryptedMessage[]> = {
    's-handoff': [
        user(L(
            'runner 心跳交接后，交接前新起的会话停不掉。查一下原因并修复。',
            'After a runner heartbeat handoff, sessions started just before it can\'t be stopped. Find out why and fix it.'
        ), T0),
        assistant([
            { type: 'text', text: L('先看交接时 runner 是怎么接管已有会话的。', 'First, how the runner takes over existing sessions at handoff.') },
            { type: 'tool_use', id: 'tu-h1', name: 'Grep', input: { pattern: 'persistSpawnedSession', path: 'cli/src/runner' } }
        ], T0 + 1 * MIN),
        toolResult('tu-h1', 'cli/src/runner/run.ts:702: // TODO persistSpawnedSession', T0 + 1 * MIN),
        assistant([
            { type: 'text', text: L(
                '原因找到了：新起的会话只登记在内存里，没有落盘。交接后的新 runner 读不到它们，所以停不掉。\n\n改成 spawn 成功后立即写入 `runner-sessions.json`，交接时从文件恢复。',
                'Found it: new sessions are only kept in memory, never written to disk. The runner that takes over can\'t see them, so it can\'t stop them.\n\nThe fix writes `runner-sessions.json` right after a successful spawn and restores from it at handoff.'
            ) },
            { type: 'tool_use', id: 'tu-h2', name: 'Edit', input: { file_path: 'cli/src/runner/run.ts', old_string: '// TODO persistSpawnedSession', new_string: 'await persistSpawnedSession(session)' } }
        ], T0 + 3 * MIN),
        toolResult('tu-h2', 'The file cli/src/runner/run.ts has been updated.', T0 + 3 * MIN),
        assistant([
            { type: 'tool_use', id: 'tu-h3', name: 'Bash', input: { command: 'bun run test --filter runner', description: 'Run runner tests' } }
        ], T0 + 4 * MIN),
        toolResult('tu-h3', ' 86 pass\n 0 fail\nRan 86 tests across 9 files. [6.12s]', T0 + 5 * MIN),
        assistant([
            { type: 'text', text: L(
                '已修复，runner 相关测试 86 个全部通过。改动在 `cli/src/runner/run.ts`，等你 review。',
                'Fixed. All 86 runner tests pass. The change is in `cli/src/runner/run.ts`, ready for review.'
            ) }
        ], T0 + 5 * MIN)
    ],
    's-release': [
        user(L('准备发布 v0.18，按发布流程走。', 'Get v0.18 ready to ship. Follow the release checklist.'), NOW - 30 * MIN),
        assistant([
            { type: 'text', text: L('先比对生产库的 schema 版本。', 'First, the production database\'s schema version.') },
            { type: 'tool_use', id: 'tu-r1', name: 'Bash', input: { command: 'sqlite3 ~/.dugong/dugong.db "PRAGMA user_version"', description: 'Read production schema version' } }
        ], NOW - 29 * MIN),
        toolResult('tu-r1', '29', NOW - 29 * MIN),
        assistant([
            { type: 'text', text: L(
                '生产库是 v29，这次构建是 v30，迁移是单向的。换二进制前需要你确认：现在有 3 个活跃会话，要不要先等它们结束再停 runner？',
                'Production is at v29 and this build is v30, and the migration is one-way. Before I swap the binary: 3 sessions are live. Should I wait for them to finish before stopping the runner?'
            ) }
        ], NOW - 28 * MIN)
    ],
    's-mobile': [
        user(L('手机上 `/` 直接进任务列表，界面统一叫 Tasks。', 'On phones, `/` should open the task list, and call it Tasks everywhere.'), NOW - 120 * MIN),
        assistant([{ type: 'text', text: L(
            '改好了：`homeRoute()` 在 920px 以下返回 `/sessions`，侧栏标题改成 Tasks。',
            'Done: `homeRoute()` returns `/sessions` below 920px, and the sidebar title says Tasks.'
        ) }], NOW - 95 * MIN)
    ],
    's-codex': [
        user(L('让 Codex 会话也有 Auto 模式，默认就用它。', 'Give Codex sessions the same Auto mode as Claude, and start them in it.'), NOW - 10 * MIN),
        assistant([
            { type: 'text', text: L('Auto 已经接上 Codex Auto Review。跑一遍完整测试确认没有回归。', 'Auto now goes through Codex Auto Review. Running the full test suite to check nothing regressed.') },
            { type: 'tool_use', id: CODEX_TOOL_ID, name: 'Bash', input: CODEX_REQUEST.arguments }
        ], NOW - 1 * MIN)
    ],
    's-spawn': [
        user(L('spawn 超时的报错文案改得让人看得懂。', 'Make the spawn timeout error readable.'), NOW - 2100 * MIN),
        assistant([{ type: 'text', text: L('已改。', 'Done.') }], NOW - 2050 * MIN)
    ]
}

// ---------------------------------------------------------------------------
// Memory (the Memory tab).

function memory(
    id: string,
    scope: AssistantMemory['scope'],
    scopeRef: string,
    name: string,
    type: AssistantMemory['type'],
    description: string,
    body: string,
    opts: { by: 'ai' | 'human'; ageMin: number; previous?: AssistantMemory['previous'] }
): AssistantMemory {
    return {
        id,
        namespace: 'default',
        workspaceUserId: WORKSPACE_USER.id,
        scope,
        scopeRef,
        name,
        description,
        type,
        body,
        createdBy: opts.previous ? 'human' : opts.by,
        lastEditedBy: opts.by,
        source: opts.by === 'ai' ? { sessionId: 's-assistant-kai', messageSeq: null } : null,
        previous: opts.previous ?? null,
        createdAt: NOW - opts.ageMin * MIN,
        updatedAt: NOW - opts.ageMin * MIN
    }
}

const RESTART_RULE_DESCRIPTION = L('重启 runner 前先查活跃会话', 'Check for live sessions before restarting the runner')
const RESTART_RULE_BODY = L(
    '重启 runner 前先确认没有活跃会话。\n\n**Why:** KillMode=process 会留下停不掉的孤儿 agent。\n**How to apply:** 发布和验证 runner 改动前，先看任务列表里有没有运行中的任务。',
    'Before restarting the runner, make sure no sessions are live.\n\n**Why:** KillMode=process leaves orphaned agents nobody can stop.\n**How to apply:** before releasing or verifying a runner change, check the task list for running tasks.'
)

export const INITIAL_MEMORIES: AssistantMemory[] = [
    memory('mem-1', 'task', 't-handoff', 'handoff-reads-only-persisted-sessions', 'project',
        L('交接后的 runner 只认落盘的会话，内存里的会丢', 'After a handoff the runner only knows sessions written to disk'),
        L(
            '心跳交接时，新 runner 只从 runner-sessions.json 恢复会话句柄。spawn 后没写文件的会话，交接后就停不掉。\n\n**Why:** 这是本任务 bug 的根因。\n**How to apply:** 验证修复时，要覆盖"交接前 spawn、交接后 stop"这条路径。',
            'At a heartbeat handoff the new runner restores session handles only from runner-sessions.json. A session not written there after spawn can\'t be stopped afterwards.\n\n**Why:** this is the root cause of this task\'s bug.\n**How to apply:** when verifying the fix, cover "spawn before handoff, stop after".'
        ),
        { by: 'ai', ageMin: 20 }),
    memory('mem-3', 'repo', REPO_KEY, 'restart-runner-only-when-idle', 'feedback',
        RESTART_RULE_DESCRIPTION, RESTART_RULE_BODY, { by: 'human', ageMin: 9 * 24 * 60 }),
    memory('mem-4', 'repo', REPO_KEY, 'check-db-schema-before-release', 'project',
        L('发布前比对生产库 user_version 与构建的 SCHEMA_VERSION', 'Before a release, compare production user_version with the build\'s SCHEMA_VERSION'),
        L(
            '生产库 `PRAGMA user_version` 与构建树 `SCHEMA_VERSION` 不等就别发。迁移单向，旧二进制会一起作废。\n\n**Why:** 2026-09 一次发布差点让旧二进制打不开新库。\n**How to apply:** 发布流程第一步就查，生产库在 ~/.dugong。',
            'Don\'t ship when production `PRAGMA user_version` differs from the build\'s `SCHEMA_VERSION`. Migrations are one-way, so the old binary stops working too.\n\n**Why:** a release in 2026-09 nearly left the old binary unable to open the new database.\n**How to apply:** check it first thing in a release; production lives in ~/.dugong.'
        ),
        {
            by: 'ai',
            ageMin: 28,
            previous: {
                scope: 'repo',
                scopeRef: REPO_KEY,
                name: 'check-db-schema-before-release',
                description: L('发布前比对生产库 user_version 与构建的 SCHEMA_VERSION', 'Before a release, compare production user_version with the build\'s SCHEMA_VERSION'),
                type: 'project',
                body: L(
                    '生产库 user_version 与构建树 SCHEMA_VERSION 不等就别发。迁移单向，旧二进制会一起作废。',
                    'Don\'t ship when production user_version differs from the build\'s SCHEMA_VERSION. Migrations are one-way.'
                ),
                lastEditedBy: 'human'
            }
        }),
    memory('mem-5', 'user', WORKSPACE_USER.id, 'reply-short-conclusion-first', 'user',
        L('回复要短，结论先行', 'Keep replies short, conclusion first'),
        L('短句，结论先行，再说原因和步骤。技术术语保留英文。', 'Short sentences. Conclusion first, then the reason and the steps.'),
        { by: 'human', ageMin: 20 * 24 * 60 }),
    memory('mem-6', 'user', WORKSPACE_USER.id, 'task-flow-follows-agetor', 'feedback',
        L('任务流转照 agetor 做，别自己设计', 'Task flow follows agetor; don\'t invent a new one'),
        L(
            '状态流转与面板交互照 agetor（github.com/alamops/agetor）的实现做。例外：等用户回答的任务进待审阅。\n\n**Why:** 和 agetor 保持一致，少一套心智。\n**How to apply:** 改任务流转前先看 agetor 怎么做的。',
            'Status flow and panel behaviour follow agetor (github.com/alamops/agetor). One exception: a task waiting on the user goes to Review.\n\n**Why:** one model to keep in your head instead of two.\n**How to apply:** look at how agetor does it before changing the task flow.'
        ),
        { by: 'human', ageMin: 6 * 24 * 60 })
]

// ---------------------------------------------------------------------------
// Questions the assistant filed instead of stopping (the To answer tab).

function question(
    id: string,
    taskId: string | null,
    text: string,
    options: string[],
    rationale: string,
    rollback: string,
    ageMin: number,
    answered: { answer: string; status: AssistantQuestion['status']; ageMin: number } | null = null
): AssistantQuestion {
    return {
        id,
        namespace: 'default',
        workspaceUserId: WORKSPACE_USER.id,
        taskId,
        question: text,
        options,
        chosen: options[0],
        rationale,
        rollback,
        status: answered?.status ?? 'open',
        answer: answered?.answer ?? null,
        source: { sessionId: 's-assistant-kai', messageSeq: null },
        createdAt: NOW - ageMin * MIN,
        answeredAt: answered ? NOW - answered.ageMin * MIN : null
    }
}

export const INITIAL_QUESTIONS: AssistantQuestion[] = [
    question('q-1', 't-codex',
        L('Codex 会话默认用 Auto 后，以前存下来的 Default 要不要也改成 Auto？', 'Codex sessions now start in Auto. Should sessions saved as Default switch too?'),
        [L('只改新会话，存下来的保持 Default', 'Only new sessions; saved ones stay Default'), L('全部改成 Auto', 'Switch them all to Auto')],
        L('存下来的 Default 可能是有人特意选的，悄悄改掉会吓人一跳。', 'A saved Default may have been picked on purpose. Changing it silently would surprise people.'),
        L('回退 3f2a91c，再跑一遍 session-mode 迁移测试。', 'Revert 3f2a91c and re-run the session-mode migration test.'),
        35),
    question('q-2', 't-mobile',
        L('手机上打开 dugong，先进任务列表还是上次打开的任务？', 'On a phone, should dugong open on the task list or on the last task you had open?'),
        [L('任务列表', 'The task list'), L('上次打开的任务', 'The last task')],
        L('列表能看出哪些在等你；上次那个任务可能早就做完了。', 'The list shows what needs you. The last task may be finished already.'),
        L('把 homeRoute() 改回去，a41c0d2 一行回退。', 'Change homeRoute() back; a41c0d2 is a one-line revert.'),
        100),
    question('q-3', 't-spawn',
        L('spawn 超时设成多少？', 'What should the spawn timeout be?'),
        ['30s', '60s'],
        L('冷启动的 Codex 在慢机器上要 20 秒左右。', 'A cold Codex start takes about 20s on a slow machine.'),
        L('改 SPAWN_TIMEOUT_MS 一个常量。', 'Change the SPAWN_TIMEOUT_MS constant.'),
        2060,
        { answer: '30s', status: 'confirmed', ageMin: 2000 })
]

// ---------------------------------------------------------------------------
// The assistant's own conversation (right pane), as beats. `?play=1` starts
// with only the history and plays each beat when the person sends a message
// (or approves the pending request); without it the first two beats are
// already there and the message to the task waits for approval.

export const ASSISTANT_SESSION_ID = 's-assistant-kai'

export const ASSISTANT_HISTORY: DecryptedMessage[] = [
    user(L('早上好。今天先看哪个？', 'Morning. What should I look at first?'), NOW - 3 * 60 * MIN),
    assistant([{ type: 'text', text: L(
        '先看「发布 v0.18」：它卡在受阻，在等你决定要不要等 3 个活跃会话结束再停 runner。其余的在跑或在等审阅，不急。',
        'Start with "Release v0.18". It\'s Blocked, waiting for you to decide whether to let 3 live sessions finish before stopping the runner. The rest are running or waiting for review; none of it is urgent.'
    ) }], NOW - 3 * 60 * MIN + 20_000)
]

export const NEW_MEMORY: AssistantMemory = memory('mem-2', 'repo', REPO_KEY, 'runner-changes-need-handoff-test', 'feedback',
    L('runner 相关改动必须补交接场景的测试', 'Runner changes need a handoff test'),
    L(
        'runner 相关的改动，合并前必须有覆盖心跳交接的测试。\n\n**Why:** 修交接丢句柄时，原测试只覆盖 spawn，漏了 bug 本身的路径。\n**How to apply:** review runner 改动时先找交接测试，没有就让任务补。',
        'Any runner change needs a test that covers a heartbeat handoff before it merges.\n\n**Why:** when the handoff bug was fixed, the tests only covered spawn and missed the path of the bug itself.\n**How to apply:** when reviewing a runner change, look for a handoff test first; if there isn\'t one, ask the task to add it.'
    ),
    { by: 'ai', ageMin: 0 })

export const PING_TOOL_ID = 'ta-4'
export const PING_REQUEST = {
    tool: 'mcp__hapi__ping_peer',
    arguments: {
        sessionIdPrefix: 's-handoff',
        message: L(
            '补一个测试：模拟 runner 心跳交接，交接后新 runner 能停掉交接前 spawn 的会话。测试通过后再回到待审阅。',
            'Add a test: simulate a runner heartbeat handoff, then check that the new runner can stop a session spawned before it. Move back to Review when it passes.'
        )
    }
}

export type Beat = {
    /** What the person says; in play mode their own typed text replaces it. */
    prompt: string | null
    /** Streamed one by one, each after `delayMs`. */
    steps: { delayMs: number; message: () => DecryptedMessage; effect?: 'add-memory' }[]
    /** What happens after the last step. */
    after?: 'ask-permission' | 'task-running'
}

/** Messages are built lazily so their seq follows whatever came before. */
export function buildBeats(at: () => number): Beat[] {
    return [
        {
            prompt: L('这个任务现在什么情况？能合了吗？', 'Where is this one at? Can it merge?'),
            steps: [
                { delayMs: 900, message: () => assistant([{ type: 'tool_use', id: 'ta-1', name: 'mcp__hapi__inspect_peer', input: { sessionIdPrefix: 's-handoff' } }], at()) },
                { delayMs: 700, message: () => toolResult('ta-1', L(
                    '修复 runner 交接丢新会话句柄 · 待审阅 · 7 条消息 · 最后一条：已修复，runner 相关测试 86 个全部通过。',
                    'Fix runner handoff losing new sessions · Review · 7 messages · last: Fixed. All 86 runner tests pass.'
                ), at()) },
                { delayMs: 600, message: () => assistant([{ type: 'tool_use', id: 'ta-2', name: 'mcp__hapi__memory_read', input: { name: 'restart-runner-only-when-idle' } }], at()) },
                { delayMs: 600, message: () => toolResult('ta-2', RESTART_RULE_BODY, at()) },
                { delayMs: 1500, message: () => assistant([{ type: 'text', text: L(
                    '代码改完了，runner 测试 86 个都过了。问题是**新会话没落盘**，修法是 spawn 后立即写文件。\n\n还不建议直接合：\n\n1. 测试只覆盖了 spawn，**没有覆盖"交接后停会话"这条路径**，这正是 bug 本身。\n2. 按你记下的规矩（重启 runner 前先查活跃会话），验证前要先确认没有活跃会话再重启。\n\n要我让它补一个交接场景的测试吗？',
                    'The code is done and all 86 runner tests pass. The bug was that **new sessions were never written to disk**; the fix writes them right after spawn.\n\nI wouldn\'t merge yet:\n\n1. The tests only cover spawn. **Nothing covers stopping a session after a handoff**, which is the bug itself.\n2. Your note says to check for live sessions before restarting the runner, so do that before you restart to verify.\n\nShould I ask it to add a handoff test?'
                ) }], at()) }
            ]
        },
        {
            prompt: L('补。另外记住：以后 runner 相关的改动都要补交接测试。', 'Yes. And from now on, runner changes need a handoff test.'),
            steps: [
                { delayMs: 1100, message: () => assistant([{ type: 'tool_use', id: 'ta-3', name: 'mcp__hapi__memory_write', input: {
                    scope: 'repo',
                    scopeRef: REPO_KEY,
                    name: NEW_MEMORY.name,
                    type: NEW_MEMORY.type,
                    description: NEW_MEMORY.description,
                    body: NEW_MEMORY.body
                } }], at()) },
                { delayMs: 700, message: () => toolResult('ta-3', JSON.stringify({ outcome: 'created', memory: NEW_MEMORY }), at()), effect: 'add-memory' },
                { delayMs: 1100, message: () => assistant([
                    { type: 'text', text: L('记下了。下面这条消息会发给任务，需要你确认：', 'Saved. This message goes to the task, so it needs your OK:') },
                    { type: 'tool_use', id: PING_TOOL_ID, name: PING_REQUEST.tool, input: PING_REQUEST.arguments }
                ], at()) }
            ],
            after: 'ask-permission'
        },
        {
            prompt: null,
            steps: [
                { delayMs: 500, message: () => toolResult(PING_TOOL_ID, JSON.stringify({ delivered: true }), at()) },
                { delayMs: 1200, message: () => assistant([{ type: 'text', text: L(
                    '发过去了，它在补测试。回到待审阅时我再看一眼。',
                    'Sent. It\'s writing the test now; I\'ll take another look when it\'s back in Review.'
                ) }], at()) }
            ],
            after: 'task-running'
        }
    ]
}

// ---------------------------------------------------------------------------
// What the New task dialog and the adopt picker see.

export const MACHINE = {
    id: 'm-1',
    namespace: 'default',
    active: true,
    activeAt: NOW,
    createdAt: NOW - 90 * 24 * 60 * MIN,
    updatedAt: NOW,
    metadata: { host: 'devbox', displayName: 'devbox', platform: 'linux', homeDir: '/home/kai', workspaceRoots: ['/home/kai/code'] },
    metadataVersion: 1,
    runnerState: { status: 'running' },
    runnerStateVersion: 1
}

export const DIRECTORIES: Record<string, { name: string; isGitRepo?: boolean }[]> = {
    '/home/kai/code': [{ name: 'dugong', isGitRepo: true }, { name: 'dotfiles', isGitRepo: true }, { name: 'scratch' }],
    '/home/kai/code/dugong': [{ name: 'cli' }, { name: 'hub' }, { name: 'web' }, { name: 'shared' }, { name: 'docs' }]
}

export const ADOPTABLE_SESSIONS = [
    {
        id: '7c1f9a52-3d0e-4b8a-9f61-2a5e0c4d8b13',
        title: L('iOS 上输入框为什么会丢焦点', 'Why the composer loses focus on iOS'),
        lastUserMessage: L('那就先在 Safari 里复现一下，再看要不要改 blur 的处理', 'Reproduce it in Safari first, then decide whether to change the blur handling'),
        cwd: WORKDIR,
        file: '~/.claude/projects/-home-kai-code-dugong/7c1f9a52.jsonl',
        modifiedAt: NOW - 3 * 60 * MIN,
        messageCount: 48
    },
    {
        id: 'b8d24e07-91c3-4f5a-a6d2-5e3b7c0f1a29',
        title: L('dotfiles 里的 zsh 补全', 'zsh completions in dotfiles'),
        lastUserMessage: L('好了，提交吧', 'Good, commit it'),
        cwd: '/home/kai/code/dotfiles',
        file: '~/.claude/projects/-home-kai-code-dotfiles/b8d24e07.jsonl',
        modifiedAt: NOW - 26 * 60 * MIN,
        messageCount: 17
    }
]

export const ADOPTED_SESSION_ID = 's-adopted'
export const ADOPTED_MESSAGES: DecryptedMessage[] = [
    user(L('iOS 上输入框发完消息就丢焦点，键盘收起来了。为什么？', 'On iOS the composer loses focus after sending and the keyboard closes. Why?'), NOW - 5 * 60 * MIN),
    assistant([{ type: 'text', text: L(
        '发送后清空输入框会触发一次重新渲染，Safari 在节点替换时把焦点丢了。可以在发送后的下一帧把焦点放回去。',
        'Clearing the input after a send re-renders it, and Safari drops focus when the node is replaced. Putting focus back on the next frame after a send should fix it.'
    ) }], NOW - 5 * 60 * MIN + MIN),
    user(L('那就先在 Safari 里复现一下，再看要不要改 blur 的处理', 'Reproduce it in Safari first, then decide whether to change the blur handling'), NOW - 3 * 60 * MIN)
]
