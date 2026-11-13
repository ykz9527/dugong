import type { CodexPermissionMode } from '@hapi/protocol/types';
import type { ApprovalPolicyPreset, ApprovalsReviewer, SandboxMode, SandboxPolicy } from '../appServerTypes';

export type CodexPermissionModeConfig = {
    approvalPolicy: ApprovalPolicyPreset;
    sandbox: SandboxMode;
    sandboxPolicy: SandboxPolicy;
    /**
     * Who reviews an escalation. Sent with every mode, not only `auto`: Codex
     * keeps it on the thread, so leaving it out after `auto` would keep the
     * reviewer on in a session the operator switched back to `default`.
     */
    approvalsReviewer: ApprovalsReviewer;
};

export function resolveCodexPermissionModeConfig(mode: CodexPermissionMode): CodexPermissionModeConfig {
    switch (mode) {
        case 'default':
            return {
                // Remote Codex sessions rely on HAPI's approval UI for sandbox escalation.
                // `on-request` keeps workspace-write sandboxing while still surfacing a
                // user-approvable elevation request when the model needs it.
                approvalPolicy: 'on-request',
                sandbox: 'workspace-write',
                sandboxPolicy: { type: 'workspaceWrite' },
                approvalsReviewer: 'user'
            };
        case 'auto':
            return {
                // Codex's Auto Review: escalations go to a reviewer subagent that
                // approves or denies by risk, instead of to the operator.
                approvalPolicy: 'on-request',
                sandbox: 'workspace-write',
                sandboxPolicy: { type: 'workspaceWrite' },
                approvalsReviewer: 'auto_review'
            };
        case 'read-only':
            return {
                approvalPolicy: 'never',
                sandbox: 'read-only',
                sandboxPolicy: { type: 'readOnly' },
                approvalsReviewer: 'user'
            };
        case 'safe-yolo':
            return {
                // Current Codex versions reject the removed `on-failure` policy. Keep
                // escalation available through `on-request`; HAPI auto-approves these
                // requests in safe-yolo mode.
                approvalPolicy: 'on-request',
                sandbox: 'workspace-write',
                sandboxPolicy: { type: 'workspaceWrite' },
                approvalsReviewer: 'user'
            };
        case 'yolo':
            return {
                approvalPolicy: 'never',
                sandbox: 'danger-full-access',
                sandboxPolicy: { type: 'dangerFullAccess' },
                approvalsReviewer: 'user'
            };
    }

    const unexpectedMode: never = mode;
    throw new Error(`Unknown permission mode: ${unexpectedMode}`);
}

export function buildCodexPermissionModeCliArgs(mode: Exclude<CodexPermissionMode, 'default'>): string[] {
    const config = resolveCodexPermissionModeConfig(mode);
    return [
        '--ask-for-approval', config.approvalPolicy,
        '--sandbox', config.sandbox,
        ...(config.approvalsReviewer === 'auto_review' ? ['-c', 'approvals_reviewer="auto_review"'] : [])
    ];
}
