import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgencyById } from "../../store.js";

const PROMPT_DIR = dirname(fileURLToPath(import.meta.url));
let cachedPrompt: string | null = null;

export function getSunsetSafetyBundledPrompt(): string {
  if (cachedPrompt) {
    return cachedPrompt;
  }
  const path = join(PROMPT_DIR, "sunsetSafetySystemPrompt.txt");
  try {
    cachedPrompt = readFileSync(path, "utf8");
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
    if (code === "ENOENT") {
      throw new Error(
        `${path} is missing. Run "npm run build" in the server folder so copy-server-assets copies the Sunset Safety prompt into dist.`,
        { cause: err },
      );
    }
    throw err;
  }
  return cachedPrompt;
}

/** Agencies that use the exported 10-8 Sunset Safety system prompt when Integrations prompt is empty. */
export async function agencyUsesSunsetSafetyBundledPrompt(agencyId: number): Promise<boolean> {
  const slugsFromEnv = process.env.AI_DISPATCH_SUNSET_AGENCY_SLUGS?.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const agency = await getAgencyById(agencyId);
  if (!agency) {
    return false;
  }
  if (slugsFromEnv?.length) {
    return slugsFromEnv.includes(agency.slug.toLowerCase());
  }
  return /sunset\s*safety/i.test(agency.name) || agency.slug.toLowerCase().includes("sunset");
}
