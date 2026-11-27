import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
    AGY_IMPORT_NOTICE,
    decodeAgyStep,
    listLocalAgySessionSummaries,
    listLocalAgySessionsWithMessagesByIds,
    summariseAgyRow,
    type AgyStepRow,
    type AgyStore,
    type AgySummaryRow
} from './agySessions'

// A protobuf writer for the handful of shapes agy's steps use.
type Field = [number, string | Uint8Array | number]
function varint(value: number): number[] {
    const bytes: number[] = []
    while (value > 127) {
        bytes.push((value % 128) | 0x80)
        value = Math.floor(value / 128)
    }
    bytes.push(value)
    return bytes
}
function message(...fields: Field[]): Uint8Array {
    const out: number[] = []
    for (const [number, value] of fields) {
        if (typeof value === 'number') {
            out.push(...varint(number * 8), ...varint(value))
            continue
        }
        const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
        out.push(...varint(number * 8 + 2), ...varint(bytes.length))
        for (const byte of bytes) out.push(byte)
    }
    return new Uint8Array(out)
}

const CONVERSATION = 'a0922cd8-3b62-4433-9674-a17b24d99771'
const AT = 1795770074
const metadataAt = (seconds: number) => message([1, message([1, seconds], [2, 500_000_000])])

function userStep(idx: number, text: string): AgyStepRow {
    return { idx, step_type: 14, status: 3, metadata: metadataAt(AT + idx), step_payload: message([19, message([2, text])]) }
}
function plannerStep(idx: number, prose: string | null, calls: Array<[string, string, string]> = []): AgyStepRow {
    const response: Field[] = prose ? [[1, prose]] : []
    for (const [id, name, args] of calls) response.push([7, message([1, id], [2, name], [3, args])])
    return { idx, step_type: 15, status: 3, metadata: metadataAt(AT + idx), step_payload: message([20, message(...response)]) }
}
function resultStep(idx: number, callId: string, options: { output?: string; error?: string; status?: number }): AgyStepRow {
    const fields: Field[] = [[5, message([4, message([1, callId], [2, 'read_file'])])]]
    if (options.output) fields.push([140, message([2, message([1, options.output])])])
    if (options.error) fields.push([31, message([2, options.error])])
    return { idx, step_type: 132, status: options.status ?? 3, metadata: metadataAt(AT + idx), step_payload: message(...fields) }
}

function agentData(messages: ReturnType<typeof decodeAgyStep>) {
    return messages.map((entry) => entry.content.role === 'agent' ? entry.content.content.data : entry.content.content)
}

describe('decodeAgyStep', () => {
    it('reads a prompt with its own timestamp', () => {
        expect(decodeAgyStep(userStep(0, ' hello \n'), CONVERSATION, 1)).toEqual([{
            localId: `agy:${CONVERSATION}:0`,
            createdAt: AT * 1000 + 500,
            content: { role: 'user', content: { type: 'text', text: 'hello' }, meta: { sentFrom: 'cli' } }
        }])
    })

    it('splits a planner response into prose and tool calls, ids stable across reads', () => {
        const step = plannerStep(1, 'Reading it.', [['call-1', 'read_file', '{"Path":"/a.md"}']])
        const decoded = decodeAgyStep(step, CONVERSATION, 1)
        expect(decoded.map((entry) => entry.localId)).toEqual([`agy:${CONVERSATION}:1`, `agy:${CONVERSATION}:1:call:call-1`])
        expect(agentData(decoded)).toEqual([
            { type: 'message', message: 'Reading it.', id: `agy:${CONVERSATION}:1` },
            { type: 'tool-call', name: 'read_file', callId: 'call-1', input: { Path: '/a.md' }, id: `agy:${CONVERSATION}:1:call:call-1` }
        ])
        // A re-import compares content byte for byte.
        expect(decodeAgyStep(step, CONVERSATION, 1)).toEqual(decoded)
    })

    it('pairs a result with its call, dropping the run header', () => {
        const step = resultStep(2, 'call-1', { output: 'Created At: 2026-11-27T00:26:04-08:00\nCompleted At: 2026-11-27T00:26:05-08:00\n1: # Title' })
        expect(agentData(decodeAgyStep(step, CONVERSATION, 1))).toEqual([
            { type: 'tool-call-result', callId: 'call-1', output: '1: # Title', id: `agy:${CONVERSATION}:2:result` }
        ])
    })

    it('shows a failed or never-run call as an error rather than an empty result', () => {
        expect(agentData(decodeAgyStep(resultStep(3, 'c', { error: 'file does not exist', status: 7 }), CONVERSATION, 1)))
            .toEqual([expect.objectContaining({ output: 'file does not exist', is_error: true })])
        expect(agentData(decodeAgyStep(resultStep(4, 'd', { status: 6 }), CONVERSATION, 1)))
            .toEqual([expect.objectContaining({ output: 'Not run', is_error: true })])
    })

    it('skips what it cannot read instead of guessing', () => {
        expect(decodeAgyStep({ idx: 5, step_type: 101, status: 3, metadata: null, step_payload: message([9, 'x']) }, CONVERSATION, 1)).toEqual([])
        expect(decodeAgyStep({ idx: 6, step_type: 14, status: 3, metadata: null, step_payload: new Uint8Array([0xff, 0xff]) }, CONVERSATION, 1)).toEqual([])
    })
})

