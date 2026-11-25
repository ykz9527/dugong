import { afterEach, describe, expect, it } from 'bun:test'
import type { ClaudeLocalSessionWithMessages } from '@hapi/protocol/apiTypes'
import { Hono } from 'hono'
import { Store } from '../../store'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createClaudeSessionRoutes, importClaudeSession } from './claudeSessions'

function machine(id: string): Machine {
    return {
        id,
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: {
            host: `${id}.local`,
            platform: 'linux',
            happyCliVersion: 'test'
        },
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 1,
        health: null
    }
}

function userRow(sessionId: string, uuid: string, text: string, createdAt: number) {
    return {
        localId: `claude:${sessionId}:${uuid}`,
        createdAt,
        content: {
            role: 'user' as const,
            content: { type: 'text' as const, text },
            meta: { sentFrom: 'cli' as const }
        }
    }
}

/** Old enough that the live-transcript guard treats it as finished. */
const SETTLED = Date.now() - 10 * 60_000

function transcript(
    sessionId: string,
    rows: Array<ReturnType<typeof userRow>>,
    modifiedAt = SETTLED
): ClaudeLocalSessionWithMessages {
    return {
        id: sessionId,
        title: `Session ${sessionId}`,
        lastUserMessage: rows.at(-1)?.content.content.text ?? null,
        cwd: '/tmp/project',
        file: `/tmp/${sessionId}.jsonl`,
        modifiedAt,
        messageCount: rows.length,
        messages: rows
    }
}

