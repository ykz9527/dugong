import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentSessionBase } from './sessionBase';

type KeepAliveCall = {
    thinking: boolean;
    mode: 'local' | 'remote';
    runtime?: { permissionMode?: string; activePermissionMode?: string | null };
};

function createSession(permissionMode?: 'default' | 'auto') {
    const calls: KeepAliveCall[] = [];
    const client = {
        keepAlive: (thinking: boolean, mode: 'local' | 'remote', runtime?: KeepAliveCall['runtime']) => {
            calls.push({ thinking, mode, runtime });
        },
        emitMessagesConsumed: () => {}
    };
    const session = new AgentSessionBase<unknown>({
        api: {} as never,
        client: client as never,
        path: '/tmp/project',
        logPath: '/tmp/log',
        sessionId: 'session-1',
        messageQueue: { onBatchConsumed: null } as never,
        onModeChange: () => {},
        sessionLabel: 'test',
        sessionIdLabel: 'test',
        applySessionIdToMetadata: (metadata) => metadata,
        permissionMode
    });
    session.stopKeepAlive();
    return { session, calls };
}

describe('AgentSessionBase active permission mode', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('reports the mode a process was started with alongside the chosen one', () => {
        // The hub can only tell the UI "chosen, not yet in effect" if the two
        // travel separately on the same keep-alive.
        const { session, calls } = createSession('auto');
        session.setActivePermissionMode('default');
        session.pushKeepAlive();

        const last = calls.at(-1);
        expect(last?.runtime?.permissionMode).toBe('auto');
        expect(last?.runtime?.activePermissionMode).toBe('default');
    });

    it('sends null once the process is gone, so the hub clears it', () => {
        // Omitting the field would leave the hub reporting a mode belonging to
        // a process that has exited.
        const { session, calls } = createSession('auto');
        session.setActivePermissionMode('auto');
        session.setActivePermissionMode(null);
        session.pushKeepAlive();

        expect(calls.at(-1)?.runtime?.activePermissionMode).toBeNull();
    });

    it('stays absent for agents that never report one', () => {
        // Flavors whose modes are enforced by HAPI itself have nothing to say
        // here, and the hub must not infer a value from silence.
        const { session, calls } = createSession('default');
        session.pushKeepAlive();

        expect(calls.at(-1)?.runtime?.activePermissionMode).toBeUndefined();
    });
});