function summaryRow(overrides: Partial<AgySummaryRow> = {}): AgySummaryRow {
    return {
        conversation_id: CONVERSATION,
        title: '',
        preview: 'Remember this codeword for later',
        step_count: 4,
        last_modified_time: '2026-11-27 09:02:38.549037033+00:00',
        workspace_uris: '["file:///mnt/xc/req_benchmark"]',
        parent_conversation_id: '',
        nesting_depth: 0,
        ...overrides
    }
}

describe('summariseAgyRow', () => {
    const stats = { size: 4096, modifiedAt: 0 }

    it('labels a conversation from its first prompt and workspace', () => {
        expect(summariseAgyRow(summaryRow(), '/f.db', stats)).toEqual({
            id: CONVERSATION,
            title: 'Remember this codeword for later',
            lastUserMessage: 'Remember this codeword for later',
            cwd: '/mnt/xc/req_benchmark',
            file: '/f.db',
            modifiedAt: Date.parse('2026-11-27T09:02:38.549Z'),
            size: 4096
        })
        expect(summariseAgyRow(summaryRow({ title: 'Casual Greeting' }), '/f.db', stats)?.title).toBe('Casual Greeting')
        expect(summariseAgyRow(summaryRow({ title: '', preview: '' }), '/f.db', stats)?.title).toBe('req_benchmark')
    })

    it('hides empty conversations, subagents and ones whose file is gone', () => {
        // Opened in a terminal and closed, or only slash commands typed.
        expect(summariseAgyRow(summaryRow({ step_count: 0 }), '/f.db', stats)).toBeNull()
        expect(summariseAgyRow(summaryRow({ parent_conversation_id: '8b0c8af4-d6c6-4794-bd8f-9775ff3399c4', nesting_depth: 1 }), '/f.db', stats)).toBeNull()
        expect(summariseAgyRow(summaryRow(), '/f.db', null)).toBeNull()
    })

    it('falls back to the file time when agy left its zero time', () => {
        expect(summariseAgyRow(summaryRow({ last_modified_time: '0001-01-01 00:00:00+00:00' }), '/f.db', { size: 1, modifiedAt: 42 })?.modifiedAt).toBe(42)
    })
})

