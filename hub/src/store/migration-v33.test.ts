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
    const dir = mkdtempSync(join(tmpdir(), `hapi-migration-v33-${label}-`))
    tempDirs.push(dir)
    return join(dir, 'hapi.db')
}

function internalDb(store: Store): Database {
    return (store as unknown as { db: Database }).db
}

function userVersion(db: Database): number {
    return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

describe('schema migration v32 to v33', () => {
    it('upgrades a V32 database and keeps its tasks', () => {
        const dbPath = makeDbPath('upgrade')

        const seeded = new Store(dbPath)
        const task = seeded.tasks.create({
            namespace: 'default',
            title: 'Nightly',
            prompt: 'Check.',
            workdir: '/repo',
            spawn: { flavor: 'claude' }
        })
        seeded.close()

        const legacy = new Database(dbPath)
        legacy.exec(`
            DROP TABLE task_schedule_slots;
            DROP TABLE task_schedules;
            PRAGMA user_version = 32;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        expect(userVersion(internalDb(migrated))).toBe(34)
        expect(migrated.tasks.get(task.id)?.title).toBe('Nightly')

        const schedule = migrated.taskSchedules.upsert({
            taskId: task.id,
            namespace: 'default',
            cron: '0 9 * * *',
            tz: 'Asia/Shanghai',
            catchup: true,
            overlap: 'skip',
            sessionMode: 'fresh',
            maxRunMs: 3_600_000,
            nextRunAt: 1_000
        })
        expect(schedule.enabled).toBe(true)

        // Deleting the card takes its schedule with it.
        migrated.tasks.delete(task.id, 'default')
        expect(migrated.taskSchedules.get(task.id)).toBeNull()
        migrated.close()
    })
})
