import type { AiDispatchParseResult } from "./parse.js";
import {
  buildPlateReadback,
  buildVinReadback,
  consumePendingPlateRequest,
  lookupVin,
  notePendingPlateRequest,
  runPlateLookup,
  type PlateLookupResult,
} from "./plateLookup.js";

export async function handlePlateFromParse(opts: {
  agencyId: number;
  unitId: string;
  parsed: AiDispatchParseResult;
}): Promise<{ lookup: PlateLookupResult | null; speakText: string | null }> {
  const { agencyId, unitId, parsed } = opts;
  const intent = parsed.intent;
  const pr = parsed.plate_request;

  if (intent === "info_request_912" || (intent === "plate_request" && pr && !pr.plate && !pr.vin)) {
    notePendingPlateRequest(agencyId, unitId);
    const ack = parsed.dispatcher_response?.trim() || `${unitId}, 913.`;
    return { lookup: null, speakText: ack };
  }

  // Run the plate any time the parse carried plate or VIN fields — this includes a 961
  // with the plate inline (intent="dispatch") as well as a standalone plate_request /
  // plate_transmit transmission.
  if (pr?.vin && /^[A-HJ-NPR-Z0-9]{17}$/.test(pr.vin)) {
    const lookup = await lookupVin(agencyId, pr.vin);
    return { lookup, speakText: buildVinReadback(unitId, lookup) };
  }
  if (pr?.plate) {
    const lookup = await runPlateLookup(agencyId, pr.plate, pr.state);
    return { lookup, speakText: buildPlateReadback(unitId, lookup) };
  }

  // Pending 912 with no plate yet: only consume the held window on a plate_* intent.
  if (intent === "plate_request" || intent === "plate_transmit") {
    if (consumePendingPlateRequest(agencyId, unitId)) {
      return { lookup: null, speakText: `${unitId}, 10-9 your full plate.` };
    }
  }

  return { lookup: null, speakText: null };
}
