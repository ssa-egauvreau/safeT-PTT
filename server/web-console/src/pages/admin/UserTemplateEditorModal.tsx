import { useMemo, useState } from "react";
import type { Channel, UserPermissionTemplate } from "../../api";
import { ChannelPermissionList, type CellValue } from "./channelPermissionUi";
import { templateValueMap } from "./userTemplateUtils";

export function UserTemplateEditorModal({
  template,
  channels,
  onClose,
  onSave,
}: {
  template: UserPermissionTemplate | null;
  channels: Channel[];
  onClose: () => void;
  onSave: (name: string, memberships: Map<number, CellValue>) => void | Promise<void>;
}) {
  const [name, setName] = useState(template?.name ?? "");
  const [values, setValues] = useState<Map<number, CellValue>>(() =>
    template ? templateValueMap(template) : new Map(),
  );
  const [saving, setSaving] = useState(false);

  const title = useMemo(() => (template ? "Edit user template" : "New user template"), [template]);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    setSaving(true);
    try {
      await onSave(trimmed, values);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal channel-permissions-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="user-template-editor-title"
      >
        <div className="panel-head">
          <h2 id="user-template-editor-title">{title}</h2>
          <button type="button" className="cp-close" onClick={onClose} title="Close">
            ✕
          </button>
        </div>
        <p className="panel-desc">
          Pick which channels this template enables and what permission each one gets. Apply it when
          creating a user or from any user&apos;s row.
        </p>

        <div className="field">
          <label>Template name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Patrol officer"
            required
          />
        </div>

        <ChannelPermissionList
          channels={channels}
          valueForChannel={(channelId) => values.get(channelId) ?? "none"}
          onChange={(channel, value) => {
            setValues((prev) => {
              const next = new Map(prev);
              if (value === "none") {
                next.delete(channel.id);
              } else {
                next.set(channel.id, value);
              }
              return next;
            });
          }}
        />

        <div className="modal-actions">
          <button type="button" className="btn sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={saving || !name.trim()}
            onClick={() => void submit()}
          >
            {saving ? "Saving…" : "Save template"}
          </button>
        </div>
      </div>
    </div>
  );
}
