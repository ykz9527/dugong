import { beforeEach, describe, expect, it } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { Store } from './index'
import { AssistantMemoryNameTakenError } from './assistant'

let store: Store
let kaiId: string
let mingId: string

function remember(overrides: Partial<Parameters<Store['assistant']['createMemory']>[0]> = {}) {
    return store.assistant.createMemory({
        namespace: 'default',
        workspaceUserId: kaiId,
        scope: 'repo',
        scopeRef: '/home/kai/hapi',
        name: 'check-schema-before-release',
        description: '发布前比对 schema',
        type: 'project',
        body: '生产库 user_version 不等就别发。',
        author: 'human',
        ...overrides
    })
}

beforeEach(() => {
    store = new Store(':memory:')
    kaiId = store.workspaceUsers.create({ namespace: 'default', name: 'Kai', paths: ['/home/kai'] }).id
    mingId = store.workspaceUsers.create({ namespace: 'default', name: 'Ming', paths: ['/home/ming'] }).id
})

describe('assistant memories', () => {
    it('keeps the person\'s version when the assistant edits their entry, until they settle it', () => {
        const memory = remember()

        const first = store.assistant.updateMemory(memory.id, 'default', { body: 'AI 第一次改' }, 'ai')
        expect(first?.lastEditedBy).toBe('ai')
        expect(first?.previous?.body).toBe('生产库 user_version 不等就别发。')
        expect(first?.previous?.lastEditedBy).toBe('human')

        // A second unreviewed edit must not make the assistant's own draft the
        // thing undo returns to.
        const second = store.assistant.updateMemory(memory.id, 'default', { body: 'AI 第二次改' }, 'ai')
        expect(second?.previous?.body).toBe('生产库 user_version 不等就别发。')

        const settled = store.assistant.updateMemory(memory.id, 'default', { description: '人改了描述' }, 'human')
        expect(settled?.previous).toBeNull()
        expect(settled?.body).toBe('AI 第二次改')
        expect(settled?.lastEditedBy).toBe('human')
    })

    it('undo restores the version before the assistant\'s edit', () => {
        const memory = remember()
        store.assistant.updateMemory(memory.id, 'default', { body: 'AI 改', name: 'renamed' }, 'ai')

        const result = store.assistant.undoMemory(memory.id, 'default')
        expect(result.outcome).toBe('restored')
        if (result.outcome !== 'restored') throw new Error('unreachable')
        expect(result.memory.body).toBe('生产库 user_version 不等就别发。')
        expect(result.memory.name).toBe('check-schema-before-release')
        expect(result.memory.lastEditedBy).toBe('human')
        expect(result.memory.previous).toBeNull()
    })

    it('undo removes an entry the assistant wrote from scratch, and leaves settled entries alone', () => {
        const aiWritten = remember({ author: 'ai', name: 'ai-note', source: { sessionId: 's-1', messageSeq: 42 } })
        expect(aiWritten.source).toEqual({ sessionId: 's-1', messageSeq: 42 })
        expect(store.assistant.undoMemory(aiWritten.id, 'default').outcome).toBe('deleted')
        expect(store.assistant.getMemory(aiWritten.id, 'default')).toBeNull()

        const human = remember({ name: 'human-note' })
        expect(store.assistant.undoMemory(human.id, 'default').outcome).toBe('nothing-to-undo')
    })

    it('accepting an assistant edit keeps the text and clears the undo slot', () => {
        const memory = remember()
        store.assistant.updateMemory(memory.id, 'default', { body: 'AI 改' }, 'ai')
        const kept = store.assistant.acceptMemory(memory.id, 'default')
        expect(kept?.body).toBe('AI 改')
        expect(kept?.previous).toBeNull()
    })

    it('an entry the person kept has nothing left to undo, even one the assistant wrote', () => {
        const aiWritten = remember({ author: 'ai', name: 'ai-note' })
        store.assistant.acceptMemory(aiWritten.id, 'default')
        expect(store.assistant.getMemory(aiWritten.id, 'default')?.lastEditedBy).toBe('human')
        expect(store.assistant.undoMemory(aiWritten.id, 'default').outcome).toBe('nothing-to-undo')
        expect(store.assistant.getMemory(aiWritten.id, 'default')).not.toBeNull()
    })

    it('undoes one particular write only while it is the latest change', () => {
        const memory = remember()
        const first = store.assistant.updateMemory(memory.id, 'default', { body: 'AI 一' }, 'ai')!
        Bun.sleepSync(2)
        store.assistant.updateMemory(memory.id, 'default', { body: 'AI 二' }, 'ai')
        expect(store.assistant.undoMemory(memory.id, 'default', first.updatedAt).outcome).toBe('changed')
        expect(store.assistant.getMemory(memory.id, 'default')?.body).toBe('AI 二')
    })

    it('rejects a second entry with the same name in the same place, but not for another person', () => {
        remember()
        expect(() => remember()).toThrow(AssistantMemoryNameTakenError)
        expect(() => remember({ workspaceUserId: mingId })).not.toThrow()
        expect(() => remember({ scope: 'task', scopeRef: 't-1' })).not.toThrow()
    })

    it('lists only the asking person\'s entries, and drops them with the person', () => {
        remember()
        remember({ workspaceUserId: mingId })
        expect(store.assistant.listMemories('default', kaiId)).toHaveLength(1)
        expect(store.assistant.listMemories('other', kaiId)).toHaveLength(0)

        store.workspaceUsers.delete(kaiId, 'default')
        expect(store.assistant.listMemories('default', kaiId)).toHaveLength(0)
        expect(store.assistant.listMemories('default', mingId)).toHaveLength(1)
    })
})

describe('assistant grants and session pointer', () => {
    it('grants once per tool and revokes per person', () => {
        const first = store.assistant.addGrant(kaiId, 'mcp__hapi__ping_peer')
        const again = store.assistant.addGrant(kaiId, 'mcp__hapi__ping_peer')
        expect(again.id).toBe(first.id)
        expect(store.assistant.hasGrant(kaiId, 'mcp__hapi__ping_peer')).toBe(true)
        expect(store.assistant.hasGrant(mingId, 'mcp__hapi__ping_peer')).toBe(false)

        expect(store.assistant.deleteGrant(first.id, mingId)).toBe(false)
        expect(store.assistant.deleteGrant(first.id, kaiId)).toBe(true)
        expect(store.assistant.listGrants(kaiId)).toHaveLength(0)
    })

    it('never grants peer_respond, and drops a grant row left from before', () => {
        expect(() => store.assistant.addGrant(kaiId, 'mcp__hapi__peer_respond')).toThrow()

        const db = (store as unknown as { db: Database }).db
        db.prepare('INSERT INTO assistant_grants (id, workspace_user_id, tool, created_at) VALUES (?, ?, ?, ?)')
            .run('old-grant', kaiId, 'mcp__hapi__peer_respond', 1)
        expect(store.assistant.hasGrant(kaiId, 'mcp__hapi__peer_respond')).toBe(false)
        expect(store.assistant.listGrants(kaiId)).toEqual([])
        expect(db.prepare('SELECT 1 FROM assistant_grants WHERE id = ?').get('old-grant')).toBeNull()
    })

    it('records which session is the person\'s assistant', () => {
        expect(store.assistant.getSessionId(kaiId, 'default')).toBeNull()
        expect(store.assistant.setSessionId(kaiId, 'default', 's-assistant')).toBe(true)
        expect(store.assistant.getSessionId(kaiId, 'default')).toBe('s-assistant')
        expect(store.assistant.setSessionId(kaiId, 'other', 's-x')).toBe(false)
    })
})
