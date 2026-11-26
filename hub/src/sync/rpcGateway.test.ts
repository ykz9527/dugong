import { describe, expect, it } from 'bun:test'
import type { Server } from 'socket.io'
import type { RpcRegistry } from '../socket/rpcRegistry'
import { RpcGateway, RpcTargetMissingError, SideQuestionFailedError } from './rpcGateway'

function createGateway() {
    const timeouts: number[] = []
    const calls: Array<{ method: string; params: string }> = []
    const socket = {
        timeout(timeoutMs: number) {
            timeouts.push(timeoutMs)
            return {
                async emitWithAck(_event: string, payload: { method: string; params: string }) {
                    calls.push(payload)
                    if (payload.method.endsWith(':cursor-chat-store-status')) {
                        return JSON.stringify({ onDisk: false, store: null })
                    }
                    return JSON.stringify({
                        success: true,
                        method: payload.method,
                        params: JSON.parse(payload.params) as unknown
                    })
                }
            }
        }
    }

    const io = {
        of() {
            return {
                sockets: {
                    get() {
                        return socket
                    }
                }
            }
        }
    } as unknown as Server

    const rpcRegistry = {
        getSocketIdForMethod() {
            return 'socket-1'
        }
    } as unknown as RpcRegistry

    return {
        gateway: new RpcGateway(io, rpcRegistry),
        timeouts,
        calls
    }
}

describe('RpcGateway RPC timeouts', () => {
    it('uses the default RPC timeout for regular machine RPCs', async () => {
        const { gateway, timeouts } = createGateway()

        await gateway.listMachineDirectory('machine-1', 'C:\\workspace')

        expect(timeouts).toEqual([30_000])
    })

    it('uses an extended RPC timeout when listing Codex models', async () => {
        const { gateway, timeouts } = createGateway()

        await gateway.listCodexModelsForMachine('machine-1')

        expect(timeouts).toEqual([120_000])
    })

    it('uses the session RPC for explicit Codex fallback discovery', async () => {
        const { gateway, calls, timeouts } = createGateway()

        await gateway.listCodexModelsForSession('session-1')

        expect(calls.map((call) => call.method)).toEqual(['session-1:listCodexModels'])
        expect(timeouts).toEqual([120_000])
    })

    it('uses an extended RPC timeout when listing Cursor models for a machine', async () => {
        const { gateway, timeouts } = createGateway()

        await gateway.listCursorModelsForMachine('machine-1')

        expect(timeouts).toEqual([120_000])
    })

    it('uses an extended RPC timeout when listing Copilot models', async () => {
        const { gateway, timeouts } = createGateway()

        await gateway.listCopilotModelsForCwd('machine-1', '/workspace')
        await gateway.listCopilotModelsForSession('session-1')

        expect(timeouts).toEqual([120_000, 120_000])
    })

    it('forwards the recorded session owner home to the Cursor store probe', async () => {
        const { gateway, calls } = createGateway()

        await gateway.getCursorChatStoreStatus(
            'machine-1',
            '/workspace/project',
            'cursor-session',
            '/home/recorded-owner'
        )

        expect(calls).toEqual([{
            method: 'machine-1:cursor-chat-store-status',
            params: JSON.stringify({
                workspacePath: '/workspace/project',
                cursorSessionId: 'cursor-session',
                homeDir: '/home/recorded-owner'
            })
        }])
    })
})

