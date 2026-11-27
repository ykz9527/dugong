import { afterEach, describe, expect, it } from 'bun:test'
import type { AgyImportedMessage, AgyLocalSessionWithMessages } from '@hapi/protocol/apiTypes'
import { Hono } from 'hono'
import { Store } from '../../store'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createAgySessionRoutes, importAgySession } from './agySessions'

const ID = 'a0922cd8-3b62-4433-9674-a17b24d99771'
const SETTLED = Date.now() - 10 * 60_000

function machine(id: string): Machine {
    return {
        id,
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: { host: `${id}.local`, platform: 'linux', happyCliVersion: 'test' },
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 1,
        health: null
    }
}

function prompt(step: number, text: string): AgyImportedMessage {
    return {
        localId: `agy:${ID}:${step}`,
        createdAt: SETTLED + step,
        content: { role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'cli' } }
    }
}

function reply(step: number, text: string): AgyImportedMessage {
    return {
        localId: `agy:${ID}:${step}`,
        createdAt: SETTLED + step,
        content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: text, id: `agy:${ID}:${step}` } }, meta: { sentFrom: 'cli' } }
    }
}

function conversation(messages: AgyImportedMessage[], overrides: Partial<AgyLocalSessionWithMessages> = {}): AgyLocalSessionWithMessages {
    return {
        id: ID,
        title: 'Remember this codeword',
        lastUserMessage: 'Remember this codeword',
        cwd: '/tmp/agy-adopt-probe',
        file: `/home/u/.gemini/antigravity-cli/conversations/${ID}.db`,
        modifiedAt: SETTLED,
        live: false,
        messages,
        ...overrides
    }
}

describe('agy session adoption', () => {
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

    function app(store: Store, engine: SyncEngine) {
        const hono = new Hono<WebAppEnv>()
        hono.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        hono.route('/api', createAgySessionRoutes({ store, getSyncEngine: () => engine }))
        return hono
    }

    it('records the conversation id the resume path hands to agy, with history already delivered', () => {
        const { store, engine } = setup()
        const result = importAgySession({
            store, engine, namespace: 'default', machine: machine('box-1'),
            transcript: conversation([prompt(0, 'Remember PERIWINKLE-42'), reply(1, 'OK')]),
            permissionMode: 'yolo'
        })

        expect(result).toMatchObject({ action: 'created', appended: 2 })
        const metadata = store.sessions.getSessionByNamespace(result.hapiSessionId!, 'default')?.metadata as Record<string, unknown>
        expect(metadata).toMatchObject({ flavor: 'agy', agySessionId: ID, path: '/tmp/agy-adopt-probe', machineId: 'box-1', preferredPermissionMode: 'yolo' })
        const stored = store.messages.getAllMessages(result.hapiSessionId!)
        expect(stored.map((message) => message.localId)).toEqual([`agy:${ID}:0`, `agy:${ID}:1`])
        // Not queued prompts: the next attach must not replay them at agy.
        expect(stored.every((message) => message.invokedAt !== null)).toBe(true)
    })

    it('refuses a conversation a running agy is on, and asks about a fresh write', () => {
        const { store, engine } = setup()
        const holder = { pid: 101, current: true, entrypoint: null, launcher: 'terminal', status: null, statusAt: null }
        const live = importAgySession({
            store, engine, namespace: 'default', machine: machine('box-1'),
            transcript: conversation([prompt(0, 'hi')], { live: true, holders: [holder] })
        })
        expect(live.error?.code).toBe('session_live')
        expect(live.error?.message).toContain('This agy session is still running (process 101 (started by a terminal)')

        const fresh = conversation([prompt(0, 'hi')], { modifiedAt: Date.now() })
        expect(importAgySession({ store, engine, namespace: 'default', machine: machine('box-1'), transcript: fresh }).error?.code)
            .toBe('session_maybe_live')
        expect(importAgySession({ store, engine, namespace: 'default', machine: machine('box-1'), transcript: fresh, force: true }).error)
            .toBeUndefined()
    })

    it('appends only new steps on a re-import, and refuses a conversation that no longer extends it', () => {
        const { store, engine } = setup()
        const base = { store, engine, namespace: 'default', machine: machine('box-1') }
        const first = importAgySession({ ...base, transcript: conversation([prompt(0, 'a'), reply(1, 'b')]) })
        const again = importAgySession({ ...base, transcript: conversation([prompt(0, 'a'), reply(1, 'b'), prompt(2, 'c')]) })
        expect(again).toMatchObject({ hapiSessionId: first.hapiSessionId, action: 'updated', appended: 1 })

        const rewritten = importAgySession({ ...base, transcript: conversation([prompt(0, 'a'), reply(1, 'changed'), prompt(2, 'c')]) })
        expect(rewritten.error?.code).toBe('transcript_diverged')
    })

    it('lists the user\'s conversations and marks ones the hub already has', async () => {
        const { store } = setup()
        const kai = store.workspaceUsers.create({ namespace: 'default', name: 'Kai', paths: ['/home/kai/repo'] })
        // One dugong spawned itself: already a HAPI row with this conversation id.
        const spawned = store.sessions.getOrCreateSession('spawned', { path: '/home/kai/repo', host: 'box', machineId: 'box-1', flavor: 'agy', agySessionId: ID }, null, 'default')
        const asked: Array<string[] | undefined> = []
        const engine = {
            getOnlineMachinesByNamespace: () => [machine('box-1')],
            listAgySessionsForMachine: async (_machine: string, _ids?: string[], _cursor?: unknown, userRoots?: string[]) => {
                asked.push(userRoots)
                return {
                    success: true,
                    sessions: [
                        { id: ID, title: 'spawned', cwd: '/home/kai/repo', file: '/f.db', modifiedAt: SETTLED, live: false },
                        { id: '9888d382-0000-4000-8000-000000000000', title: 'mine', cwd: '/home/kai/repo', file: '/g.db', modifiedAt: SETTLED, live: true, holders: [] }
                    ]
                }
            }
        } as unknown as SyncEngine

        const response = await app(store, engine).request(`/api/agy/sessions?workspaceUser=${kai.id}`)
        const body = await response.json() as { sessions: Array<{ id: string; hapiSessionId?: string; liveness?: string }> }

        expect(asked).toEqual([['/home/kai/repo']])
        expect(body.sessions.map((session) => [session.hapiSessionId ?? null, session.liveness ?? null])).toEqual([
            [spawned.id, null],
            [null, 'running']
        ])
    })

    it('pulls a long conversation a page at a time', async () => {
        const { store } = setup()
        const cursors: unknown[] = []
        const engine = {
            getOnlineMachinesByNamespace: () => [machine('box-1')],
            recordSessionActivity: () => {},
            handleRealtimeEvent: () => {},
            listAgySessionsForMachine: async (_machine: string, _ids?: string[], cursor?: { stepIndex: number }) => {
                cursors.push(cursor ?? null)
                const page = !cursor
                    ? conversation([prompt(0, 'a'), reply(1, 'b')], { nextCursor: { stepIndex: 2 } })
                    : conversation([prompt(2, 'c')])
                return { success: true, sessions: [page] }
            }
        } as unknown as SyncEngine

        const response = await app(store, engine).request('/api/agy/import-sessions', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: [ID], machineId: 'box-1' })
        })
        const body = await response.json() as { success: boolean; results: Array<{ hapiSessionId?: string; appended?: number }> }

        expect(cursors).toEqual([null, { stepIndex: 2 }])
        expect(body.success).toBe(true)
        expect(body.results[0]?.appended).toBe(3)
    })
})
