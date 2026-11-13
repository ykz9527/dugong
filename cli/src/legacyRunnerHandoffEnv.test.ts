import { describe, expect, it } from 'vitest';
import { bridgeLegacyRunnerHandoffEnv } from './legacyRunnerHandoffEnv';

describe('bridgeLegacyRunnerHandoffEnv', () => {
    it('ignores HAPI_* variables when no legacy runner handoff is in progress', () => {
        const env: NodeJS.ProcessEnv = {
            HAPI_SESSION_ID: 'upstream-session',
            HAPI_API_URL: 'http://upstream:3006',
            HAPI_HOME: '/home/u/.hapi',
        };
        bridgeLegacyRunnerHandoffEnv(env);
        expect(env.DUGONG_SESSION_ID).toBeUndefined();
        expect(env.DUGONG_API_URL).toBeUndefined();
        expect(env.DUGONG_HOME).toBeUndefined();
        expect(env.HAPI_API_URL).toBe('http://upstream:3006');
    });

    it('carries only the runner settings over for a handoff from a pre-rename runner', () => {
        const env: NodeJS.ProcessEnv = {
            HAPI_RUNNER_HANDOFF_FROM_PID: '1234',
            HAPI_API_URL: 'http://hub:3006',
            HAPI_HOME: '/srv/dugong',
            HAPI_SESSION_ID: 'not-a-runner-setting',
            DUGONG_CLAUDE_PATH: '/explicit/claude',
            HAPI_CLAUDE_PATH: '/legacy/claude',
        };
        bridgeLegacyRunnerHandoffEnv(env);
        expect(env.DUGONG_RUNNER_HANDOFF_FROM_PID).toBe('1234');
        expect(env.DUGONG_API_URL).toBe('http://hub:3006');
        expect(env.DUGONG_HOME).toBe('/srv/dugong');
        expect(env.DUGONG_CLAUDE_PATH).toBe('/explicit/claude');
        expect(env.DUGONG_SESSION_ID).toBeUndefined();
        expect(env.HAPI_RUNNER_HANDOFF_FROM_PID).toBeUndefined();
        expect(env.HAPI_API_URL).toBeUndefined();
    });
});
