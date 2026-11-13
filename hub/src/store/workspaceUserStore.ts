import type { Database } from 'bun:sqlite'

import type { StoredWorkspaceUser } from './types'
import {
    createWorkspaceUser,
    deleteWorkspaceUser,
    getWorkspaceUser,
    listWorkspaceUsers,
    updateWorkspaceUser
} from './workspaceUsers'

export class WorkspaceUserStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    list(namespace: string): StoredWorkspaceUser[] {
        return listWorkspaceUsers(this.db, namespace)
    }

    get(id: string, namespace: string): StoredWorkspaceUser | null {
        return getWorkspaceUser(this.db, id, namespace)
    }

    create(input: { namespace: string; name: string; paths: readonly string[] }): StoredWorkspaceUser {
        return createWorkspaceUser(this.db, input)
    }

    update(
        id: string,
        namespace: string,
        patch: { name?: string; paths?: readonly string[] }
    ): StoredWorkspaceUser | null {
        return updateWorkspaceUser(this.db, id, namespace, patch)
    }

    delete(id: string, namespace: string): boolean {
        return deleteWorkspaceUser(this.db, id, namespace)
    }
}
