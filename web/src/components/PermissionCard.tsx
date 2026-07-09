export interface Permission {
  permissionId: string;
  toolName: string;
  reason: string;
}

export function PermissionCard({
  permission,
  onResolve,
}: {
  permission: Permission;
  onResolve: (permissionId: string, approved: boolean) => void;
}) {
  return (
    <div className="permissioncard">
      <div className="permission-label">Permission required</div>
      <div className="permission-text">
        <code>{permission.toolName}</code>: {permission.reason}
      </div>
      <div className="permission-actions">
        <button
          className="approve"
          onClick={() => onResolve(permission.permissionId, true)}
        >
          Approve
        </button>
        <button
          className="deny"
          onClick={() => onResolve(permission.permissionId, false)}
        >
          Deny
        </button>
      </div>
      <div className="permission-hint">
        The original call was blocked. After approving, ask the agent to retry if
        you want it to proceed.
      </div>
    </div>
  );
}