describe('Claude session adoption', () => {
    const stores: Store[] = []

    afterEach(() => {
        for (const store of stores.splice(0)) store.close()
    })

    function setup() {
        const store = new Store(':memory:')
        stores.push(store)
        const engine = {
            recordSessionActivity: (sessionId: string, updatedAt: number) => {
                store.sessions.touchSessionUpdatedAt(sessionId, updatedAt, 'default')
            },
            handleRealtimeEvent: () => {}
        } as unknown as SyncEngine
        return { store, engine }
    }

    it('records the native id so the existing resume path can find it', () => {
        // `resolveAgentResumeId` reads `metadata.claudeSessionId`; without it the
        // adopted card would have nothing to resume and Start would spawn blind.
        const { store, engine } = setup()
        const result = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('box-1'),
            transcript: transcript('native-1', [userRow('native-1', 'u1', 'hello', SETTLED)])
        })

        expect(result.error).toBeUndefined()
        expect(result.action).toBe('created')
        expect(result.appended).toBe(1)
        const stored = store.sessions.getSessionByNamespace(result.hapiSessionId!, 'default')
        const metadata = stored?.metadata as Record<string, unknown>
        expect(metadata.claudeSessionId).toBe('native-1')
        expect(metadata.flavor).toBe('claude')
        expect(metadata.path).toBe('/tmp/project')
    })

    it('carries the chosen permission mode into the session the reopen path spawns', () => {
        // Adoption goes on to spawn through the ordinary resume path, which
        // reads `preferredPermissionMode`. Without this the adopted session
        // always starts on `default`, and switching to `auto` afterwards cannot
        // bind until the turn the operator is already in finally ends.
        const { store, engine } = setup()
        const result = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('box-1'),
            transcript: transcript('native-mode', [userRow('native-mode', 'u1', 'hello', SETTLED)]),
            permissionMode: 'auto'
        })

        const stored = store.sessions.getSessionByNamespace(result.hapiSessionId!, 'default')
        expect((stored?.metadata as Record<string, unknown>).preferredPermissionMode).toBe('auto')
    })

    it('leaves a mode the operator already changed alone when history is re-imported', () => {
        // A re-import syncs transcript rows; it is not a second chance to
        // decide how the session runs. Overwriting here would silently undo a
        // switch made from the composer.
        const { store, engine } = setup()
        const first = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('box-1'),
            transcript: transcript('native-keep', [userRow('native-keep', 'u1', 'hello', SETTLED)]),
            permissionMode: 'auto'
        })
        const sessionId = first.hapiSessionId!

        importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('box-1'),
            transcript: transcript('native-keep', [
                userRow('native-keep', 'u1', 'hello', SETTLED),
                userRow('native-keep', 'u2', 'again', SETTLED)
            ]),
            permissionMode: 'plan'
        })

        const stored = store.sessions.getSessionByNamespace(sessionId, 'default')
        expect((stored?.metadata as Record<string, unknown>).preferredPermissionMode).toBe('auto')
    })

    it('records where a worktree checkout came from, so it has an owner', () => {
        // Workspace ownership matches on paths, and a worktree sits beside its
        // repo rather than under it — `proj-worktrees/feature` does not match a
        // claim on `proj`. Without the origin the adopted session belongs to
        // nobody and drops out of every filtered view.
        const { store, engine } = setup()
        const origin = {
            basePath: '/repos/proj',
            name: 'feature',
            branch: 'topic',
            worktreePath: '/repos/proj-worktrees/feature'
        }

        const result = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('box-1'),
            transcript: {
                ...transcript('native-wt', [userRow('native-wt', 'u1', 'hi', SETTLED)]),
                worktree: origin
            }
        })

        const stored = store.sessions.getSessionByNamespace(result.hapiSessionId!, 'default')
        expect((stored?.metadata as Record<string, unknown>).worktree).toEqual(origin)
    })

    it('asks before adopting a transcript written in the last minute', () => {
        // Adopting under a running agent races it for the tail of the JSONL,
        // and Start would then resume a session that is already running.
        const { store, engine } = setup()
        const result = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('box-1'),
            transcript: transcript('native-live', [userRow('native-live', 'u1', 'hi', Date.now())], Date.now())
        })

        expect(result.error?.code).toBe('session_maybe_live')
        expect(result.error?.message).toContain('within the last minute')
        expect(result.hapiSessionId).toBeUndefined()
    })

    it('refuses a session the machine proved is running, however old the file', () => {
        // The proof outlives the timestamp: an agent that has been thinking for
        // ten minutes has not written anything, and is very much still running.
        const { store, engine } = setup()
        const stale = transcript('native-proven', [userRow('native-proven', 'u1', 'hi', SETTLED)])

        const result = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('box-1'),
            transcript: { ...stale, live: true },
            // Confirming "it is closed" cannot overrule a process writing it.
            force: true
        })

        expect(result.error?.code).toBe('session_live')
    })

    it('names the process that holds a session, and lets a confirmation past a stale hold', () => {
        // A terminal claude that `/resume`d elsewhere still holds the scratch
        // directory of the session it left; that one is probably closed, but
        // only the operator can say so.
        const { store, engine } = setup()
        const left = {
            ...transcript('native-left', [userRow('native-left', 'u1', 'hi', SETTLED)]),
            live: false,
            holders: [{ pid: 3065168, current: false, entrypoint: 'cli', launcher: 'terminal', status: 'idle', statusAt: null }]
        }
        const options = { store, engine, namespace: 'default', machine: machine('box-1'), transcript: left }

        const asked = importClaudeSession(options)
        expect(asked.error?.code).toBe('session_maybe_live')
        expect(asked.error?.message).toContain('process 3065168 (started by a terminal)')

        const confirmed = importClaudeSession({ ...options, force: true })
        expect(confirmed.error).toBeUndefined()
        expect(confirmed.appended).toBe(1)
    })

    it('still refuses a freshly written transcript the machine could not account for', () => {
        // Not every running agent can be found in the process table, so a
        // negative there means "unknown", not "safe". Reading it as safe hands
        // over a session something else is actively writing.
        const { store, engine } = setup()
        const fresh = transcript(
            'native-unaccounted',
            [userRow('native-unaccounted', 'u1', 'hi', Date.now())],
            Date.now()
        )

        const result = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('box-1'),
            transcript: { ...fresh, live: false }
        })

        expect(result.error?.code).toBe('session_maybe_live')
    })

    it('adopts a settled transcript once nothing claims it', () => {
        const { store, engine } = setup()
        const settled = transcript('native-done', [userRow('native-done', 'u1', 'hi', SETTLED)])

        const result = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('box-1'),
            transcript: { ...settled, live: false }
        })

        expect(result.error).toBeUndefined()
        expect(result.appended).toBe(1)
    })

    it('lands imported history as delivered, not as prompts still queued', () => {
        // A null `invoked_at` means "queued, not yet sent to the agent". An
        // import is the opposite of that, and getting it wrong is not merely
        // cosmetic: the web composer files every such row in its queue bar, and
        // `replayImmediateQueuedMessages` re-emits them at the CLI the next time
        // the session attaches — the whole adopted conversation, typed back at
        // the agent one line at a time.
        const { store, engine } = setup()
        const result = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('box-1'),
            transcript: transcript('native-queued', [
                userRow('native-queued', 'u1', 'one', SETTLED),
                userRow('native-queued', 'u2', 'two', SETTLED + 1)
            ])
        })

        expect(result.error).toBeUndefined()
        const messages = store.messages.getAllMessages(result.hapiSessionId!)
        expect(messages).toHaveLength(2)
        for (const message of messages) {
            expect(message.invokedAt).not.toBeNull()
        }
        expect(store.messages.getImmediateQueuedLocalMessages(result.hapiSessionId!)).toHaveLength(0)
    })

    it('appends only what is new when the same session is imported again', () => {
        const { store, engine } = setup()
        const first = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('box-1'),
            transcript: transcript('native-2', [userRow('native-2', 'u1', 'one', SETTLED)])
        })
        expect(first.appended).toBe(1)

        const second = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('box-1'),
            transcript: transcript('native-2', [
                userRow('native-2', 'u1', 'one', SETTLED),
                userRow('native-2', 'u2', 'two', SETTLED + 1)
            ])
        })

        expect(second.hapiSessionId).toBe(first.hapiSessionId!)
        expect(second.action).toBe('updated')
        expect(second.appended).toBe(1)
        expect(store.messages.getAllMessages(first.hapiSessionId!)).toHaveLength(2)
    })

    it('writes a large transcript without stalling the hub', () => {
        // The hub is single-threaded, so an import's cost is not paid by the
        // request making it — it is paid by everyone. Writing row-by-row meant
        // a transaction and a MAX(seq) scan each: a real 88-second import that
        // froze the whole board. One batched transaction instead.
        const { store, engine } = setup()
        const rows = Array.from({ length: 4000 }, (_, i) =>
            userRow('native-big', `u${i}`, `message ${i}`, SETTLED + i))

        const started = Date.now()
        const result = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('box-1'),
            transcript: transcript('native-big', rows)
        })
        const elapsed = Date.now() - started

        expect(result.error).toBeUndefined()
        expect(result.appended).toBe(4000)
        expect(store.messages.getAllMessages(result.hapiSessionId!)).toHaveLength(4000)
        // Generous enough to survive a loaded CI box, tight enough that going
        // back to a transaction per row would trip it.
        expect(elapsed).toBeLessThan(5_000)
    })

    it('refuses a transcript that no longer extends what was imported', () => {
        // A rewritten history means the file is not the one we imported from;
        // appending would interleave two conversations.
        const { store, engine } = setup()
        const first = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('box-1'),
            transcript: transcript('native-3', [
                userRow('native-3', 'u1', 'one', SETTLED),
                userRow('native-3', 'u2', 'two', SETTLED + 1)
            ])
        })
        expect(first.appended).toBe(2)

        const diverged = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('box-1'),
            transcript: transcript('native-3', [userRow('native-3', 'u2', 'two', SETTLED + 1)])
        })

        expect(diverged.error?.code).toBe('transcript_diverged')
        expect(store.messages.getAllMessages(first.hapiSessionId!)).toHaveLength(2)
    })

    it('explains a silent machine instead of surfacing a bare timeout', async () => {
        // A runner predating this feature has no handler, so the call dies on
        // the timeout. Gating on an advertised capability would refuse a runner
        // built after the feature but before the capability — and re-advertising
        // means restarting the runner, which costs every session it owns.
        const { store } = setup()
        const engine = {
            getOnlineMachinesByNamespace: () => [machine('box-1')],
            listClaudeSessionsForMachine: async () => {
                throw new Error('operation has timed out')
            }
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createClaudeSessionRoutes({ store, getSyncEngine: () => engine }))

        const response = await app.request('/api/claude/sessions')

        expect(response.status).toBe(503)
        expect((await response.json() as { error: string }).error).toContain('restarting the runner')
    })

    it('lists only the adopting user\'s directories, and nothing for a user who owns none', async () => {
        const { store } = setup()
        const kai = store.workspaceUsers.create({ namespace: 'default', name: 'Kai', paths: ['/home/kai/repo'] })
        const newcomer = store.workspaceUsers.create({ namespace: 'default', name: 'New', paths: [] })
        const asked: Array<string[] | undefined> = []
        const engine = {
            getOnlineMachinesByNamespace: () => [machine('box-1')],
            listClaudeSessionsForMachine: async (_m: string, _cwd: string | null, _ids?: string[], _cursor?: unknown, userRoots?: string[]) => {
                asked.push(userRoots)
                return { success: true, sessions: [] }
            }
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createClaudeSessionRoutes({ store, getSyncEngine: () => engine }))

        expect((await app.request(`/api/claude/sessions?workspaceUser=${kai.id}`)).status).toBe(200)
        expect((await app.request('/api/claude/sessions')).status).toBe(200)
        const empty = await app.request(`/api/claude/sessions?workspaceUser=${newcomer.id}`)

        // The machine is asked for Kai's roots, then for everything; a user
        // who owns nothing is answered without asking it at all.
        expect(asked).toEqual([['/home/kai/repo'], undefined])
        expect(await empty.json()).toMatchObject({ success: true, sessions: [] })
        expect((await app.request('/api/claude/sessions?workspaceUser=gone')).status).toBe(404)
    })

    it('pulls a long transcript a page at a time, and says how far a failed one got', async () => {
        // One reply per transcript used to carry the whole history; a 92 MB
        // transcript made a 69 MB reply, past the hub's socket buffer, and the
        // machine was dropped with the import still waiting on it.
        const { store } = setup()
        const rows = [1, 2, 3].map((n) => userRow('native-paged', `u${n}`, `prompt ${n}`, SETTLED + n))
        let failSecondPage = false
        const cursors: unknown[] = []
        const engine = {
            getOnlineMachinesByNamespace: () => [machine('box-1')],
            recordSessionActivity: () => {},
            handleRealtimeEvent: () => {},
            listClaudeSessionsForMachine: async (_machineId: string, _cwd: string | null, _ids: string[], cursor?: { byteOffset: number }) => {
                cursors.push(cursor)
                if (!cursor) {
                    return { success: true, sessions: [{ ...transcript('native-paged', rows.slice(0, 1)), lastUserMessage: null, nextCursor: { byteOffset: 100, eventIndex: 1 } }] }
                }
                if (failSecondPage) throw new Error('operation has timed out')
                return { success: true, sessions: [{ ...transcript('native-paged', rows.slice(1)) }] }
            }
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createClaudeSessionRoutes({ store, getSyncEngine: () => engine }))
        const post = () => app.request('/api/claude/import-sessions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionIds: ['native-paged'] })
        })

        failSecondPage = true
        const failed = await post()
        expect(failed.status).toBe(503)
        expect((await failed.json() as { error: string }).error).toContain('stopped after 1 messages')
        expect(store.sessions.getSessionsByNamespace('default')).toHaveLength(0)

        failSecondPage = false
        cursors.length = 0
        const response = await post()
        const body = await response.json() as { results: Array<{ hapiSessionId?: string; appended?: number }> }
        expect(response.status).toBe(200)
        expect(cursors).toEqual([undefined, { byteOffset: 100, eventIndex: 1 }])
        expect(body.results[0]?.appended).toBe(3)
        const stored = store.sessions.getSessionByNamespace(body.results[0]!.hapiSessionId!, 'default')
        // The machine's summary missed the last prompt; the full history has it.
        expect((stored?.metadata as { summary?: { text?: string } }).summary?.text).toBe('prompt 3')
    })

    it('validates the import body before asking any machine', async () => {
        const { store } = setup()
        let listed = 0
        const engine = {
            getOnlineMachinesByNamespace: () => [machine('box-1')],
            listClaudeSessionsForMachine: async () => {
                listed += 1
                return { success: true, sessions: [] }
            }
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createClaudeSessionRoutes({ store, getSyncEngine: () => engine }))
        const post = (body: unknown) => app.request('/api/claude/import-sessions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
        })

        const empty = await post({ sessionIds: [] })
        expect(empty.status).toBe(400)
        expect((await empty.json() as { error: string }).error).toBe('No Claude sessions selected')
        expect((await post({ sessionIds: ['a'], cwd: 42 })).status).toBe(400)
        expect((await post({ sessionIds: Array.from({ length: 101 }, (_, i) => `s${i}`) })).status).toBe(400)
        expect(listed).toBe(0)

        expect((await post({ sessionIds: [' a '], permissionMode: 'not-a-mode' })).status).toBe(200)
        expect(listed).toBe(1)
    })
})
