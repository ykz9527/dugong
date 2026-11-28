import { useMemo, useRef } from 'react'
import ReactDOM from 'react-dom/client'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '../src/index.css'
import type { ApiClient } from '../src/api/client'
import type { DecryptedMessage, Session } from '../src/types/api'
import { I18nProvider } from '../src/lib/i18n-context'
import { normalizeDecryptedMessage } from '../src/chat/normalize'
import { reduceChatBlocks } from '../src/chat/reducer'
import { reconcileChatBlocks } from '../src/chat/reconcile'
import { buildVisibleChatBlocks } from '../src/chat/toolGroups'
import { useHappyRuntime } from '../src/lib/assistant-runtime'
import { HappyThread } from '../src/components/AssistantChat/HappyThread'
import type { ChatBlock } from '../src/chat/types'

const params = new URLSearchParams(window.location.search)
const lang = params.get('lang')
if (lang === 'zh-CN' || lang === 'en') {
    localStorage.setItem('hapi-lang', lang)
}

const SESSION_ID = 'tool-fold-fixture'
const T0 = Date.now() - 180_000
let seq = 1

function msg(createdAt: number, content: unknown): DecryptedMessage {
    const id = `msg-${seq}`
    const currentSeq = seq++
    return {
        id,
        seq: currentSeq,
        localId: null,
        createdAt,
        invokedAt: createdAt,
        content,
    } as DecryptedMessage
}

function user(offsetMs: number, text: string): DecryptedMessage {
    return msg(T0 + offsetMs, { role: 'user', content: { type: 'text', text } })
}

function codexCmd(
    startMs: number,
    durationMs: number,
    callId: string,
    command: string,
    actions: Array<Record<string, unknown>>,
    output: string,
    isError = false
): DecryptedMessage[] {
    return [
        msg(T0 + startMs, {
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'tool-call',
                    id: `${callId}-call`,
                    callId,
                    name: 'CodexBash',
                    input: {
                        command: ['bash', '-lc', command],
                        cwd: '/repo',
                        command_source: 'agent',
                        command_actions: actions,
                    },
                },
            },
        }),
        msg(T0 + startMs + durationMs, {
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'tool-call-result',
                    id: `${callId}-res`,
                    callId,
                    output: { exit_code: isError ? 1 : 0, stdout: isError ? '' : output, stderr: isError ? output : '' },
                    is_error: isError,
                },
            },
        }),
    ]
}

function codexReasoning(offsetMs: number, id: string, text: string): DecryptedMessage {
    return msg(T0 + offsetMs, {
        role: 'agent',
        content: {
            type: 'codex',
            data: { type: 'reasoning', id, message: text },
        },
    })
}

function codexReply(offsetMs: number, id: string, text: string): DecryptedMessage {
    return msg(T0 + offsetMs, {
        role: 'agent',
        content: {
            type: 'codex',
            data: { type: 'message', id, message: text },
        },
    })
}

function claudeTool(
    startMs: number,
    durationMs: number,
    toolId: string,
    name: string,
    input: Record<string, unknown>,
    resultContent: string,
    isError = false,
    keepRunning = false
): DecryptedMessage[] {
    const startTs = new Date(T0 + startMs).toISOString()
    const endTs = new Date(T0 + startMs + durationMs).toISOString()
    const out: DecryptedMessage[] = [
        msg(T0 + startMs, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: `${toolId}-u`,
                    parentUuid: null,
                    timestamp: startTs,
                    message: {
                        role: 'assistant',
                        model: 'claude-opus-4-5',
                        content: [{ type: 'tool_use', id: toolId, name, input }],
                    },
                },
            },
        }),
    ]
    if (!keepRunning) {
        out.push(
            msg(T0 + startMs + durationMs, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'user',
                        uuid: `${toolId}-r`,
                        parentUuid: `${toolId}-u`,
                        timestamp: endTs,
                        message: {
                            role: 'user',
                            content: [{ type: 'tool_result', tool_use_id: toolId, content: resultContent, is_error: isError }],
                        },
                    },
                },
            })
        )
    }
    return out
}

