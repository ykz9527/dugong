import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'

const tempDirs: string[] = []

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

function makeDbPath(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `hapi-migration-v30-${label}-`))
    tempDirs.push(dir)
    return join(dir, 'hapi.db')
}

function internalDb(store: Store): Database {
    return (store as unknown as { db: Database }).db
}

function columns(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map((column) => column.name)
}

function userVersion(db: Database): number {
    return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

describe('schema migration v29 to v30', () => {
    it('creates the assistant tables and session pointer on a fresh database', () => {
        const store = new Store(makeDbPath('fresh'))
        const db = internalDb(store)

        expect(columns(db, 'assistant_memories')).toContain('previous_json')
        expect(columns(db, 'assistant_grants')).toContain('tool')
        expect(columns(db, 'workspace_users')).toContain('assistant_session_id')
        expect(userVersion(db)).toBe(34)

        store.close()
    })

    it('upgrades a V29 database and keeps its workspace users', () => {
        const dbPath = makeDbPath('upgrade')

        const seeded = new Store(dbPath)
        const kai = seeded.workspaceUsers.create({ namespace: 'default', name: 'Kai', paths: ['/home/kai'] })
        seeded.close()

        const legacy = new Database(dbPath)
        legacy.exec(`
            DROP TABLE assistant_memories;
            DROP TABLE assistant_grants;
            ALTER TABLE workspace_users DROP COLUMN assistant_session_id;
            PRAGMA user_version = 29;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        expect(userVersion(internalDb(migrated))).toBe(34)
        expect(migrated.workspaceUsers.get(kai.id, 'default')?.name).toBe('Kai')
        expect(migrated.assistant.getSessionId(kai.id, 'default')).toBeNull()

        const memory = migrated.assistant.createMemory({
            namespace: 'default',
            workspaceUserId: kai.id,
            scope: 'user',
            scopeRef: kai.id,
            name: 'reply-in-chinese',
            description: '用中文回复',
            type: 'user',
            body: '',
            author: 'human'
        })
        expect(migrated.assistant.listMemories('default', kai.id).map((m) => m.id)).toEqual([memory.id])

        migrated.close()
    })
})
