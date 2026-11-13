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
    const dir = mkdtempSync(join(tmpdir(), `hapi-migration-v29-${label}-`))
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

describe('schema migration v28 to v29', () => {
    it('creates both push targets with a workspace user column on a fresh database', () => {
        const store = new Store(makeDbPath('fresh'))
        const db = internalDb(store)

        expect(columns(db, 'push_subscriptions')).toContain('workspace_user_id')
        expect(columns(db, 'fcm_devices')).toContain('workspace_user_id')
        expect(userVersion(db)).toBe(34)

        store.close()
    })

    it('upgrades a V28 database and leaves existing targets unfiltered', () => {
        const dbPath = makeDbPath('upgrade')

        const seeded = new Store(dbPath)
        seeded.push.addPushSubscription('default', { endpoint: 'https://push/1', p256dh: 'k', auth: 'a' })
        seeded.fcm.upsertDevice('default', { token: 'tok-1', platform: 'phone', deviceId: 'phone-1' })
        seeded.close()

        const legacy = new Database(dbPath)
        legacy.exec(`
            ALTER TABLE push_subscriptions DROP COLUMN workspace_user_id;
            ALTER TABLE fcm_devices DROP COLUMN workspace_user_id;
            PRAGMA user_version = 28;
        `)
        legacy.close()

        const migrated = new Store(dbPath)
        expect(userVersion(internalDb(migrated))).toBe(34)

        // Null, not "nobody": a device registered before the column existed
        // made no claim about whose work it wants, and muting it would be a
        // worse regression than the leak this migration exists to close.
        const subscriptions = migrated.push.getPushSubscriptionsByNamespace('default')
        expect(subscriptions).toHaveLength(1)
        expect(subscriptions[0].workspaceUserId).toBeNull()

        const devices = migrated.fcm.getDevicesByNamespace('default')
        expect(devices).toHaveLength(1)
        expect(devices[0].workspaceUserId).toBeNull()

        migrated.close()
    })

    it('overwrites the workspace user when a target re-registers under a new one', () => {
        const store = new Store(makeDbPath('rescope'))

        store.push.addPushSubscription('default', {
            endpoint: 'https://push/1', p256dh: 'k', auth: 'a', workspaceUserId: 'zhou'
        })
        store.push.addPushSubscription('default', {
            endpoint: 'https://push/1', p256dh: 'k', auth: 'a', workspaceUserId: 'kzz'
        })
        expect(store.push.getPushSubscriptionsByNamespace('default')[0].workspaceUserId).toBe('kzz')

        store.fcm.upsertDevice('default', {
            token: 'tok-1', platform: 'phone', deviceId: 'phone-1', workspaceUserId: 'zhou'
        })
        store.fcm.upsertDevice('default', {
            token: 'tok-1', platform: 'phone', deviceId: 'phone-1', workspaceUserId: 'kzz'
        })
        expect(store.fcm.getDevicesByNamespace('default')[0].workspaceUserId).toBe('kzz')

        // Switching back to "everybody" has to clear the column too, or a
        // browser that dropped its filter would stay stuck on one person.
        store.push.addPushSubscription('default', { endpoint: 'https://push/1', p256dh: 'k', auth: 'a' })
        expect(store.push.getPushSubscriptionsByNamespace('default')[0].workspaceUserId).toBeNull()

        store.close()
    })
})
