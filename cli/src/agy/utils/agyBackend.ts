import { AcpSdkBackend } from '@/agent/backends/acp';

/**
 * Spawn env for `agy acp`. GEMINI_FORCE_FILE_STORAGE makes agy read the saved
 * OAuth file token instead of the keyring (same hardening as the `agy models`
 * probe). Only the SSH session markers are dropped, so agy does not switch to
 * its SSH auth path; SSH_AUTH_SOCK stays for tools such as git.
 */
export function buildAgyAcpEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const result: Record<string, string> = { GEMINI_FORCE_FILE_STORAGE: 'true' };
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) continue;
        if (key === 'SSH_CLIENT' || key === 'SSH_CONNECTION' || key === 'SSH_TTY') continue;
        result[key] = value;
    }
    result.GEMINI_FORCE_FILE_STORAGE = 'true';
    return result;
}

/**
 * agy over ACP (`agy acp`). Unlike headless `agy -p`, which denies every tool
 * call that has no allow-rule, ACP sends `session/request_permission` and waits,
 * so request-review sessions get the same approval cards as other ACP agents.
 */
export function createAgyBackend(): AcpSdkBackend {
    return new AcpSdkBackend({
        command: 'agy',
        args: ['acp'],
        env: buildAgyAcpEnv(),
        flavor: 'agy'
    });
}
