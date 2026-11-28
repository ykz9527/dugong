import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import type { AgentState } from '@/api/types';
import type { AcpSdkBackend } from '@/agent/backends/acp';
import type { PermissionRequest, PermissionResponse } from '@/agent/types';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { AgyMode, PermissionMode } from './types';

vi.mock('@/ui/ink/RemoteModeDisplay', () => ({ RemoteModeDisplay: () => null }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));

import { AgyRemoteLauncher } from './agyRemoteLauncher';
import { setAssistantRole } from '@/claude/assistantRole';
import type { ConfirmToolGate } from '@/claude/utils/startHappyServer';

/** The options `agy acp` 1.5.16 sends: no allow_always. */
const AGY_OPTIONS = [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
];

function commandRequest(id: string, command: string): PermissionRequest {
    return {
        id,
        sessionId: 'conv-1',
        toolCallId: id,
        title: command,
        kind: 'execute',
        rawInput: { CommandLine: command },
        options: AGY_OPTIONS
    };
}

type Harness = ReturnType<typeof createHarness>;

/**
 * Fake `agy acp`: each prompt raises the given permission requests one at a
 * time and waits for HAPI's answer, as agy does mid-turn.
 */
function createHarness(opts: {
    turns: PermissionRequest[][];
    permissionMode?: PermissionMode;
    resumeId?: string | null;
    loadFails?: boolean;
    mode?: AgyMode;
}) {
    const answers: Array<{ id: string; outcome: PermissionResponse }> = [];
    let permissionHandler: ((request: PermissionRequest) => void) | null = null;
    let waiter: ((outcome: PermissionResponse) => void) | null = null;
    let turn = 0;
    let agentState: AgentState = {};
    let permissionRpc: ((response: unknown) => Promise<void>) | null = null;
    const pendingSeen: Array<() => void> = [];

    const backend = {
        initialize: vi.fn(async () => {}),
        newSession: vi.fn(async () => 'conv-new'),
        loadSession: vi.fn(async (config: { sessionId: string }) => {
            if (opts.loadFails) throw new Error('Session not found');
            return config.sessionId;
        }),
        getConfigOptionByCategory: vi.fn(() => ({ id: 'model', currentValue: 'gemini-4-neon', options: [] })),
        getSessionModelsMetadata: vi.fn(() => undefined),
        getThoughtLevelConfigOption: vi.fn(() => ({
            id: 'thought_level',
            currentValue: 'high',
            options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }]
        })),
        setModel: vi.fn(async () => {}),
        setConfigOption: vi.fn(async () => {}),
        onPermissionRequest: (handler: (request: PermissionRequest) => void) => { permissionHandler = handler; },
        respondToPermission: vi.fn(async (_sessionId: string, request: PermissionRequest, outcome: PermissionResponse) => {
            answers.push({ id: request.id, outcome });
            waiter?.(outcome);
        }),
        prompt: vi.fn(async (_sessionId: string, _content: unknown, onUpdate: (message: unknown) => void) => {
            for (const request of opts.turns[turn++] ?? []) {
                const answered = new Promise<PermissionResponse>((resolve) => { waiter = resolve; });
                permissionHandler?.(request);
                const outcome = await answered;
                const allowed = outcome.outcome === 'selected' && outcome.optionId === 'allow';
                onUpdate({ type: 'text', text: allowed ? `ran ${request.title}` : `denied ${request.title}` });
            }
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });
        }),
        cancelPrompt: vi.fn(async () => {}),
        onStderrError: vi.fn(),
        disconnect: vi.fn(async () => {})
    };

    const queue = new MessageQueue2<AgyMode>((mode) => JSON.stringify(mode));
    let permissionMode: PermissionMode = opts.permissionMode ?? 'request-review';
    const session = {
        path: '/tmp/agy-test',
        logPath: '/tmp/agy-test/hapi.log',
        sessionId: opts.resumeId ?? null,
        queue,
        client: {
            rpcHandlerManager: {
                registerHandler: (method: string, handler: (params: unknown) => Promise<void>) => {
                    if (method === RPC_METHODS.Permission) permissionRpc = handler;
                }
            },
            updateAgentState: (update: (state: AgentState) => AgentState) => {
                agentState = update(agentState);
                if (Object.keys(agentState.requests ?? {}).length > 0) pendingSeen.splice(0).forEach((fn) => fn());
            },
            getMetadata: () => ({}),
            updateMetadata: vi.fn()
        },
        getPermissionMode: () => permissionMode,
        setKillHandler: vi.fn(),
        onSessionFound: vi.fn(),
        onThinkingChange: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn()
    };

    const mcpStop = vi.fn();
    const mcpArgs = [
        'mcp',
        '--url',
        'http://127.0.0.1:41234',
        '--tools',
        'display_image,display_video,display_media,list_peers,ping_peer,inspect_peer,skill_lookup'
    ];
    const buildMcpBridge = vi.fn(async () => ({
        server: { url: 'http://127.0.0.1:41234', stop: mcpStop },
        mcpServers: {
            hapi: {
                command: 'dugong',
                args: mcpArgs
            }
        }
    }));

    const launcher = new AgyRemoteLauncher(session as never, {
        createBackend: () => backend as unknown as AcpSdkBackend,
        readTitle: async () => null,
        hasGrant: async () => false,
        buildMcpBridge
    });

    return {
        backend,
        session,
        launcher,
        answers,
        buildMcpBridge,
        mcpStop,
        expectedMcpServers: [{ name: 'hapi', command: 'dugong', args: mcpArgs, env: [] }],
        get agentState() { return agentState; },
        /** The confirm-first gate the launcher handed the MCP server, if any. */
        confirmTool: () => (buildMcpBridge.mock.calls[0] as unknown as [unknown, { confirmTool?: ConfirmToolGate }] | undefined)?.[1]?.confirmTool,
        setPermissionMode: (mode: PermissionMode) => { permissionMode = mode; },
        push: (text: string) => queue.push(text, opts.mode ?? { permissionMode }),
        close: () => queue.close(),
        /** Resolves once a permission card is waiting for the user. */
        nextPending: () => new Promise<void>((resolve) => {
            if (Object.keys(agentState.requests ?? {}).length > 0) resolve();
            else pendingSeen.push(resolve);
        }),
        answer: async (response: { id: string; approved: boolean; decision?: string }) => {
            await permissionRpc?.(response);
        }
    };
}

