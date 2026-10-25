export interface BaleWorkspaceBindingIdentity {
    cwd: string;
    workspaceKey: string;
    /** Exact durable Pi session identity; absent only on legacy cwd-only bindings. */
    sessionId?: string;
    /** Full SHA-256 index component for session-qualified bindings. */
    sessionKey?: string;
    /** Immutable legacy binding-key component, not the displayed global letter. */
    instanceSlot: string;
    bindingKey: string;
    /** Profile-wide letter reserved by the transient claim. */
    slot?: string;
}
export declare const BALE_WORKSPACE_KEY_MAX_LENGTH = 180;
export declare function normalizeBaleSessionId(sessionId: string): string | undefined;
export declare function createBaleSessionKey(sessionId: string): string | undefined;
export declare function normalizeBaleWorkspacePath(cwd: string): string | undefined;
export declare function createBaleWorkspaceDirectoryKey(cwd: string): string | undefined;
export declare function createBaleWorkspaceBindingIdentityWithKey(cwd: string, workspaceKey: string, ordinal: number, sessionId?: string): BaleWorkspaceBindingIdentity | undefined;
export declare function createBaleWorkspaceBindingIdentity(cwd: string, ordinal?: number, sessionId?: string): BaleWorkspaceBindingIdentity | undefined;
