/**
 * Background tasks the agent said it is waiting on.
 *
 * The board only holds a card in `running` for background *agents*; a
 * backgrounded shell lets it into review, because the usual one is a dev server
 * that never finishes. Some shells are different: the agent ends its turn on a
 * long run whose result it needs, and will pick up again when it lands. The
 * agent says so through the hapi `await_background_task` tool, and those tasks
 * hold the card like an agent does.
 *
 * A declaration names either a Claude Code background task id (released when
 * the task drops out of the snapshot) or a pid (released when the process is
 * gone). Either way it is also released when the agent starts another turn: by
 * then it has either the result or a new plan, and will declare again if it
 * still needs to wait. Nothing here can outlive the CLI process, so a dead
 * session cannot leave a card stuck.
 */

/** How long a declared task id may go unseen in a snapshot before it is
 *  dropped. The snapshot can trail the tool call, but a typo must not hold. */
export const UNSEEN_TASK_GRACE_MS = 30_000

/** How long `thinking` must have been off before turning on counts as a new
 *  turn. Shorter blips are the same turn (a PTY spinner redraw, say). */
export const TURN_GAP_MS = 1_500

type Declaration =
    | { kind: 'task'; taskId: string; declaredAt: number; seen: boolean }
    | { kind: 'pid'; pid: number; declaredAt: number }

export type DeclareAwaitedInput = { taskId?: string; pid?: number }

export type DeclareAwaitedResult =
    | { ok: true; warning?: string }
    | { ok: false; error: string }

function defaultIsPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        // EPERM: it exists, it just is not ours to signal.
        return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
}

export class AwaitedBackgroundTasks {
    private readonly declarations = new Map<string, Declaration>()
    /** Task ids in the last snapshot, or null before the first one. */
    private liveTaskIds: Set<string> | null = null
    private thinking = false
    private notThinkingSince: number | null = null
    private readonly now: () => number
    private readonly isPidAlive: (pid: number) => boolean

    constructor(options: { now?: () => number; isPidAlive?: (pid: number) => boolean } = {}) {
        this.now = options.now ?? Date.now
        this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive
    }

    declare(input: DeclareAwaitedInput): DeclareAwaitedResult {
        const taskId = input.taskId?.trim()
        if (taskId) {
            // Accepted even when the last snapshot lacks it: the snapshot can
            // trail the command that started the task. Unseen, it lapses.
            const seen = this.liveTaskIds?.has(taskId) ?? false
            this.declarations.set(`task:${taskId}`, { kind: 'task', taskId, declaredAt: this.now(), seen })
            return seen || !this.liveTaskIds
                ? { ok: true }
                : {
                    ok: true,
                    warning: `"${taskId}" is not among the running background tasks yet`
                        + ` (${[...this.liveTaskIds].join(', ') || 'none'}); the wait lapses if it does not show up.`
                }
        }
        if (input.pid !== undefined) {
            if (!Number.isInteger(input.pid) || input.pid <= 0) {
                return { ok: false, error: `Invalid pid: ${input.pid}` }
            }
            if (!this.isPidAlive(input.pid)) {
                return { ok: false, error: `No process with pid ${input.pid} is running` }
            }
            this.declarations.set(`pid:${input.pid}`, { kind: 'pid', pid: input.pid, declaredAt: this.now() })
            return { ok: true }
        }
        return { ok: false, error: 'Pass taskId (the background task id) or pid' }
    }

    /** Feed every background-task snapshot (non-ambient task ids). */
    onSnapshot(taskIds: Iterable<string>): void {
        this.liveTaskIds = new Set(taskIds)
        for (const [key, declaration] of this.declarations) {
            if (declaration.kind !== 'task') continue
            if (this.liveTaskIds.has(declaration.taskId)) {
                declaration.seen = true
            } else if (declaration.seen) {
                this.declarations.delete(key)
            }
        }
    }

    /** Feed the agent's thinking state; a new turn releases every declaration. */
    onThinking(thinking: boolean): void {
        const now = this.now()
        if (thinking && !this.thinking) {
            if (this.notThinkingSince !== null && now - this.notThinkingSince >= TURN_GAP_MS) {
                this.declarations.clear()
            }
            this.notThinkingSince = null
        } else if (!thinking && this.thinking) {
            this.notThinkingSince = now
        }
        this.thinking = thinking
    }

    /** The agent process is gone, and its background tasks with it. */
    reset(): void {
        this.declarations.clear()
        this.liveTaskIds = null
    }

    /** How many declarations still hold, dropping any that have lapsed. */
    count(): number {
        const now = this.now()
        for (const [key, declaration] of this.declarations) {
            const lapsed = declaration.kind === 'pid'
                ? !this.isPidAlive(declaration.pid)
                : !declaration.seen && now - declaration.declaredAt > UNSEEN_TASK_GRACE_MS
            if (lapsed) this.declarations.delete(key)
        }
        return this.declarations.size
    }
}
