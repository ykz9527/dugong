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
    const dir = mkdtempSync(join(tmpdir(), `hapi-migration-v26-${label}-`))
    tempDirs.push(dir)
    return join(dir, 'hapi.db')
}

function internalDb(store: Store): Database {
    return (store as unknown as { db: Database }).db
}

function tableNames(db: Database): Set<string> {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    return new Set(rows.map((row) => row.name))
}

function columnNames(db: Database, table: string): Set<string> {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return new Set(rows.map((row) => row.name))
}

function insertTask(db: Database, id: string, options?: { currentSessionId?: string | null }): void {
    db.prepare(
        `INSERT INTO tasks (
            id, namespace, title, prompt, column_id, machine_id, workdir,
            isolation, spawn_config, current_session_id, created_at, updated_at
         ) VALUES (?, 'default', ?, ?, 'backlog', NULL, '/repo', 'worktree', '{"flavor":"claude"}', ?, 1, 1)`
    ).run(id, `title-${id}`, `prompt-${id}`, options?.currentSessionId ?? null)
}

describe('schema migration v25 to v26', () => {
    it('creates the board tables on a fresh database', () => {
        const store = new Store(makeDbPath('fresh'))
        const db = internalDb(store)

        const tables = tableNames(db)
        expect(tables.has('tasks')).toBe(true)
        expect(tables.has('task_runs')).toBe(true)
        expect(columnNames(db, 'sessions').has('task_id')).toBe(true)

        const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
        expect(version.user_version).toBe(35)

        store.close()
    })

    it('upgrades a V25 database and keeps existing session rows', () => {
        const dbPath = makeDbPath('upgrade')

        const seeded = new Store(dbPath)
        // `requestedId` (8th arg) pins the row id so the assertions below can name it.
        seeded.sessions.getOrCreateSession(
            'sess-1', { path: '/repo', host: 'box' }, null, 'default',
            undefined, undefined, undefined, 'sess-1'
        )
        seeded.close()

        // Rewind to a V25-shaped DB: board tables gone, `task_id` gone.
        const legacy = new Database(dbPath)
        legacy.exec(`
            DROP INDEX IF EXISTS idx_sessions_task;
            DROP TABLE IF EXISTS task_runs;
            DROP TABLE IF EXISTS tasks;
            ALTER TABLE sessions DROP COLUMN task_id;
            PRAGMA user_version = 25;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        const db = internalDb(migrated)

        const tables = tableNames(db)
        expect(tables.has('tasks')).toBe(true)
        expect(tables.has('task_runs')).toBe(true)
        expect(columnNames(db, 'sessions').has('task_id')).toBe(true)

        const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
        expect(version.user_version).toBe(35)

        // The pre-existing session survives, unattached to any task.
        const session = migrated.sessions.getSession('sess-1')
        expect(session).not.toBeNull()
        const taskId = db.prepare('SELECT task_id FROM sessions WHERE id = ?').get('sess-1') as { task_id: string | null }
        expect(taskId.task_id).toBeNull()

        // And the migrated DB accepts board rows.
        insertTask(db, 'task-1', { currentSessionId: 'sess-1' })
        const row = db.prepare('SELECT column_id, isolation FROM tasks WHERE id = ?').get('task-1') as {
            column_id: string
            isolation: string
        }
        expect(row.column_id).toBe('backlog')
        expect(row.isolation).toBe('worktree')

        migrated.close()
    })

    it('is a no-op when run twice against an already-migrated database', () => {
        const dbPath = makeDbPath('idempotent')

        const first = new Store(dbPath)
        insertTask(internalDb(first), 'task-keep')
        first.close()

        const reopened = new Store(dbPath)
        const db = internalDb(reopened)
        const kept = db.prepare('SELECT id FROM tasks WHERE id = ?').get('task-keep') as { id: string } | undefined
        expect(kept?.id).toBe('task-keep')

        reopened.close()
    })

    it('clears current_session_id when the session is deleted, and cascades runs when the task is', () => {
        const store = new Store(makeDbPath('fk'))
        const db = internalDb(store)

        store.sessions.getOrCreateSession(
            'sess-fk', { path: '/repo', host: 'box' }, null, 'default',
            undefined, undefined, undefined, 'sess-fk'
        )
        insertTask(db, 'task-fk', { currentSessionId: 'sess-fk' })
        db.prepare(
            `INSERT INTO task_runs (id, task_id, session_id, status, origin, started_at)
             VALUES ('run-fk', 'task-fk', 'sess-fk', 'running', 'user', 1)`
        ).run()

        // Session deleted: the live pointer is nulled, the run row keeps the id.
        expect(store.sessions.deleteSession('sess-fk', 'default')).toBe(true)
        const task = db.prepare('SELECT current_session_id FROM tasks WHERE id = ?').get('task-fk') as {
            current_session_id: string | null
        }
        expect(task.current_session_id).toBeNull()
        const run = db.prepare('SELECT session_id FROM task_runs WHERE id = ?').get('run-fk') as {
            session_id: string | null
        }
        expect(run.session_id).toBe('sess-fk')

        // Task deleted: its runs go with it.
        db.prepare('DELETE FROM tasks WHERE id = ?').run('task-fk')
        const remaining = db.prepare('SELECT COUNT(*) AS n FROM task_runs').get() as { n: number }
        expect(remaining.n).toBe(0)

        store.close()
    })
})
