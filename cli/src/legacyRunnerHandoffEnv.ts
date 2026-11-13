// A runner started by a pre-rename (HAPI_*) binary restarts itself into this
// one through the heartbeat handoff, and the replacement inherits the old
// runner's environment: HAPI_RUNNER_HANDOFF_FROM_PID plus the HAPI_* settings
// the old runner was configured with. Translate exactly those, and only for
// that handoff child; otherwise dugong started inside an upstream HAPI agent
// session (HAPI_SESSION_ID, HAPI_API_URL) or with HAPI_HOME exported would
// target the other hub and share its home and runner lock.
// Remove once no deployed runner predates the rename.
const LEGACY_HANDOFF_MARKER = 'HAPI_RUNNER_HANDOFF_FROM_PID';

const RUNNER_SETTINGS = [
    'RUNNER_HANDOFF_FROM_PID',
    'HOME',
    'API_URL',
    'EXTRA_HEADERS_JSON',
    'CLAUDE_PATH',
    'HOSTNAME',
    'EXPERIMENTAL',
] as const;

export function bridgeLegacyRunnerHandoffEnv(env: NodeJS.ProcessEnv = process.env): void {
    if (!env[LEGACY_HANDOFF_MARKER]) return;
    for (const name of RUNNER_SETTINGS) {
        const legacy = `HAPI_${name}`;
        const value = env[legacy];
        if (value === undefined) continue;
        const renamed = `DUGONG_${name}`;
        if (env[renamed] === undefined) {
            env[renamed] = value;
        }
        // Sessions this runner spawns inherit the DUGONG_ copies; drop the
        // originals so they don't re-trigger the bridge further down.
        delete env[legacy];
    }
}
