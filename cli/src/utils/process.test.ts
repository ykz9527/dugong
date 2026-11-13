import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isHapiRunnerProcess, isProcessAlive } from './process';

describe('isHapiRunnerProcess', () => {
    // After a reboot a stale runner PID can be reused as a thread ID.
    // kill(tid, 0) succeeds, but it is not a runner process.
    it.runIf(process.platform === 'linux')('rejects a thread ID that is not a process', () => {
        const threadId = readdirSync(`/proc/${process.pid}/task`)
            .map(Number)
            .find((tid) => tid !== process.pid);
        if (threadId === undefined) return;

        expect(isProcessAlive(threadId)).toBe(true);
        expect(isHapiRunnerProcess(threadId)).toBe(false);
    });
});
