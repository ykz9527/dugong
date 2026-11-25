import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { claudeSessionHolders } from './claudeSessionHolders'

const RESUMED = '33e4083a-3c46-4dcc-b8fa-3440222b298b'
const STARTED = '218e2cb8-0000-4000-8000-000000000000'

describe('claudeSessionHolders', () => {
    const roots: string[] = []
    afterEach(() => {
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
    })

    function machine() {
        const root = mkdtempSync(join(tmpdir(), 'holders-'))
        roots.push(root)
        const procRoot = join(root, 'proc')
        const claudeConfigDir = join(root, 'claude')
        mkdirSync(join(claudeConfigDir, 'sessions'), { recursive: true })
        const process = (pid: number, options: { comm: string; exe: string; ppid: number; tty?: number; start: string; fds?: string[] }) => {
            const dir = join(procRoot, String(pid))
            mkdirSync(join(dir, 'fd'), { recursive: true })
            writeFileSync(join(dir, 'comm'), `${options.comm}\n`)
            // Field 3 onwards: state ppid pgrp session tty_nr … starttime (22).
            const fields = ['S', String(options.ppid), '0', '0', String(options.tty ?? 0), ...Array(14).fill('0'), options.start]
            writeFileSync(join(dir, 'stat'), `${pid} (${options.comm}) ${fields.join(' ')} 0 0\n`)
            symlinkSync(options.exe, join(dir, 'exe'))
            ;(options.fds ?? []).forEach((target, index) => symlinkSync(target, join(dir, 'fd', String(index))))
        }
        const record = (pid: number, body: Record<string, unknown>) =>
            writeFileSync(join(claudeConfigDir, 'sessions', `${pid}.json`), JSON.stringify(body))
        return { procRoot, claudeConfigDir, process, record }
    }

    it('follows a terminal claude into the session it resumed', () => {
        // Reproduced on a shared machine: a terminal `claude` that had
        // `/resume`d kept the scratch directory of the session it started
        // with, so the session it was actually writing looked closed.
        const m = machine()
        m.process(400, { comm: 'bash', exe: '/usr/bin/bash', ppid: 1, tty: 34836, start: '10' })
        m.process(401, {
            comm: 'claude', exe: '/home/u/.local/share/claude/versions/2.1.332', ppid: 400, tty: 34836, start: '99',
            fds: [`/tmp/claude-1000/-home-u-proj/${STARTED}/tasks`]
        })
        m.record(401, { pid: 401, sessionId: RESUMED, procStart: '99', entrypoint: 'cli', status: 'idle', updatedAt: 5 })

        const holders = claudeSessionHolders({ procRoot: m.procRoot, claudeConfigDir: m.claudeConfigDir })!

        expect(holders.get(RESUMED)).toEqual([
            { pid: 401, current: true, entrypoint: 'cli', launcher: 'terminal', status: 'idle', statusAt: 5 }
        ])
        // Left behind, not being written: the hub may let an operator who
        // confirms take it, rather than refusing outright.
        expect(holders.get(STARTED)).toEqual([expect.objectContaining({ pid: 401, current: false })])
    })

    it('ignores a record left by an earlier process with the same pid', () => {
        const m = machine()
        m.process(500, { comm: 'claude', exe: '/usr/bin/claude', ppid: 1, start: '200' })
        m.record(500, { pid: 500, sessionId: RESUMED, procStart: '150' })

        expect(claudeSessionHolders({ procRoot: m.procRoot, claudeConfigDir: m.claudeConfigDir })!.size).toBe(0)
    })

    it('finds a claude named by its version, and names the dugong that started it', () => {
        const m = machine()
        m.process(600, { comm: 'dugong-local-bi', exe: '/home/u/.local/bin/dugong-local-bin (deleted)', ppid: 1, start: '1' })
        m.process(601, {
            comm: '2.1.331', exe: '/home/u/.local/share/claude/versions/2.1.331', ppid: 600, start: '7',
            // No record: the scratch directory is all there is, and it counts.
            fds: [`/tmp/claude-1000/-home-u-proj/${STARTED}`]
        })

        const holders = claudeSessionHolders({ procRoot: m.procRoot, claudeConfigDir: m.claudeConfigDir })!

        expect(holders.get(STARTED)).toEqual([
            { pid: 601, current: true, entrypoint: null, launcher: 'dugong-local-bin', status: null, statusAt: null }
        ])
    })
})
