import { readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ClaudeSessionHolder } from '@hapi/protocol/apiTypes'

/**
 * Which sessions a running `claude` is tied to, and how.
 *
 * Two sources, combined so that either one is enough to hold a session back:
 *
 * - Claude's per-process record, `<config>/sessions/<pid>.json`. It names the
 *   session the process is writing *now*, and is the only source that follows
 *   `/resume` and `/clear`. Trusted only while the pid still runs the process
 *   that wrote it (`procStart` matches), since pids are reused.
 * - The scratch directory, `/tmp/claude-<uid>/<cwd>/<id>/`, which a process
 *   keeps a descriptor on. It names the session the process *started* with.
 *   A terminal `claude` that `/resume`d into another session still holds the
 *   first one's directory, so reading only this source let an open terminal
 *   session look closed (and adoptable) a minute after its last write, and
 *   flagged the session it had left as running.
 *
 * One-directional, like any process scan: a holder means "running", no holder
 * means "unknown". The caller keeps its own check for the misses.
 */

const SCRATCH_DIR_SESSION = /^\/tmp\/claude-\d+\/[^/]+\/([0-9a-f-]{36})(?:\/|$)/
/** Agent binaries whose children are another dugong/hapi hub's sessions. */
const HAPI_LAUNCHER = /dugong|pitwall|hapi/i
/** How far up the process tree to look for what started a `claude`. */
const MAX_ANCESTORS = 12

export type ClaudeSessionHolderOptions = {
    procRoot?: string
    /** Claude's config dir, which holds the per-process `sessions/` records. */
    claudeConfigDir: string
}

export type ProcStat = { ppid: number; ttyNr: number; startTime: string }

export function readStat(procRoot: string, pid: number): ProcStat | null {
    try {
        const text = readFileSync(join(procRoot, String(pid), 'stat'), 'utf-8')
        // The command name is parenthesised and may itself contain spaces or
        // parentheses; fields after the last `)` are positional.
        const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
        // `fields[0]` is field 3 (state), so field N sits at N - 3.
        const ppid = Number(fields[1])
        const ttyNr = Number(fields[4])
        const startTime = fields[19]
        if (!Number.isFinite(ppid) || !startTime) return null
        return { ppid, ttyNr: Number.isFinite(ttyNr) ? ttyNr : 0, startTime }
    } catch {
        return null
    }
}

export function readExe(procRoot: string, pid: number): string | null {
    try {
        return readlinkSync(join(procRoot, String(pid), 'exe')).replace(/ \(deleted\)$/, '')
    } catch {
        return null
    }
}

/** A Claude Code process. Its `comm` is `claude`, or the version number when
 *  it runs straight from `~/.local/share/claude/versions/<version>`. */
function isClaudeProcess(procRoot: string, pid: number): boolean {
    let comm: string
    try {
        comm = readFileSync(join(procRoot, String(pid), 'comm'), 'utf-8').trim()
    } catch {
        return false
    }
    if (comm === 'claude') return true
    if (!/^\d+\.\d+\.\d+$/.test(comm)) return false
    return /\/claude\/versions\//.test(readExe(procRoot, pid) ?? '')
}

/** What started a process: a dugong/hapi binary's name, `terminal`, or null. */
export function launcherOf(procRoot: string, stat: ProcStat): string | null {
    let pid = stat.ppid
    for (let depth = 0; depth < MAX_ANCESTORS && pid > 1; depth += 1) {
        const exe = readExe(procRoot, pid)
        if (exe && HAPI_LAUNCHER.test(basename(exe))) return basename(exe)
        const parent = readStat(procRoot, pid)
        if (!parent) break
        pid = parent.ppid
    }
    return stat.ttyNr !== 0 ? 'terminal' : null
}

type ProcessRecord = {
    sessionId: string
    entrypoint: string | null
    status: string | null
    statusAt: number | null
}

function readRecord(path: string, stat: ProcStat): ProcessRecord | null {
    let raw: unknown
    try {
        raw = JSON.parse(readFileSync(path, 'utf-8'))
    } catch {
        return null
    }
    if (!raw || typeof raw !== 'object') return null
    const record = raw as Record<string, unknown>
    if (typeof record.sessionId !== 'string') return null
    // A record left by an earlier process that had the same pid.
    if (String(record.procStart ?? '') !== stat.startTime) return null
    return {
        sessionId: record.sessionId,
        entrypoint: typeof record.entrypoint === 'string' ? record.entrypoint : null,
        status: typeof record.status === 'string' ? record.status : null,
        statusAt: typeof record.updatedAt === 'number' ? record.updatedAt : null
    }
}

function scratchSessions(procRoot: string, pid: number): Set<string> {
    const ids = new Set<string>()
    let fds: string[]
    try {
        fds = readdirSync(join(procRoot, String(pid), 'fd'))
    } catch {
        return ids
    }
    for (const fd of fds) {
        try {
            const match = SCRATCH_DIR_SESSION.exec(readlinkSync(join(procRoot, String(pid), 'fd', fd)))
            if (match) ids.add(match[1]!)
        } catch {
            continue
        }
    }
    return ids
}

/**
 * Session id → the processes tied to it. Null where the question cannot be
 * asked at all (no process table to read).
 */
export function claudeSessionHolders(options: ClaudeSessionHolderOptions): Map<string, ClaudeSessionHolder[]> | null {
    const procRoot = options.procRoot ?? '/proc'
    if (procRoot === '/proc' && process.platform !== 'linux') return null
    let pids: number[]
    try {
        pids = readdirSync(procRoot).filter((entry) => /^\d+$/.test(entry)).map(Number)
    } catch {
        return null
    }

    const holders = new Map<string, ClaudeSessionHolder[]>()
    const add = (sessionId: string, holder: ClaudeSessionHolder) => {
        const list = holders.get(sessionId) ?? []
        list.push(holder)
        holders.set(sessionId, list)
    }

    const sessionsDir = join(options.claudeConfigDir, 'sessions')
    for (const pid of pids) {
        // Every read here races the process exiting; a vanished pid is not an
        // error, it is an answer.
        if (!isClaudeProcess(procRoot, pid)) continue
        const stat = readStat(procRoot, pid)
        if (!stat) continue
        const record = readRecord(join(sessionsDir, `${pid}.json`), stat)
        const base = {
            pid,
            entrypoint: record?.entrypoint ?? null,
            launcher: launcherOf(procRoot, stat),
            status: record?.status ?? null,
            statusAt: record?.statusAt ?? null
        }
        if (record) add(record.sessionId, { ...base, current: true })
        for (const id of scratchSessions(procRoot, pid)) {
            if (record?.sessionId === id) continue
            // Without a record there is nothing to say the process moved on,
            // so the scratch directory is taken at its word.
            add(id, { ...base, current: !record })
        }
    }
    return holders
}