function sentTexts(h: Harness): string[] {
    return h.session.sendAgentMessage.mock.calls
        .map(([message]) => (message as { type: string; message?: string }))
        .filter((message) => message.type === 'message')
        .map((message) => message.message ?? '');
}

describe('AgyRemoteLauncher permissions (request-review)', () => {
    it('shows a blocked command as a permission card instead of denying it', async () => {
        const h = createHarness({ turns: [[commandRequest('t1', 'uname -a')]] });
        h.push('run uname');
        const run = h.launcher.launch();

        await h.nextPending();
        expect(h.agentState.requests?.t1).toMatchObject({ tool: 'uname -a', arguments: { CommandLine: 'uname -a' } });
        expect(h.answers).toEqual([]);

        await h.answer({ id: 't1', approved: false, decision: 'denied' });
        h.close();
        await run;

        expect(h.answers).toEqual([{ id: 't1', outcome: { outcome: 'selected', optionId: 'deny' } }]);
        expect(h.agentState.completedRequests?.t1).toMatchObject({ status: 'denied', decision: 'denied' });
        expect(sentTexts(h)).toContain('denied uname -a');
    });

    it('continues the same turn once the user allows it', async () => {
        const h = createHarness({ turns: [[commandRequest('t1', 'uname -a')]] });
        h.push('run uname');
        const run = h.launcher.launch();

        await h.nextPending();
        await h.answer({ id: 't1', approved: true, decision: 'approved' });
        h.close();
        await run;

        expect(h.answers).toEqual([{ id: 't1', outcome: { outcome: 'selected', optionId: 'allow' } }]);
        expect(h.backend.prompt).toHaveBeenCalledTimes(1);
        expect(sentTexts(h)).toContain('ran uname -a');
        expect(h.session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
    });

    it('remembers "allow for session" itself, since agy offers no allow_always', async () => {
        const h = createHarness({
            turns: [[commandRequest('t1', 'uname -a')], [commandRequest('t2', 'uname -a'), commandRequest('t3', 'rm -rf build')]]
        });
        h.push('first');
        const run = h.launcher.launch();

        await h.nextPending();
        await h.answer({ id: 't1', approved: true, decision: 'approved_for_session' });
        h.push('second');

        // t2 (same command) goes through without a card; t3 (another command) asks.
        await vi.waitFor(() => expect(h.agentState.requests?.t3).toBeDefined());
        expect(h.agentState.requests?.t2).toBeUndefined();
        await h.answer({ id: 't3', approved: false, decision: 'denied' });
        h.close();
        await run;

        expect(h.answers.map((a) => [a.id, a.outcome])).toEqual([
            ['t1', { outcome: 'selected', optionId: 'allow' }],
            ['t2', { outcome: 'selected', optionId: 'allow' }],
            ['t3', { outcome: 'selected', optionId: 'deny' }]
        ]);
    });

    it('auto-approves once the session is switched to always-proceed', async () => {
        const h = createHarness({ turns: [[commandRequest('t1', 'uname -a')], [commandRequest('t2', 'make test')]] });
        h.push('first');
        const run = h.launcher.launch();

        await h.nextPending();
        await h.answer({ id: 't1', approved: false, decision: 'denied' });
        h.setPermissionMode('always-proceed');
        h.push('resend');
        h.close();
        await run;

        expect(h.answers[1]).toEqual({ id: 't2', outcome: { outcome: 'selected', optionId: 'allow' } });
        expect(h.agentState.completedRequests?.t2).toMatchObject({ status: 'approved' });
        expect(sentTexts(h)).toContain('ran make test');
    });
});

describe('AgyRemoteLauncher session setup', () => {
    it('resumes the agy conversation and applies the queued model and effort', async () => {
        const h = createHarness({
            turns: [[]],
            resumeId: 'conv-1',
            mode: { permissionMode: 'request-review', model: 'gemini-4-carbon-high', effort: 'low' }
        });
        h.push('hello');
        h.close();
        await h.launcher.launch();

        expect(h.buildMcpBridge).toHaveBeenCalledWith(h.session.client, {
            enableChangeTitle: false,
            skillLookup: { workingDirectory: '/tmp/agy-test', flavor: 'agy' }
        });
        expect(h.backend.loadSession).toHaveBeenCalledWith({
            cwd: '/tmp/agy-test',
            mcpServers: h.expectedMcpServers,
            sessionId: 'conv-1'
        });
        expect(h.backend.newSession).not.toHaveBeenCalled();
        expect(h.session.onSessionFound).toHaveBeenCalledWith('conv-1');
        expect(h.backend.setModel).toHaveBeenCalledWith('conv-1', 'gemini-4-carbon-high');
        expect(h.backend.setConfigOption).toHaveBeenCalledWith('conv-1', 'thought_level', 'low');
        expect(h.mcpStop).toHaveBeenCalledTimes(1);
    });

    it('starts a new conversation with MCP servers and a notice when resume fails', async () => {
        const h = createHarness({ turns: [[]], resumeId: 'conv-gone', loadFails: true });
        h.push('hello');
        h.close();
        await h.launcher.launch();

        expect(h.backend.newSession).toHaveBeenCalledWith({
            cwd: '/tmp/agy-test',
            mcpServers: h.expectedMcpServers
        });
        expect(h.session.onSessionFound).toHaveBeenCalledWith('conv-new');
        expect(h.session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'agy could not resume this conversation; starting a new one.'
        });
        expect(h.mcpStop).toHaveBeenCalledTimes(1);
    });
});

