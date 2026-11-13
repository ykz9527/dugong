import { describe, expect, it } from 'bun:test'
import { extractBackgroundTaskCount, extractBackgroundTaskDelta } from './backgroundTasks'

/** Wrap a CLI payload the way the agent envelope does on the wire. */
function envelope(data: unknown): unknown {
    return { role: 'agent', content: { type: 'output', data } }
}

describe('extractBackgroundTaskDelta', () => {
    it('counts a backgrounded command from the envelope Claude Code actually sends', () => {
        // Captured from a live run. The tool_result sits on a `user`-type
        // message — it is the tool replying to the model — which an earlier
        // `data.type === 'assistant'` check missed, leaving every background
        // command uncounted.
        const delta = extractBackgroundTaskDelta(envelope({
            type: 'user',
            message: {
                role: 'user',
                content: [{
                    tool_use_id: 'toolu_01NSAmXiiHjgxUuy5M3dZ4ei',
                    type: 'tool_result',
                    content: 'Command running in background with ID: b78ey9oy7. Output is being written to: /tmp/x.output. You will be notified when it completes.',
                    is_error: false
                }]
            }
        }))

        expect(delta).toEqual({ started: 1, completed: 0 })
    })

    it('still counts one arriving on an assistant envelope', () => {
        const delta = extractBackgroundTaskDelta(envelope({
            type: 'assistant',
            message: {
                content: [{ type: 'tool_result', content: 'Command running in background with ID: abc' }]
            }
        }))

        expect(delta).toEqual({ started: 1, completed: 0 })
    })

    it('counts a bare tool_result payload', () => {
        const delta = extractBackgroundTaskDelta(envelope({
            type: 'tool_result',
            content: 'Command running in background with ID: abc'
        }))

        expect(delta).toEqual({ started: 1, completed: 0 })
    })

    it('counts two commands backgrounded in one message', () => {
        const delta = extractBackgroundTaskDelta(envelope({
            type: 'user',
            message: {
                content: [
                    { type: 'tool_result', content: 'Command running in background with ID: a' },
                    { type: 'tool_result', content: 'Command running in background with ID: b' }
                ]
            }
        }))

        expect(delta).toEqual({ started: 2, completed: 0 })
    })

    it('counts the completion notification', () => {
        const delta = extractBackgroundTaskDelta(envelope({
            type: 'user',
            message: { content: '<task-notification>b78ey9oy7 finished</task-notification>' }
        }))

        expect(delta).toEqual({ started: 0, completed: 1 })
    })

    it('ignores an ordinary tool_result', () => {
        expect(extractBackgroundTaskDelta(envelope({
            type: 'user',
            message: { content: [{ type: 'tool_result', content: 'total 4\ndrwxr-xr-x 2 dev dev' }] }
        }))).toBeNull()
    })

    it('ignores anything that is not an agent output envelope', () => {
        expect(extractBackgroundTaskDelta({ role: 'user', content: { type: 'text', text: 'hi' } })).toBeNull()
        expect(extractBackgroundTaskDelta(envelope(null))).toBeNull()
        expect(extractBackgroundTaskDelta(null)).toBeNull()
    })
})

describe('extractBackgroundTaskCount', () => {
    it('reads the snapshot the agent sends when work starts', () => {
        // Captured live: the SDK re-sends the whole set on every change.
        expect(extractBackgroundTaskCount(envelope({
            type: 'system',
            subtype: 'background_tasks_changed',
            tasks: [{ task_id: 'bscntqnzm', task_type: 'local_bash', description: 'sleep then write' }],
            session_id: '9f8e2533'
        }))).toEqual({ total: 1, agents: 0 })
    })

    it('reads zero when the last one finishes', () => {
        expect(extractBackgroundTaskCount(envelope({
            type: 'system',
            subtype: 'background_tasks_changed',
            tasks: [],
            session_id: '9f8e2533'
        }))).toEqual({ total: 0, agents: 0 })
    })

    it('counts every entry in the snapshot', () => {
        expect(extractBackgroundTaskCount(envelope({
            type: 'system',
            subtype: 'background_tasks_changed',
            tasks: [{ task_id: 'a' }, { task_id: 'b' }, { task_id: 'c' }]
        }))).toEqual({ total: 3, agents: 0 })
    })

    it('splits agent work from processes and skips ambient tasks', () => {
        expect(extractBackgroundTaskCount(envelope({
            type: 'system',
            subtype: 'background_tasks_changed',
            tasks: [
                { task_id: 'a', task_type: 'local_agent', description: 'review the diff' },
                { task_id: 'w', task_type: 'local_workflow', description: 'workflow' },
                { task_id: 'b', task_type: 'local_bash', description: 'Start dev server' },
                { task_id: 'm', task_type: 'monitor_ws', description: 'watch', ambient: true }
            ]
        }))).toEqual({ total: 3, agents: 2 })
    })

    it('returns null for anything else, leaving the stored count alone', () => {
        // A zero here would wrongly clear a session that is still busy.
        expect(extractBackgroundTaskCount(envelope({ type: 'system', subtype: 'init', tools: [] }))).toBeNull()
        expect(extractBackgroundTaskCount(envelope({ type: 'assistant', message: { content: [] } }))).toBeNull()
        expect(extractBackgroundTaskCount(envelope({
            type: 'system', subtype: 'background_tasks_changed'
        }))).toBeNull()
        expect(extractBackgroundTaskCount(null)).toBeNull()
    })
})
