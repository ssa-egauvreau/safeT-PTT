import type { AdminUser, Channel, Permission } from "../../api";
import { ChannelPermissionList, type CellValue } from "./channelPermissionUi";
import { membershipKey } from "./userTemplateUtils";

export function ChannelPermissionsModal({
  user,
  channels,
  grid,
  onClose,
  onChange,
}: {
  user: AdminUser;
  channels: Channel[];
  grid: Map<string, Permission>;
  onClose: () => void;
  onChange: (channel: Channel, value: CellValue) => void | Promise<void>;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal channel-permissions-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="channel-permissions-title"
      >
        <div className="panel-head">
          <h2 id="channel-permissions-title">Channel permissions</h2>
          <button type="button" className="cp-close" onClick={onClose} title="Close">
            ✕
          </button>
        </div>
        <p className="panel-desc">
          <code className="mono">{user.username}</code>
          {user.display_name ? ` · ${user.display_name}` : ""}
        </p>

        <ChannelPermissionList
          channels={channels}
          valueForChannel={(channelId) => grid.get(membershipKey(user.id, channelId)) ?? "none"}
          onChange={onChange}
        />
      </div>
    </div>
  );
}
