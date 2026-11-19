import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { Socket } from 'socket.io'
import { guardSocketListeners } from './guardListeners'

function fakeSocket(): EventEmitter {
    return new EventEmitter()
}

describe('guardSocketListeners', () => {
    it('keeps a throwing listener from escaping and answers its ack with an error', () => {
        const socket = fakeSocket()
        guardSocketListeners(socket as unknown as Socket, 'test')
        const acks: unknown[] = []
        socket.on('update-state', () => {
            throw new Error('SQLITE_FULL')
        })

        expect(() => socket.emit('update-state', { sid: 's' }, (r: unknown) => acks.push(r))).not.toThrow()
        expect(acks).toEqual([{ result: 'error' }])
    })

    it('catches a rejected async listener', async () => {
        const socket = fakeSocket()
        guardSocketListeners(socket as unknown as Socket, 'test')
        const acks: unknown[] = []
        socket.on('message', async () => {
            throw new Error('boom')
        })

        socket.emit('message', {}, (r: unknown) => acks.push(r))
        await Promise.resolve()
        await Promise.resolve()
        expect(acks).toEqual([{ result: 'error' }])
    })

    it('passes arguments through to a healthy listener', () => {
        const socket = fakeSocket()
        guardSocketListeners(socket as unknown as Socket, 'test')
        const seen: unknown[] = []
        socket.on('ping', (payload: unknown) => {
            seen.push(payload)
        })

        socket.emit('ping', 42)
        expect(seen).toEqual([42])
    })
})