const MESSAGES: DecryptedMessage[] = [
    // Turn 1: Reproduces the exact Codex screenshot pattern (10 tools + 2 reasoning blocks)
    user(0, '查一下 2fa9cdd2 和 dugong-1122-a357 的提交历史，顺便核对本机 claude 版本和 toolGroups.ts 逻辑。'),
    ...codexCmd(1_000, 400, 'c1', 'git log --all --oneline -i --grep=context | head -20; grep -rn context web/src/chat', [{ type: 'unknown', command: 'git log --all --oneline' }], '2fa9cdd2 feat: context window tracking'),
    ...codexCmd(1_600, 400, 'c2', 'for c in 2fa9cdd2 5b4d705d; do git merge-base --is-ancestor $c HEAD && echo $c; done', [{ type: 'unknown', command: 'for c in ...' }], '2fa9cdd2\n5b4d705d'),
    ...codexCmd(2_200, 300, 'c3', 'git log --oneline HEAD..dugong-1122-a357 | cat; echo ---; git log -n 5 --oneline', [{ type: 'unknown', command: 'git log --oneline' }], 'a357112 fix: trim stale context'),
    ...codexCmd(2_700, 400, 'c4', 'git show --stat 2fa9cdd2 | sed -n 20,60p; git show 2fa9cdd2 -- web/src/chat/toolGroups.ts', [{ type: 'unknown', command: 'git show --stat' }], 'web/src/chat/toolGroups.ts | 42 ++--'),
    codexReasoning(3_300, 'r1', '**核对提交与本机 CLI 版本**\n\n前四条命令确认两个提交都在主线祖先链上，接下来查看 `normalizeAgent.ts` 变更并检查本机 Claude 二进制路径。'),
    ...codexCmd(3_600, 100, 'c5', 'git show 2fa9cdd2 -- web/src/chat/normalizeAgent.ts', [{ type: 'unknown', command: 'git show 2fa9cdd2 -- web/src/chat/normalizeAgent.ts' }], '+ const contextWindow = ...'),
    ...codexCmd(3_900, 200, 'c6', 'which claude; claude --version 2>&1; readlink -f $(which claude)', [{ type: 'unknown', command: 'which claude' }], '/home/fdse/.local/share/claude/versions/2.1.332'),
    ...codexCmd(4_300, 3_500, 'c7', 'cd /tmp && B=/home/fdse/.local/share/claude/versions/2.1.332; ls -lh $B', [{ type: 'unknown', command: 'ls -lh' }], '-rwxr-xr-x 118M claude'),
    ...codexCmd(8_000, 6_000, 'c8', 'cd /tmp && B=/home/fdse/.local/share/claude/versions/2.1.332; strings $B | rg -m 3 tool_group', [{ type: 'unknown', command: 'strings' }], 'tool_group_summary'),
    ...codexCmd(14_200, 2_100, 'c9', 'cat web/src/chat/toolGroups.ts', [{ type: 'read', command: 'cat web/src/chat/toolGroups.ts', name: 'toolGroups.ts', path: '/repo/web/src/chat/toolGroups.ts' }], 'export function buildVisibleChatBlocks...'),
    ...codexCmd(16_500, 1_800, 'c10', 'rg isEligibleForToolGrouping web/src', [{ type: 'search', command: 'rg isEligibleForToolGrouping web/src', query: 'isEligibleForToolGrouping', path: 'web/src' }], 'web/src/chat/toolGroups.ts:225'),
    codexReasoning(18_500, 'r2', '**整理结论**\n\n已确认所有提交都在当前分支祖先上，且 `CodexBash` 的非探索命令正是造成长列表未折叠的直接原因。'),
    codexReply(19_000, 'reply-1', '已核对完成：\n\n1. `2fa9cdd2` 和 `5b4d705d` 均已合入当前分支；\n2. 本机 `claude` 指向 `2.1.332`；\n3. 这一整轮的 10 次工具调用和 2 段思考已自动折叠为上方单行，正文直接紧跟在下面。'),

    // Turn 2: Group with an error + standalone pending permission + 2-tool standalone run
    user(40_000, '跑一下测试并修复失败项，需要清理缓存目录前先问我。'),
    ...claudeTool(41_000, 600, 't1', 'Read', { file_path: '/repo/web/src/chat/toolGroups.ts' }, 'export function buildVisibleChatBlocks...'),
    ...claudeTool(42_000, 3_200, 't2', 'Bash', { command: 'bun run test -- toolGroups.test.ts' }, 'AssertionError: expected 1 to be 3', true),
    ...claudeTool(45_500, 900, 't3', 'Edit', { file_path: '/repo/web/src/chat/toolGroups.ts', old_string: 'a', new_string: 'b' }, 'Updated file'),
    ...claudeTool(46_800, 2_100, 't4', 'Bash', { command: 'bun run test -- toolGroups.test.ts' }, '12 passed (12)'),
    ...claudeTool(49_500, 0, 't-perm', 'Bash', { command: 'rm -rf /tmp/dugong-stale-cache' }, '', false, true),

    // Turn 3: Live running tool group
    user(70_000, '顺便再检查一下构建和类型检查。'),
    ...claudeTool(71_000, 500, 'live-1', 'Read', { file_path: '/repo/web/package.json' }, '{"name":"web"}'),
    ...claudeTool(71_800, 800, 'live-2', 'Grep', { pattern: 'ToolGroupCard', path: 'web/src' }, 'web/src/components/ToolCard/ToolGroupCard.tsx'),
    ...claudeTool(73_000, 0, 'live-3', 'Bash', { command: 'bun typecheck && bun run build' }, '', false, true),
]

