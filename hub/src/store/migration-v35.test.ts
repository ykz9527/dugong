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

describe('schema migration v34 to v35', () => {
    it('adds the assistant machine to existing people, leaving it automatic', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v35-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        const seeded = new Store(dbPath)
        const user = seeded.workspaceUsers.create({ namespace: 'default', name: 'Kai', paths: ['/home/kai'] })
        seeded.assistant.setAgent(user.id, 'default', 'codex')
        seeded.close()

        const legacy = new Database(dbPath)
        legacy.exec('ALTER TABLE workspace_users DROP COLUMN assistant_machine_id; PRAGMA user_version = 34;')
        legacy.close()

        const migrated = new Store(dbPath)
        const db = (migrated as unknown as { db: Database }).db
        expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(35)
        expect(migrated.assistant.getMachineId(user.id, 'default')).toBeNull()
        expect(migrated.assistant.getAgent(user.id, 'default')).toBe('codex')
        migrated.assistant.setMachineId(user.id, 'default', 'm-1')
        expect(migrated.assistant.getMachineId(user.id, 'default')).toBe('m-1')
        migrated.close()
    })
})
