/**
 * Unified MCP bridge setup for Codex local and remote modes.
 *
 * This module provides a single source of truth for starting the hapi MCP
 * bridge server and generating the MCP server configuration that Codex needs.
 */

import { startHappyServer } from '@/claude/utils/startHappyServer';
import { getHappyCliCommand } from '@/utils/spawnHappyCLI';
import type { ApiSessionClient } from '@/api/apiSession';
import { exportHapiSessionEnv } from '@/agent/hapiSessionEnv';
import { ASSISTANT_CONFIRM_TOOLS } from '@hapi/protocol';
import { ASSISTANT_TOOL_NAMES } from '@/claude/utils/assistantTools';

/**
 * MCP server entry configuration.
 */
export type McpToolApprovalMode = 'auto' | 'prompt' | 'approve';

export interface McpServerToolConfig {
    approval_mode?: McpToolApprovalMode;
}

export interface McpServerEntry {
    command: string;
    args: string[];
    tools?: Record<string, McpServerToolConfig>;
}

/**
 * Map of MCP server names to their configurations.
 */
export type McpServersConfig = Record<string, McpServerEntry>;

/**
 * Result of starting the hapi MCP bridge.
 */
export interface HapiMcpBridge {
    /** The running server instance */
    server: {
        url: string;
        stop: () => void;
    };
    /** MCP server config to pass to Codex (works for both CLI and SDK) */
    mcpServers: McpServersConfig;
}

export interface HapiMcpBridgeOptions {
    emitTitleSummary?: boolean;
    enableChangeTitle?: boolean;
    skillLookup?: {
        workingDirectory: string;
        flavor: string;
    };
    /** Register the task assistant's memory and task tools. */
    assistant?: boolean;
}

/**
 * Start the hapi MCP bridge server and return the configuration
 * needed to connect Codex to it.
 *
 * This is the single source of truth for MCP bridge setup,
 * used by both local and remote launchers.
 *
 * Lazy Codex sessions stay pending until first materialization. We materialize
 * here (before startHappyServer / agent spawn) so:
 * - the hub row exists for REST self-targeting via DUGONG_SESSION_ID
 * - hapiMcpUrl from startHappyServer is persisted to the hub, not only local pending state
 */
export async function buildHapiMcpBridge(
    client: ApiSessionClient,
    options: HapiMcpBridgeOptions = {}
): Promise<HapiMcpBridge> {
    if (client.isPending()) {
        const materialized = await client.materialize();
        if (!materialized) {
            throw new Error(`Failed to materialize HAPI session ${client.sessionId} before MCP bridge start`);
        }
    }
    // Belt-and-suspenders: onMaterialized already exports; keep env set for non-lazy too.
    exportHapiSessionEnv(client.sessionId);

    const happyServer = await startHappyServer(client, {
        emitTitleSummary: options.emitTitleSummary,
        enableChangeTitle: options.enableChangeTitle,
        skillLookup: options.skillLookup,
        assistant: options.assistant
    });
    const bridgeCommand = getHappyCliCommand([
        'mcp',
        '--url',
        happyServer.url,
        '--tools',
        happyServer.toolNames.join(',')
    ]);
    const tools: Record<string, McpServerToolConfig> = {
        // Showing the user an image is output, not an action; Claude never
        // asks for it either. Video and generic files still ask.
        display_image: {
            approval_mode: 'approve'
        },
        display_video: {
            approval_mode: 'prompt'
        },
        display_media: {
            approval_mode: 'prompt'
        }
    };
    if (options.enableChangeTitle !== false) {
        tools.change_title = {
            approval_mode: 'approve'
        };
    }
    // Discovery shortlist only - same trust as skill_lookup / change_title.
    tools.list_peers = {
        approval_mode: 'approve'
    };
    // ping_peer / inspect_peer are registered on the HTTP MCP server / stdio
    // bridge, but are not auto-approved: they target another session (resume +
    // inject, or read peer histories).
    if (options.skillLookup) {
        tools.skill_lookup = {
            approval_mode: 'approve'
        };
    }
    // Task assistant: looking at the person's own sessions is its job;
    // anything that acts on other work asks (or rides a standing grant).
    if (options.assistant) {
        const confirm = new Set<string>(ASSISTANT_CONFIRM_TOOLS);
        for (const name of [...ASSISTANT_TOOL_NAMES, 'inspect_peer', 'ping_peer']) {
            tools[name] = { approval_mode: confirm.has(name) ? 'prompt' : 'approve' };
        }
    }

    return {
        server: {
            url: happyServer.url,
            stop: happyServer.stop
        },
        mcpServers: {
            hapi: {
                command: bridgeCommand.command,
                args: bridgeCommand.args,
                tools
            }
        }
    };
}
