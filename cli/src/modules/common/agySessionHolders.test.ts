import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { agySessionHolders } from './agySessionHolders'

const TERMINAL = '71ba4bbe-a995-4102-b58f-34898e157290'
const TURN = '8b0c8af4-d6c6-4794-bd8f-9775ff3399c4'

describe('agySessionHolders', () => {
    const roots: string[] = []
    afterEach(() => {
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
    })

    function machine() {
        const root = mkdtempSync(join(tmpdir(), 'agy-holders-'))
        roots.push(root)
        const procRoot = join(root, 'proc')
        const agyHome = join(root, 'antigravity-cli')
        const presence = (id: string) => join(agyHome, 'presence', `${id}.lock`)
        const process = (pid: number, options: { comm: string; exe: string; ppid: number; tty?: number; fds?: string[] }) => {
            const dir = join(procRoot, String(pid))
            mkdirSync(join(dir, 'fd'), { recursive: true })
            writeFileSync(join(dir, 'comm'), `${options.comm}\n`)
            const fields = ['S', String(options.ppid), '0', '0', String(options.tty ?? 0), ...Array(14).fill('0'), '7']
            writeFileSync(join(dir, 'stat'), `${pid} (${options.comm}) ${fields.join(' ')} 0 0\n`)
            symlinkSync(options.exe, join(dir, 'exe'))
            ;(options.fds ?? []).forEach((target, index) => symlinkSync(target, join(dir, 'fd', String(index))))
        }
        return { procRoot, agyHome, presence, process }
    }

    it('names the conversation each agy holds the presence lock of, and who started it', () => {
        const m = machine()
        m.process(100, { comm: 'bash', exe: '/usr/bin/bash', ppid: 1, tty: 34818 })
        // The terminal UI: its log and crash files are open too, and ignored.
        m.process(101, {
            comm: 'agy', exe: '/home/u/.local/bin/agy', ppid: 100, tty: 34818,
            fds: [join(m.agyHome, 'log', 'cli.log'), m.presence(TERMINAL)]
        })
        // A dugong turn: `agy -p … --conversation`, child of the session process.
        m.process(200, { comm: 'dugong-local-bi', exe: '/home/u/.local/bin/dugong-local-bin', ppid: 1 })
        m.process(201, { comm: 'agy', exe: '/home/u/.local/bin/agy', ppid: 200, fds: [m.presence(TURN)] })
        // Something else with a lock-looking file open is not agy.
        m.process(300, { comm: 'cat', exe: '/usr/bin/cat', ppid: 1, fds: [m.presence(TURN)] })

        const holders = agySessionHolders({ procRoot: m.procRoot, agyHome: m.agyHome })!

        expect(holders.get(TERMINAL)).toEqual([
            { pid: 101, current: true, entrypoint: null, launcher: 'terminal', status: null, statusAt: null }
        ])
        expect(holders.get(TURN)).toEqual([expect.objectContaining({ pid: 201, launcher: 'dugong-local-bin' })])
        expect(holders.size).toBe(2)
    })

    it('ignores locks outside this agy home', () => {
        const m = machine()
        m.process(101, { comm: 'agy', exe: '/usr/bin/agy', ppid: 1, fds: [`/elsewhere/presence/${TERMINAL}.lock`] })

        expect(agySessionHolders({ procRoot: m.procRoot, agyHome: m.agyHome })!.size).toBe(0)
    })

    it('cannot answer without a process table', () => {
        expect(agySessionHolders({ procRoot: '/nonexistent-proc', agyHome: '/x' })).toBeNull()
    })
})
