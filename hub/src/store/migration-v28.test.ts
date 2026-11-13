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
    const dir = mkdtempSync(join(tmpdir(), `hapi-migration-v28-${label}-`))
    tempDirs.push(dir)
    return join(dir, 'hapi.db')
}

function internalDb(store: Store): Database {
    return (store as unknown as { db: Database }).db
}

function userVersion(db: Database): number {
    return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

describe('schema migration v27 to v28', () => {
    it('creates workspace_users on a fresh database', () => {
        const store = new Store(makeDbPath('fresh'))
        const db = internalDb(store)

        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
        expect(tables.some((table) => table.name === 'workspace_users')).toBe(true)
        expect(userVersion(db)).toBe(34)

        store.close()
    })

    it('upgrades a V27 database and leaves existing cards alone', () => {
        const dbPath = makeDbPath('upgrade')

        const seeded = new Store(dbPath)
        seeded.tasks.create({
            namespace: 'default', id: 'task-keep', title: 'Keep me',
            prompt: 'p', workdir: '/repo', spawn: { flavor: 'claude' }
        })
        seeded.close()

        const legacy = new Database(dbPath)
        legacy.exec(`
            DROP TABLE IF EXISTS workspace_users;
            PRAGMA user_version = 27;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        const db = internalDb(migrated)
        expect(userVersion(db)).toBe(34)

        // Nobody owns anything yet, which is what keeps every existing board
        // showing exactly what it showed before the upgrade.
        expect(migrated.workspaceUsers.list('default')).toEqual([])
        expect(migrated.tasks.get('task-keep')?.title).toBe('Keep me')

        migrated.close()
    })

    it('round-trips a user and scopes them to their namespace', () => {
        const store = new Store(makeDbPath('crud'))

        const created = store.workspaceUsers.create({
            namespace: 'default',
            name: '  Kai  ',
            // Duplicates, blanks and trailing slashes come straight from a
            // directory picker; storage keeps one canonical form.
            paths: ['/home/kai/repo/', '/home/kai/repo', '   ', '/home/kai/other']
        })
        expect(created.name).toBe('Kai')
        expect(created.paths).toEqual(['/home/kai/repo', '/home/kai/other'])

        const updated = store.workspaceUsers.update(created.id, 'default', { paths: ['/home/kai/repo'] })
        expect(updated?.paths).toEqual(['/home/kai/repo'])
        expect(updated?.name).toBe('Kai')

        expect(store.workspaceUsers.get(created.id, 'other')).toBeNull()
        expect(store.workspaceUsers.update(created.id, 'other', { name: 'Stolen' })).toBeNull()
        expect(store.workspaceUsers.delete(created.id, 'other')).toBe(false)

        expect(store.workspaceUsers.delete(created.id, 'default')).toBe(true)
        expect(store.workspaceUsers.list('default')).toEqual([])

        store.close()
    })
})
