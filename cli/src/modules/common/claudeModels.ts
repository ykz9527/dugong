import { homedir } from 'node:os';
import type { ClaudeModelSummary } from '@hapi/protocol/apiTypes';
import { query } from '@/claude/sdk';
import { getErrorMessage } from './rpcResponses';

function asNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function normalizeClaudeModel(entry: unknown): ClaudeModelSummary | null {
    if (!entry || typeof entry !== 'object') return null;
    const record = entry as Record<string, unknown>;
    const value = asNonEmptyString(record.value);
    if (!value) return null;
    return {
        value,
        resolvedModel: asNonEmptyString(record.resolvedModel),
        displayName: asNonEmptyString(record.displayName) ?? value
    };
}

interface CacheEntry {
    expiresAt: number;
    models: ClaudeModelSummary[];
}

// Asking costs a Claude Code start (about 4 s, no API call). The list only
// changes with a Claude Code update or a settings edit, so keep it 5 minutes
// (as the Codex list) and fold concurrent asks into one start.
const CACHE_TTL_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 30_000;
let cache: CacheEntry | null = null;
let inflight: Promise<ClaudeModelSummary[]> | null = null;

export async function listClaudeModels(
    probe: () => Promise<unknown[]> = probeClaudeModels
): Promise<ClaudeModelSummary[]> {
    if (cache && cache.expiresAt > Date.now()) return cache.models;
    // Past its 5 minutes, the old list still answers at once while a fresh one loads.
    if (cache) {
        if (!inflight) void refresh(probe).catch(() => undefined);
        return cache.models;
    }
    return inflight ?? refresh(probe);
}

function refresh(probe: () => Promise<unknown[]>): Promise<ClaudeModelSummary[]> {
    inflight = probe()
        .then((entries) => {
            const models = entries
                .map(normalizeClaudeModel)
                .filter((model): model is ClaudeModelSummary => model !== null);
            if (models.length > 0) cache = { expiresAt: Date.now() + CACHE_TTL_MS, models };
            return models;
        })
        .finally(() => {
            inflight = null;
        });
    return inflight;
}

async function probeClaudeModels(): Promise<unknown[]> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
    // A prompt stream that never sends: the process only answers `initialize`.
    const idle: AsyncIterable<never> = {
        async *[Symbol.asyncIterator]() {
            await new Promise<void>((resolve) => abort.signal.addEventListener('abort', () => resolve(), { once: true }));
        }
    };
    try {
        // The machine's list, not a project's: home has no project settings.
        // --no-session-persistence: the probe must not leave a session in ~/.claude/projects.
        const claude = query({
            prompt: idle,
            options: { cwd: homedir(), abort: abort.signal, additionalArgs: ['--no-session-persistence'] }
        });
        return await Promise.race([
            claude.supportedModels(),
            new Promise<never>((_, reject) => abort.signal.addEventListener(
                'abort',
                () => reject(new Error('Claude Code did not list its models in time')),
                { once: true }
            ))
        ]);
    } catch (error) {
        throw new Error(getErrorMessage(error, 'Failed to list Claude models'));
    } finally {
        clearTimeout(timer);
        abort.abort();
    }
}

/** Clear the in-process cache and any in-flight probe. Exposed for tests. */
export function _resetClaudeModelsCacheForTests(): void {
    cache = null;
    inflight = null;
}
