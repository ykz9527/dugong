import React from 'react';
import { logger } from '@/ui/logger';
import { convertAgentMessage } from '@/agent/messageConverter';
import type { AgentMessage, PromptContent } from '@/agent/types';
import type { AcpSdkBackend } from '@/agent/backends/acp';
import { createNativeSessionTitleMetadataSync } from '@/agent/nativeSessionTitle';
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from '@/modules/common/remote/RemoteLauncherBase';
import { AcpPermissionHandler } from '@/modules/common/permission/AcpPermissionHandler';
import { RemoteModeDisplay } from '@/ui/ink/RemoteModeDisplay';
import type { AgySession } from './session';
import type { AgyMode } from './types';
import { createAgyBackend } from './utils/agyBackend';
import { readAgyConversationTitle } from './utils/agySessionTitle';

export type AgyRemoteLauncherOptions = {
    /** Injectable for tests; production spawns `agy acp`. */
    createBackend?: () => AcpSdkBackend;
    readTitle?: (conversationId: string) => Promise<string | null>;
};

/**
 * agy over ACP. One long-lived `agy acp` process per HAPI session; each queued
 * batch is a `session/prompt`. Tool approvals arrive as
 * `session/request_permission` and go through the shared ACP permission bridge,
 * so request-review behaves like the default mode of other ACP agents, and
 * always-proceed is auto-approved on the HAPI side (switchable mid-session).
 *
 * The ACP session id is agy's conversation id, so sessions created by the old
 * headless transport (`agy -p --conversation <id>`) resume via `session/load`.
 */
export class AgyRemoteLauncher extends RemoteLauncherBase {
    private readonly session: AgySession;
    private readonly createBackend: () => AcpSdkBackend;
    private readonly readTitle: (conversationId: string) => Promise<string | null>;
    private readonly syncNativeTitle: (title: unknown) => void;
    private backend: AcpSdkBackend | null = null;
    private permissionHandler: AcpPermissionHandler | null = null;
    private abortController = new AbortController();
    private acpSessionId: string | null = null;
    private currentModel: string | null = null;
    private currentEffort: string | null = null;

