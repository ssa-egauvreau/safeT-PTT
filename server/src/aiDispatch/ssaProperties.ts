import ssaPropertiesJson from "./data/ssaProperties.json" with { type: "json" };

export type SsaPropertyRecord = {
  name: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  locnotes: string;
};

const SSA_PROPERTIES = ssaPropertiesJson as Record<string, SsaPropertyRecord>;

export function lookupSsaProperty(code: string | null | undefined): SsaPropertyRecord | null {
  if (code == null) {
    return null;
  }
  const key = String(code).trim();
  if (!key) {
    return null;
  }
  if (SSA_PROPERTIES[key]) {
    return SSA_PROPERTIES[key]!;
  }
  const stripped = key.replace(/^0+/, "");
  if (stripped !== key && SSA_PROPERTIES[stripped]) {
    return SSA_PROPERTIES[stripped]!;
  }
  return null;
}
