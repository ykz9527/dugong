import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export const DATABASE_FILE = 'dugong.db'

/** Names the database had before: pitwall's, then upstream HAPI's. */
const LEGACY_DATABASE_FILES = ['pitwall.db', 'hapi.db']

/**
 * The default database path in a data directory.
 *
 * A data directory that still holds only an old database has it renamed to
 * `dugong.db` here, before the store opens it. The WAL and shared-memory
 * files move first and the database last, so an interrupted rename is simply
 * finished on the next start and never leaves a database without its WAL.
 */
export function resolveDefaultDatabasePath(dataDir: string): string {
    const target = join(dataDir, DATABASE_FILE)
    if (existsSync(target)) {
        return target
    }
    const legacy = LEGACY_DATABASE_FILES.map((name) => join(dataDir, name)).find((path) => existsSync(path))
    if (!legacy) {
        return target
    }
    for (const suffix of ['-wal', '-shm']) {
        if (existsSync(legacy + suffix)) {
            renameSync(legacy + suffix, target + suffix)
        }
    }
    renameSync(legacy, target)
    console.log(`[Hub] Renamed ${legacy} to ${target}`)
    return target
}