    constructor(session: AgySession, opts: AgyRemoteLauncherOptions = {}) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
        this.createBackend = opts.createBackend ?? createAgyBackend;
        this.readTitle = opts.readTitle ?? readAgyConversationTitle;
        this.syncNativeTitle = createNativeSessionTitleMetadataSync(session.client);
    }

    async launch(): Promise<RemoteLauncherExitReason> {
        // agy is remote-only: no local mode, so no switch action.
        return this.start({ onExit: () => this.handleExitFromUi() });
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(RemoteModeDisplay, context);
    }

    protected getCurrentSessionId(): string | null {
        return this.acpSessionId;
    }

    protected async runMainLoop(): Promise<void> {
        const session = this.session;
        const backend = this.createBackend();
        this.backend = backend;
        session.setKillHandler(() => this.handleAbort());

        backend.onStderrError((error) => {
            logger.debug('[agy-acp] stderr error', error);
            session.sendSessionEvent({ type: 'message', message: error.message });
            this.messageBuffer.addMessage(error.message, 'status');
        });

        await backend.initialize();
        const acpSessionId = await this.openSession(backend);
        this.acpSessionId = acpSessionId;
        session.onSessionFound(acpSessionId);
        this.currentModel = backend.getConfigOptionByCategory(acpSessionId, 'model')?.currentValue
            ?? backend.getSessionModelsMetadata(acpSessionId)?.currentModelId
            ?? null;
        this.currentEffort = backend.getThoughtLevelConfigOption(acpSessionId)?.currentValue ?? null;

        this.permissionHandler = new AcpPermissionHandler(
            session.client,
            backend,
            () => session.getPermissionMode()
        );
        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            onSwitch: () => {}
        });

        while (!this.shouldExit) {
            const batch = await session.queue.waitForMessagesAndGetAsString(this.abortController.signal);
            if (!batch) {
                if (this.abortController.signal.aborted && !this.shouldExit) continue;
                break;
            }

            await this.applyMode(backend, acpSessionId, batch.mode);
            this.messageBuffer.addMessage(batch.message, 'user');
            session.onThinkingChange(true);
            const prompt: PromptContent[] = [{ type: 'text', text: batch.message }];
            try {
                await backend.prompt(acpSessionId, prompt, (message) => this.handleAgentMessage(message));
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger.warn('[agy-acp] prompt failed', { message });
                session.sendSessionEvent({ type: 'message', message: `agy prompt failed: ${message}` });
                this.messageBuffer.addMessage(`agy prompt failed: ${message}`, 'status');
            } finally {
                session.onThinkingChange(false);
                await this.permissionHandler?.cancelAll('Prompt finished');
                void this.syncTitle(acpSessionId);
                if (session.queue.size() === 0 && !this.shouldExit) {
                    session.sendSessionEvent({ type: 'ready' });
                }
            }
        }
    }

    private async openSession(backend: AcpSdkBackend): Promise<string> {
        const config = { cwd: this.session.path, mcpServers: [] };
        const resumeId = this.session.sessionId;
        if (!resumeId) return backend.newSession(config);
        try {
            return await backend.loadSession({ ...config, sessionId: resumeId });
        } catch (error) {
            logger.warn('[agy-acp] resume failed, starting a new conversation', error);
            this.session.sendSessionEvent({
                type: 'message',
                message: 'agy could not resume this conversation; starting a new one.'
            });
            return backend.newSession(config);
        }
    }

    /** Apply the model/effort snapshotted when the batch was queued. */
    private async applyMode(backend: AcpSdkBackend, sessionId: string, mode: AgyMode): Promise<void> {
        const model = typeof mode.model === 'string' && mode.model ? mode.model : null;
        if (model && model !== this.currentModel) {
            try {
                await backend.setModel(sessionId, model);
                this.currentModel = model;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger.warn('[agy-acp] set_model failed', error);
                this.session.sendSessionEvent({
                    type: 'message',
                    message: `Failed to switch model to ${model}: ${message}. Continuing with ${this.currentModel ?? 'the agy default'}.`
                });
            }
        }
        const effort = typeof mode.effort === 'string' && mode.effort ? mode.effort : null;
        const effortOption = backend.getThoughtLevelConfigOption(sessionId);
        if (effort && effortOption && effort !== this.currentEffort
            && effortOption.options.some((option) => option.value === effort)) {
            try {
                await backend.setConfigOption(sessionId, effortOption.id, effort);
                this.currentEffort = effort;
            } catch (error) {
                logger.warn('[agy-acp] thought level switch failed', error);
            }
        }
    }

    private async syncTitle(conversationId: string): Promise<void> {
        try {
            this.syncNativeTitle(await this.readTitle(conversationId));
        } catch {
            // Best-effort: the summaries DB may not have the row yet.
        }
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager);
        await this.permissionHandler?.cancelAll('Session ended');
        this.permissionHandler = null;
        await this.backend?.disconnect();
        this.backend = null;
    }

    private handleAgentMessage(message: AgentMessage): void {
        const converted = convertAgentMessage(message, this.currentModel);
        if (converted) this.session.sendAgentMessage(converted);

        switch (message.type) {
            case 'text':
                this.messageBuffer.addMessage(message.text, 'assistant');
                break;
            case 'tool_call':
                this.messageBuffer.addMessage(`Tool call: ${message.name}`, 'tool');
                break;
            case 'error':
                this.messageBuffer.addMessage(message.message, 'status');
                break;
            case 'turn_complete':
                this.messageBuffer.addMessage('Turn complete', 'status');
                break;
            case 'generated_image':
            case 'usage':
            case 'reasoning':
            case 'tool_result':
            case 'plan':
                break;
            default: {
                const _exhaustive: never = message;
                return _exhaustive;
            }
        }
    }

    private async handleAbort(): Promise<void> {
        if (this.backend && this.acpSessionId) {
            await this.backend.cancelPrompt(this.acpSessionId);
        }
        await this.permissionHandler?.cancelAll('User aborted');
        this.session.sendSessionEvent({ type: 'message', message: 'Turn aborted' });
        this.session.queue.reset();
        this.session.onThinkingChange(false);
        this.abortController.abort();
        this.abortController = new AbortController();
        this.messageBuffer.addMessage('Turn aborted', 'status');
    }

    private async handleExitFromUi(): Promise<void> {
        await this.requestExit('exit', () => this.handleAbort());
    }
}

export async function agyRemoteLauncher(session: AgySession): Promise<'switch' | 'exit'> {
    return new AgyRemoteLauncher(session).launch();
}