// tiann/hapi#916: rpcCall throws a typed `RpcTargetMissingError` when the
// target CLI is unreachable, so syncEngine.archiveSession can narrow on it
// and treat the kill as a benign no-op.
describe('RpcGateway no-target diagnostics (tiann/hapi#916)', () => {
    it('throws RpcTargetMissingError(handler-not-registered) when no socket is registered for the method', async () => {
        const io = {
            of() {
                return {
                    sockets: {
                        get() { return undefined }
                    }
                }
            }
        } as unknown as Server
        const rpcRegistry = {
            getSocketIdForMethod() { return undefined }
        } as unknown as RpcRegistry
        const gateway = new RpcGateway(io, rpcRegistry)

        const error = await gateway.killSession('session-1').catch((e: unknown) => e)
        expect(error).toBeInstanceOf(RpcTargetMissingError)
        expect((error as RpcTargetMissingError).code).toBe('handler-not-registered')
    })

    it('throws RpcTargetMissingError(socket-disconnected) when the socket id is registered but no socket exists', async () => {
        const io = {
            of() {
                return {
                    sockets: {
                        get() { return undefined }
                    }
                }
            }
        } as unknown as Server
        const rpcRegistry = {
            getSocketIdForMethod() { return 'socket-1' }
        } as unknown as RpcRegistry
        const gateway = new RpcGateway(io, rpcRegistry)

        const error = await gateway.killSession('session-1').catch((e: unknown) => e)
        expect(error).toBeInstanceOf(RpcTargetMissingError)
        expect((error as RpcTargetMissingError).code).toBe('socket-disconnected')
    })
})

describe('RpcGateway /btw routing', () => {
    function createSideQuestionGateway(opts: { runnerRegistered: boolean; reply: unknown; runnerReply?: unknown }) {
        const calls: Array<{ method: string; params: unknown }> = []
        const socket = {
            timeout() {
                return {
                    async emitWithAck(_event: string, payload: { method: string; params: string }) {
                        calls.push({ method: payload.method, params: JSON.parse(payload.params) as unknown })
                        return JSON.stringify(payload.method.startsWith('machine-1:') && opts.runnerReply ? opts.runnerReply : opts.reply)
                    }
                }
            }
        }
        const io = { of() { return { sockets: { get() { return socket } } } } } as unknown as Server
        const rpcRegistry = {
            getSocketIdForMethod(method: string) {
                return method.startsWith('machine-1:') && !opts.runnerRegistered ? undefined : 'socket-1'
            }
        } as unknown as RpcRegistry
        return { gateway: new RpcGateway(io, rpcRegistry), calls }
    }

    const session = {
        id: 'session-1',
        model: 'claude-opus-5-5',
        metadata: { path: '/work/repo', machineId: 'machine-1', claudeSessionId: 'native-1' }
    }

    it('asks the runner, which runs the newest code, for the session\'s own fork', async () => {
        const { gateway, calls } = createSideQuestionGateway({ runnerRegistered: true, reply: { answer: 'Half done.' } })

        await expect(gateway.askSideQuestion(session, 'How far?')).resolves.toEqual({ answer: 'Half done.' })
        expect(calls).toEqual([{
            method: 'machine-1:side-question',
            params: { question: 'How far?', nativeSessionId: 'native-1', cwd: '/work/repo', model: 'claude-opus-5-5' }
        }])
    })

    it('falls back to the session process when the machine has no runner taking /btw', async () => {
        const { gateway, calls } = createSideQuestionGateway({ runnerRegistered: false, reply: { answer: 'Half done.' } })

        await expect(gateway.askSideQuestion(session, 'How far?')).resolves.toEqual({ answer: 'Half done.' })
        expect(calls).toEqual([{ method: 'session-1:side-question', params: { question: 'How far?' } }])
    })

    it('asks the session itself when the runner may not fork in that directory', async () => {
        const { gateway, calls } = createSideQuestionGateway({
            runnerRegistered: true,
            runnerReply: { error: 'Session directory is outside this machine\'s workspace roots', code: 'side_question_outside_roots' },
            reply: { answer: 'Half done.' }
        })

        await expect(gateway.askSideQuestion(session, 'How far?')).resolves.toEqual({ answer: 'Half done.' })
        expect(calls.map((call) => call.method)).toEqual(['machine-1:side-question', 'session-1:side-question'])
    })

    it('passes the runner\'s no-answer code on', async () => {
        const { gateway } = createSideQuestionGateway({
            runnerRegistered: true,
            reply: { error: 'Claude returned no answer (error_max_turns, tool_use)', code: 'side_question_no_answer' }
        })

        const error = await gateway.askSideQuestion(session, 'How far?').catch((e: unknown) => e)
        expect(error).toBeInstanceOf(SideQuestionFailedError)
        expect((error as SideQuestionFailedError).code).toBe('side_question_no_answer')
    })
})
