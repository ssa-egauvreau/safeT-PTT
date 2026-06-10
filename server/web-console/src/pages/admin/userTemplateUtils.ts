import type { Permission, TemplateMembership, UserPermissionTemplate } from "../../api";
import type { CellValue } from "./channelPermissionUi";

export function membershipKey(userId: number, channelId: number): string {
  return `${userId}:${channelId}`;
}

export function membershipsFromGrid(
  userId: number,
  grid: Map<string, Permission>,
): TemplateMembership[] {
  const out: TemplateMembership[] = [];
  grid.forEach((permission, key) => {
    const [uid, cid] = key.split(":");
    if (Number(uid) !== userId) {
      return;
    }
    const channelId = Number(cid);
    if (Number.isFinite(channelId)) {
      out.push({ channel_id: channelId, permission });
    }
  });
  return out.sort((a, b) => a.channel_id - b.channel_id);
}

export function membershipsToApi(
  memberships: TemplateMembership[],
): { channelId: number; permission: Permission }[] {
  return memberships.map((m) => ({ channelId: m.channel_id, permission: m.permission }));
}

export function templateValueMap(template: UserPermissionTemplate): Map<number, CellValue> {
  const map = new Map<number, CellValue>();
  for (const row of template.memberships) {
    map.set(row.channel_id, row.permission);
  }
  return map;
}

export function templateMembershipsFromMap(map: Map<number, CellValue>): TemplateMembership[] {
  const out: TemplateMembership[] = [];
  map.forEach((value, channelId) => {
    if (value !== "none") {
      out.push({ channel_id: channelId, permission: value });
    }
  });
  return out.sort((a, b) => a.channel_id - b.channel_id);
}
