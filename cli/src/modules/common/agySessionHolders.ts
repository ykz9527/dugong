import { readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ClaudeSessionHolder } from '@hapi/protocol/apiTypes'
import { launcherOf, readExe, readStat } from './claudeSessionHolders'

/**
 * Which agy conversations a running `agy` is tied to.
 *
 * Every agy process — the terminal UI and each `agy -p` / `agy acp` turn —
 * takes an flock on `<agy home>/presence/<conversation id>.lock` for the
 * conversation it is on, and keeps the file open. The lock follows `/resume`
 * and `/new`, so the open descriptor names the conversation the process is
 * on *now*. Read from `/proc/<pid>/fd` only: probing the lock ourselves could
 * make a real agy miss it for that instant.
 *
 * One-directional, like the Claude scan: a holder means "running", no holder
 * means "unknown".
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type AgySessionHolderOptions = {
    procRoot?: string
    /** agy's data directory, normally `~/.gemini/antigravity-cli`. */
    agyHome: string
}

function isAgyProcess(procRoot: string, pid: number): boolean {
    let comm: string
    try {
        comm = readFileSync(join(procRoot, String(pid), 'comm'), 'utf-8').trim()
    } catch {
        return false
    }
    if (comm === 'agy') return true
    // A renamed thread or a wrapper exec'd under another comm still runs the binary.
    return basename(readExe(procRoot, pid) ?? '') === 'agy'
}

function heldConversations(procRoot: string, pid: number, presenceDir: string): string[] {
    let fds: string[]
    try {
        fds = readdirSync(join(procRoot, String(pid), 'fd'))
    } catch {
        return []
    }
    const ids: string[] = []
    for (const fd of fds) {
        let target: string
        try {
            target = readlinkSync(join(procRoot, String(pid), 'fd', fd))
        } catch {
            continue
        }
        if (!target.startsWith(`${presenceDir}/`) || !target.endsWith('.lock')) continue
        const id = basename(target, '.lock')
        if (UUID.test(id) && !ids.includes(id)) ids.push(id)
    }
    return ids
}

/** Conversation id → the processes holding it. Null where that cannot be known. */
export function agySessionHolders(options: AgySessionHolderOptions): Map<string, ClaudeSessionHolder[]> | null {
    const procRoot = options.procRoot ?? '/proc'
    if (procRoot === '/proc' && process.platform !== 'linux') return null
    let pids: number[]
    try {
        pids = readdirSync(procRoot).filter((entry) => /^\d+$/.test(entry)).map(Number)
    } catch {
        return null
    }

    const presenceDir = join(options.agyHome, 'presence')
    const holders = new Map<string, ClaudeSessionHolder[]>()
    for (const pid of pids) {
        // Every read races the process exiting; a vanished pid is an answer.
        if (!isAgyProcess(procRoot, pid)) continue
        const ids = heldConversations(procRoot, pid, presenceDir)
        if (ids.length === 0) continue
        const stat = readStat(procRoot, pid)
        const holder: ClaudeSessionHolder = {
            pid,
            current: true,
            entrypoint: null,
            launcher: stat ? launcherOf(procRoot, stat) : null,
            status: null,
            statusAt: null
        }
        for (const id of ids) holders.set(id, [...(holders.get(id) ?? []), holder])
    }
    return holders
}