describe('listing and reading conversations', () => {
    const roots: string[] = []
    afterEach(() => {
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
    })

    const OTHER = '9888d382-0000-4000-8000-000000000000'
    const EMPTY = '96d1bbe0-631d-4b50-ac58-c973e7740ba0'

    function home(steps: AgyStepRow[]) {
        const agyHome = mkdtempSync(join(tmpdir(), 'agy-home-'))
        roots.push(agyHome)
        mkdirSync(join(agyHome, 'conversations'))
        for (const id of [CONVERSATION, OTHER, EMPTY]) writeFileSync(join(agyHome, 'conversations', `${id}.db`), '')
        const reads: Array<[number, number]> = []
        const store: AgyStore = {
            summaries: async () => [
                summaryRow({ last_modified_time: '2026-11-27 09:00:00+00:00' }),
                summaryRow({ conversation_id: OTHER, workspace_uris: '["file:///mnt/sxy"]', last_modified_time: '2026-11-27 10:00:00+00:00' }),
                summaryRow({ conversation_id: EMPTY, step_count: 0 })
            ],
            steps: async (_id, fromIdx, limit) => {
                reads.push([fromIdx, limit])
                return steps.filter((step) => step.idx >= fromIdx).slice(0, limit)
            },
            lastUserStep: async () => steps.filter((step) => step.step_type === 14).at(-1) ?? null
        }
        return { agyHome, store, reads }
    }

    it('lists newest first, applies the visibility check before the limit, and marks a held one', async () => {
        const { agyHome, store } = home([userStep(0, 'first'), userStep(4, 'latest prompt')])
        const holder = { pid: 9, current: true, entrypoint: null, launcher: 'terminal', status: null, statusAt: null }

        const all = await listLocalAgySessionSummaries({ agyHome, store, holders: () => new Map([[OTHER, [holder]]]) })
        expect(all.map((session) => [session.id, session.live])).toEqual([[OTHER, true], [CONVERSATION, false]])
        expect(all[0]!.holders).toEqual([holder])
        expect(all[1]!.lastUserMessage).toBe('latest prompt')

        const mine = await listLocalAgySessionSummaries({
            agyHome, store, holders: () => null, limit: 1,
            accept: (session) => session.cwd === '/mnt/xc/req_benchmark'
        })
        expect(mine.map((session) => [session.id, session.live])).toEqual([[CONVERSATION, undefined]])
    })

    it('reads history in pages that resume where the last one stopped', async () => {
        const steps = [userStep(0, 'Remember PERIWINKLE-42'), plannerStep(1, 'OK')]
        for (let idx = 2; idx < 260; idx += 1) steps.push(plannerStep(idx, `reply ${idx}`))
        const { agyHome, store } = home(steps)

        const [first] = await listLocalAgySessionsWithMessagesByIds(new Set([CONVERSATION]), undefined, { agyHome, store, holders: () => null })
        expect(first!.messages[0]!.content).toEqual({ role: 'agent', content: { type: 'event', data: { type: 'message', message: AGY_IMPORT_NOTICE } }, meta: { sentFrom: 'cli' } })
        expect(first!.messages[1]!.content).toMatchObject({ role: 'user', content: { text: 'Remember PERIWINKLE-42' } })
        // 200 steps per read; the budget is not reached, so one page holds all.
        expect(first!.messages).toHaveLength(1 + 260)
        expect(first!.nextCursor).toBeUndefined()

        const [rest] = await listLocalAgySessionsWithMessagesByIds(new Set([CONVERSATION]), { stepIndex: 250 }, { agyHome, store, holders: () => null })
        expect(rest!.messages.map((entry) => entry.localId)).toEqual(
            Array.from({ length: 10 }, (_, index) => `agy:${CONVERSATION}:${250 + index}`)
        )
        await expect(listLocalAgySessionsWithMessagesByIds(new Set([CONVERSATION, OTHER]), { stepIndex: 1 }, { agyHome, store }))
            .rejects.toThrow(/exactly one/)
    })

    it('stops a page at the size budget and hands back a cursor', async () => {
        // Under the per-message truncation limit, so each one counts in full.
        const reply = 'x'.repeat(60 * 1024)
        const steps = Array.from({ length: 300 }, (_, idx) => plannerStep(idx, reply))
        const { agyHome, store } = home(steps)
        const source = { agyHome, store, holders: () => null }

        const seen: string[] = []
        let [page] = await listLocalAgySessionsWithMessagesByIds(new Set([CONVERSATION]), undefined, source)
        let pages = 1
        seen.push(...page!.messages.slice(1).map((entry) => entry.localId))
        expect(page!.nextCursor!.stepIndex).toBeGreaterThan(100)
        while (page!.nextCursor) {
            const cursor = page!.nextCursor
            ;[page] = await listLocalAgySessionsWithMessagesByIds(new Set([CONVERSATION]), cursor, source)
            pages += 1
            seen.push(...page!.messages.map((entry) => entry.localId))
        }
        expect(pages).toBe(3)
        expect(seen).toEqual(steps.map((step) => `agy:${CONVERSATION}:${step.idx}`))
    })

    it('lists nothing where agy has no store', async () => {
        const store: AgyStore = { summaries: async () => { throw new Error('SQLITE_CANTOPEN') }, steps: async () => [], lastUserStep: async () => null }
        expect(await listLocalAgySessionSummaries({ agyHome: '/nonexistent', store, holders: () => null })).toEqual([])
    })
})
