import type { Socket } from 'socket.io'

type Listener = (...args: unknown[]) => unknown

/**
 * Make every listener later added with `socket.on` fail alone.
 *
 * socket.io runs listeners inside `process.nextTick`, so a synchronous throw
 * (for example SQLITE_FULL from a store write) becomes an uncaught exception
 * and takes the whole hub down with every connection on it. A guarded
 * listener logs the error and, when the event carries an acknowledgement,
 * answers it with `{ result: 'error' }` so the sender does not wait forever.
 * socket.io ignores a second call, so a listener that already answered is safe.
 */
export function guardSocketListeners(socket: Socket, scope: string): void {
    const on = socket.on.bind(socket) as (event: string, listener: Listener) => Socket
    const guardedOn = (event: string, listener: Listener): Socket => on(event, (...args: unknown[]) => {
        const ack = args.at(-1)
        const fail = (error: unknown) => {
            console.error(`[socket:${scope}] '${event}' handler failed:`, error)
            if (typeof ack === 'function') {
                try {
                    ack({ result: 'error' })
                } catch {
                    // The connection may already be gone.
                }
            }
        }
        try {
            const result = listener(...args)
            if (result instanceof Promise) {
                result.catch(fail)
            }
        } catch (error) {
            fail(error)
        }
    })
    socket.on = guardedOn as typeof socket.on
}