const fakeAgentState = {
    requests: {
        't-perm': {
            tool: 'Bash',
            arguments: { command: 'rm -rf /tmp/dugong-stale-cache' },
            createdAt: T0 + 49_500,
        },
    },
    completedRequests: {},
}

const fakeSession = {
    id: SESSION_ID,
    active: true,
    thinking: true,
    agentState: fakeAgentState,
    metadata: { path: '/repo', host: 'local' },
} as unknown as Session

const fakeApi = {
    getMessages: async () => ({ messages: MESSAGES, page: { hasMore: false } }),
    getMachines: async () => ({ machines: [] }),
    approvePermission: async () => {},
    denyPermission: async () => {},
} as unknown as ApiClient

function FixturePage() {
    const blocksByIdRef = useRef<Map<string, ChatBlock>>(new Map())

    const normalizedMessages = useMemo(() => {
        const normalized = []
        for (const message of MESSAGES) {
            const next = normalizeDecryptedMessage(message)
            if (next) normalized.push(next)
        }
        return normalized
    }, [])

    const reduced = useMemo(
        () => reduceChatBlocks(normalizedMessages, fakeAgentState, {}),
        [normalizedMessages]
    )
    const reconciled = useMemo(
        () => reconcileChatBlocks(reduced.blocks, blocksByIdRef.current),
        [reduced.blocks]
    )
    blocksByIdRef.current = reconciled.byId

    const visibleBlocks = useMemo(
        () => buildVisibleChatBlocks(reconciled.blocks, {
            hasMoreMessages: false,
            isSessionThinking: true,
        }),
        [reconciled.blocks]
    )

    const runtime = useHappyRuntime({
        session: fakeSession,
        blocks: visibleBlocks,
        messagesVersion: 1,
        historyVersion: 0,
        isSending: false,
        onSendMessage: () => {},
        onAbort: async () => {},
    })

    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <div className="mx-auto flex h-screen max-w-4xl min-h-0 flex-col bg-[var(--app-bg)]">
                <HappyThread
                    api={fakeApi}
                    session={fakeSession}
                    sessionId={SESSION_ID}
                    metadata={{ path: '/repo', host: 'local' }}
                    disabled={false}
                    onRefresh={() => {}}
                    onViewModeChange={() => {}}
                    isSyncingTail={false}
                    messagesWarning={null}
                    hasMoreMessages={false}
                    isLoadingMoreMessages={false}
                    onLoadMore={async () => 'terminal-stop'}
                    onCancelLoadMore={() => {}}
                    unseenCount={0}
                    rawMessagesCount={MESSAGES.length}
                    normalizedMessagesCount={normalizedMessages.length}
                    messagesVersion={1}
                    historyVersion={0}
                    forceScrollToken={0}
                    outlineOpen={false}
                    outlineItems={[]}
                    onOutlineOpenChange={() => {}}
                />
            </div>
        </AssistantRuntimeProvider>
    )
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

ReactDOM.createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={queryClient}>
        <I18nProvider>
            <FixturePage />
        </I18nProvider>
    </QueryClientProvider>
)