describe('AgyRemoteLauncher as a task assistant', () => {
    const hubToolRequest = (id: string, tool: string): PermissionRequest => ({
        id,
        sessionId: 'conv-new',
        toolCallId: id,
        title: `Run mcp_hapi_${tool}`,
        kind: 'other',
        rawInput: { taskId: 't-1' },
        options: AGY_OPTIONS
    });

    it('gives agy the assistant tools and prompt, and lets agy\'s own asks for hub tools through', async () => {
        setAssistantRole({ workspaceUserId: 'wu-1', addDirs: [] });
        try {
            const h = createHarness({ turns: [[hubToolRequest('t1', 'memory_read')]] });
            h.push('hello');
            h.close();
            await h.launcher.launch();

            expect(h.buildMcpBridge).toHaveBeenCalledWith(h.session.client, expect.objectContaining({
                assistant: true,
                confirmTool: expect.any(Function)
            }));
            const config = h.backend.newSession.mock.calls[0] as unknown as [{ _meta?: { antigravity?: { systemPrompt?: { append?: string } } } }];
            const prompt = config[0]._meta?.antigravity?.systemPrompt?.append ?? '';
            expect(prompt).toContain('mcp_hapi_<name>');
            expect(prompt).toContain("You are this person's task assistant");
            // Answered without a card: the confirm-first ones ask in the server instead.
            expect(h.answers).toEqual([{ id: 't1', outcome: { outcome: 'selected', optionId: 'allow' } }]);
        } finally {
            setAssistantRole(null);
        }
    });

    it('keeps a confirm-first ask open across the end of a turn', async () => {
        setAssistantRole({ workspaceUserId: 'wu-1', addDirs: [] });
        try {
            const h = createHarness({ turns: [[], []] });
            h.push('first');
            const run = h.launcher.launch();
            await vi.waitFor(() => expect(h.backend.prompt).toHaveBeenCalledTimes(1));

            const action = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'moved' }], isError: false }));
            const result = h.confirmTool()!('task_move', { taskId: 't-1' }, action);
            await h.nextPending();
            const [id, request] = Object.entries(h.agentState.requests ?? {})[0];
            expect(request).toMatchObject({ tool: 'mcp__hapi__task_move', arguments: { taskId: 't-1' } });

            // Another turn ends while the person has not answered yet.
            h.push('second');
            await vi.waitFor(() => expect(h.backend.prompt).toHaveBeenCalledTimes(2));
            await vi.waitFor(() => expect(h.session.sendSessionEvent).toHaveBeenCalledTimes(2));
            expect(h.agentState.requests?.[id]).toBeDefined();

            await h.answer({ id, approved: true, decision: 'approved' });
            expect(await result).toEqual({ content: [{ type: 'text', text: 'moved' }], isError: false });
            expect(action).toHaveBeenCalledTimes(1);
            h.close();
            await run;
        } finally {
            setAssistantRole(null);
        }
    });
});
