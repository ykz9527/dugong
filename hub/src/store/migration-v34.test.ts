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

describe('schema migration v33 to v34', () => {
    it('adds the session mode to existing schedules, reading them as fresh', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v34-'))
        tempDirs.push(dir)
        const dbPath = join(dir, 'hapi.db')

        const seeded = new Store(dbPath)
        const task = seeded.tasks.create({ namespace: 'default', title: 'Nightly', prompt: 'Check.', workdir: '/repo', spawn: { flavor: 'claude' } })
        seeded.taskSchedules.upsert({
            taskId: task.id, namespace: 'default', cron: '0 9 * * *', tz: 'UTC',
            catchup: true, overlap: 'skip', sessionMode: 'continue', maxRunMs: 3_600_000, nextRunAt: 1_000
        })
        seeded.close()

        const legacy = new Database(dbPath)
        legacy.exec('ALTER TABLE task_schedules DROP COLUMN session_mode; PRAGMA user_version = 33;')
        legacy.close()

        const migrated = new Store(dbPath)
        const db = (migrated as unknown as { db: Database }).db
        expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(35)
        expect(migrated.taskSchedules.get(task.id)?.sessionMode).toBe('fresh')
        migrated.close()
    })
})
