import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listLocalClaudeSessionSummaries, listLocalClaudeSessionsWithMessagesByIds } from './claudeSessions'

/** One `~/.claude/projects/<slug>/<session-id>.jsonl`. */
function writeTranscript(root: string, slug: string, sessionId: string, rows: unknown[]): string {
    const bucket = join(root, 'projects', slug)
    mkdirSync(bucket, { recursive: true })
    const file = join(bucket, `${sessionId}.jsonl`)
    writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
    return file
}

describe('local Claude sessions', () => {
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    const roots: string[] = []

    afterEach(() => {
        if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
        else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
    })

    function useRoot(): string {
        const root = mkdtempSync(join(tmpdir(), 'claude-sessions-'))
        roots.push(root)
        process.env.CLAUDE_CONFIG_DIR = root
        return root
    }

    it('prefers Claude\'s own title and reports the transcript cwd', async () => {
        const root = useRoot()
        writeTranscript(root, '-tmp-project', 'sess-1', [
            { type: 'user', uuid: 'u1', sessionId: 'sess-1', cwd: '/tmp/project', timestamp: '2026-09-01T10:00:00Z', message: { role: 'user', content: 'first prompt' } },
            { type: 'assistant', uuid: 'a1', sessionId: 'sess-1', timestamp: '2026-09-01T10:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
            { type: 'ai-title', sessionId: 'sess-1', aiTitle: 'Refactor the parser' }
        ])

        const summaries = await listLocalClaudeSessionSummaries()

        expect(summaries).toEqual([expect.objectContaining({
            id: 'sess-1',
            title: 'Refactor the parser',
            cwd: '/tmp/project',
            lastUserMessage: 'first prompt',
            messageCount: 2
        })])
    })

    it('falls back to the first user message when there is no title event', async () => {
        const root = useRoot()
        writeTranscript(root, '-tmp-other', 'sess-2', [
            { type: 'user', uuid: 'u1', sessionId: 'sess-2', cwd: '/tmp/other', timestamp: '2026-09-01T10:00:00Z', message: { role: 'user', content: 'why is the build slow' } }
        ])

        const summaries = await listLocalClaudeSessionSummaries()

        expect(summaries[0]?.title).toBe('why is the build slow')
    })

    it('drops the rows Claude injects for its own bookkeeping', async () => {
        // These reach the JSONL as `type:'user'` so the model sees them, but a
        // human never typed them — importing them would put system chatter in
        // the chat and make it the card's "last message".
        const root = useRoot()
        writeTranscript(root, '-tmp-noise', 'sess-3', [
            { type: 'user', uuid: 'u1', sessionId: 'sess-3', cwd: '/tmp/noise', timestamp: '2026-09-01T10:00:00Z', message: { role: 'user', content: 'real question' } },
            { type: 'user', uuid: 'u2', sessionId: 'sess-3', timestamp: '2026-09-01T10:00:01Z', message: { role: 'user', content: '<system-reminder>be careful</system-reminder>' } },
            { type: 'user', uuid: 'u3', sessionId: 'sess-3', isMeta: true, timestamp: '2026-09-01T10:00:02Z', message: { role: 'user', content: 'meta row' } }
        ])

        const [session] = await listLocalClaudeSessionsWithMessagesByIds(new Set(['sess-3']))

        expect(session.lastUserMessage).toBe('real question')
        const userTexts = session.messages
            .filter((message) => message.content.role === 'user')
            .map((message) => message.content.role === 'user' ? message.content.content.text : null)
        expect(userTexts).toEqual(['real question'])
    })

    it('carries raw rows through unchanged, keyed for idempotent re-import', async () => {
        // The agent side of an imported message is the JSONL row verbatim — the
        // same shape the live scanner forwards — so the web pipeline needs no
        // import-specific branch.
        const root = useRoot()
        const assistantRow = {
            type: 'assistant',
            uuid: 'a1',
            sessionId: 'sess-4',
            cwd: '/tmp/raw',
            timestamp: '2026-09-01T10:00:01Z',
            message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] }
        }
        writeTranscript(root, '-tmp-raw', 'sess-4', [
            { type: 'user', uuid: 'u1', sessionId: 'sess-4', cwd: '/tmp/raw', timestamp: '2026-09-01T10:00:00Z', message: { role: 'user', content: 'q' } },
            assistantRow
        ])

        const [session] = await listLocalClaudeSessionsWithMessagesByIds(new Set(['sess-4']))

        const agent = session.messages.find((message) => message.content.role === 'agent')
        expect(agent?.localId).toBe('claude:sess-4:a1')
        expect(agent?.createdAt).toBe(Date.parse('2026-09-01T10:00:01Z'))
        expect(agent?.content.role === 'agent' && agent.content.content.data).toMatchObject({
            type: 'assistant',
            uuid: 'a1'
        })
    })

    it('narrows to one project when given a cwd, without reading the others', async () => {
        // Claude derives the project directory from the cwd, so a scoped list
        // never has to open another project's transcripts — which is what makes
        // this filtering rather than post-filtering.
        const root = useRoot()
        writeTranscript(root, '-tmp-wanted', 'sess-here', [
            { type: 'user', uuid: 'u1', sessionId: 'sess-here', cwd: '/tmp/wanted', timestamp: '2026-09-01T10:00:00Z', message: { role: 'user', content: 'in scope' } }
        ])
        writeTranscript(root, '-tmp-elsewhere', 'sess-there', [
            { type: 'user', uuid: 'u1', sessionId: 'sess-there', cwd: '/tmp/elsewhere', timestamp: '2026-09-01T10:00:00Z', message: { role: 'user', content: 'out of scope' } }
        ])

        const scoped = await listLocalClaudeSessionSummaries(undefined, '/tmp/wanted')
        expect(scoped.map((session) => session.id)).toEqual(['sess-here'])

        const all = await listLocalClaudeSessionSummaries()
        expect(all.map((session) => session.id).sort()).toEqual(['sess-here', 'sess-there'])
    })

    it('scopes a by-id lookup to the same project', async () => {
        const root = useRoot()
        writeTranscript(root, '-tmp-wanted', 'sess-here', [
            { type: 'user', uuid: 'u1', sessionId: 'sess-here', cwd: '/tmp/wanted', timestamp: '2026-09-01T10:00:00Z', message: { role: 'user', content: 'in scope' } }
        ])
        writeTranscript(root, '-tmp-elsewhere', 'sess-there', [
            { type: 'user', uuid: 'u1', sessionId: 'sess-there', cwd: '/tmp/elsewhere', timestamp: '2026-09-01T10:00:00Z', message: { role: 'user', content: 'out of scope' } }
        ])

        const ids = new Set(['sess-here', 'sess-there'])
        const scoped = await listLocalClaudeSessionsWithMessagesByIds(ids, '/tmp/wanted')

        expect(scoped.map((session) => session.id)).toEqual(['sess-here'])
    })

    it('spends its budget on sessions the caller can actually see', async () => {
        // `limit` is a budget, so filtering after the fact wastes it. Seen on a
        // shared machine: 32 of the 40 most recent transcripts lived outside
        // the runner's roots, and the picker showed three sessions.
        const root = useRoot()
        for (const [i, slug] of ['-other-a', '-other-b', '-other-c'].entries()) {
            writeTranscript(root, slug, `sess-out-${i}`, [
                { type: 'user', uuid: 'u1', sessionId: `sess-out-${i}`, cwd: `/other/${i}`, timestamp: `2026-09-0${i + 2}T10:00:00Z`, message: { role: 'user', content: 'elsewhere' } }
            ])
        }
        writeTranscript(root, '-tmp-mine', 'sess-mine', [
            { type: 'user', uuid: 'u1', sessionId: 'sess-mine', cwd: '/tmp/mine', timestamp: '2026-09-01T10:00:00Z', message: { role: 'user', content: 'mine' } }
        ])

        const visible = await listLocalClaudeSessionSummaries(
            1,
            null,
            (session) => Boolean(session.cwd?.startsWith('/tmp/mine'))
        )

        expect(visible.map((session) => session.id)).toEqual(['sess-mine'])
    })

    it('skips whole projects by directory name before opening them', async () => {
        // Claude names each project directory after the working directory, so a
        // scan can rule one out without reading any of its transcripts.
        const root = useRoot()
        writeTranscript(root, '-tmp-mine', 'sess-mine', [
            { type: 'user', uuid: 'u1', sessionId: 'sess-mine', cwd: '/tmp/mine', timestamp: '2026-09-01T10:00:00Z', message: { role: 'user', content: 'mine' } }
        ])
        writeTranscript(root, '-tmp-mine2', 'sess-lookalike', [
            { type: 'user', uuid: 'u1', sessionId: 'sess-lookalike', cwd: '/tmp/mine2', timestamp: '2026-09-02T10:00:00Z', message: { role: 'user', content: 'not mine' } }
        ])
        writeTranscript(root, '-tmp-mine-nested', 'sess-nested', [
            { type: 'user', uuid: 'u1', sessionId: 'sess-nested', cwd: '/tmp/mine/nested', timestamp: '2026-09-03T10:00:00Z', message: { role: 'user', content: 'below mine' } }
        ])

        const scoped = await listLocalClaudeSessionSummaries(undefined, null, undefined, ['/tmp/mine'])

        // `/tmp/mine2` shares a prefix but is a different directory.
        expect(scoped.map((session) => session.id).sort()).toEqual(['sess-mine', 'sess-nested'])
    })

    it('skips transcripts with nothing visible in them', async () => {
        // Claude leaves a stub file behind for a session that never got a turn;
        // adopting one would produce an empty card.
        const root = useRoot()
        writeTranscript(root, '-tmp-stub', 'sess-5', [
            { type: 'user', uuid: 'u1', sessionId: 'sess-5', isMeta: true, cwd: '/tmp/stub', timestamp: '2026-09-01T10:00:00Z', message: { role: 'user', content: 'meta only' } }
        ])

        expect(await listLocalClaudeSessionSummaries()).toEqual([])
    })
})
