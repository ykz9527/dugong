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

function internalDb(store: Store): Database {
    return (store as unknown as { db: Database }).db
}

describe('schema migration v26 to v27', () => {
    it('adds tasks.pull_request to a V26 database and keeps existing cards', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v27-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        const seeded = new Store(dbPath)
        seeded.tasks.create({
            namespace: 'default', id: 'task-keep', title: 'Keep me',
            prompt: 'p', workdir: '/repo', spawn: { flavor: 'claude' }
        })
        seeded.close()

        const legacy = new Database(dbPath)
        legacy.exec(`
            ALTER TABLE tasks DROP COLUMN pull_request;
            PRAGMA user_version = 26;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        const db = internalDb(migrated)

        const columns = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
        expect(columns.some((column) => column.name === 'pull_request')).toBe(true)
        expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(34)

        // The pre-existing card survives, with no pull request attached.
        const kept = migrated.tasks.get('task-keep')
        expect(kept?.title).toBe('Keep me')
        expect(kept?.pullRequest).toBeNull()

        migrated.close()
    })

    it('round-trips a stored pull request snapshot', () => {
        const store = new Store(':memory:')
        const task = store.tasks.create({
            namespace: 'default', title: 't', prompt: 'p', workdir: '/repo', spawn: { flavor: 'claude' }
        })

        const snapshot = {
            url: 'https://github.com/acme/widget/pull/7',
            number: 7,
            state: 'open',
            title: 'Fix the parser',
            headBranch: 'hapi/fix',
            baseBranch: 'main',
            isDraft: false,
            mergeable: null,
            checks: 'pending',
            checkedAt: 1234
        }

        const updated = store.tasks.setPullRequest(task.id, 'default', snapshot)
        expect(updated?.pullRequest).toEqual(snapshot)
        expect(updated?.seq).toBe(task.seq + 1)

        expect(store.tasks.setPullRequest(task.id, 'default', null)?.pullRequest).toBeNull()
        // Namespace-scoped like every other write.
        expect(store.tasks.setPullRequest(task.id, 'other', snapshot)).toBeNull()

        store.close()
    })
})
