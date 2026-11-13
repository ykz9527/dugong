import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDefaultDatabasePath } from './databasePath'

describe('resolveDefaultDatabasePath', () => {
    let dir: string

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'dugong-db-path-'))
    })

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    it('uses dugong.db in an empty data directory', () => {
        expect(resolveDefaultDatabasePath(dir)).toBe(join(dir, 'dugong.db'))
        expect(existsSync(join(dir, 'dugong.db'))).toBe(false)
    })

    it('renames an old pitwall.db, with its WAL and shared-memory files', () => {
        writeFileSync(join(dir, 'pitwall.db'), 'db')
        writeFileSync(join(dir, 'pitwall.db-wal'), 'wal')
        writeFileSync(join(dir, 'pitwall.db-shm'), 'shm')

        expect(resolveDefaultDatabasePath(dir)).toBe(join(dir, 'dugong.db'))

        expect(readFileSync(join(dir, 'dugong.db'), 'utf8')).toBe('db')
        expect(readFileSync(join(dir, 'dugong.db-wal'), 'utf8')).toBe('wal')
        expect(readFileSync(join(dir, 'dugong.db-shm'), 'utf8')).toBe('shm')
        expect(existsSync(join(dir, 'pitwall.db'))).toBe(false)
        expect(existsSync(join(dir, 'pitwall.db-wal'))).toBe(false)
    })

    it('renames an old hapi.db', () => {
        writeFileSync(join(dir, 'hapi.db'), 'db')

        resolveDefaultDatabasePath(dir)

        expect(readFileSync(join(dir, 'dugong.db'), 'utf8')).toBe('db')
        expect(existsSync(join(dir, 'hapi.db'))).toBe(false)
    })

    it('finishes a rename that stopped after the WAL moved', () => {
        writeFileSync(join(dir, 'pitwall.db'), 'db')
        writeFileSync(join(dir, 'dugong.db-wal'), 'wal')

        resolveDefaultDatabasePath(dir)

        expect(readFileSync(join(dir, 'dugong.db'), 'utf8')).toBe('db')
        expect(readFileSync(join(dir, 'dugong.db-wal'), 'utf8')).toBe('wal')
    })

    it('leaves the old file alone when dugong.db already exists', () => {
        writeFileSync(join(dir, 'dugong.db'), 'new')
        writeFileSync(join(dir, 'pitwall.db'), 'old')

        resolveDefaultDatabasePath(dir)

        expect(readFileSync(join(dir, 'dugong.db'), 'utf8')).toBe('new')
        expect(readFileSync(join(dir, 'pitwall.db'), 'utf8')).toBe('old')
    })
})
