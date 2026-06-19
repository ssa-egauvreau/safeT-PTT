import type { AiDispatchParseResult } from "./parse.js";
import { ten8Configured } from "../ten8/client.js";
import { fetchCadPlateLookup } from "../ten8/cadRadioLookup.js";
import {
  buildPlateCombinedReadback,
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
}): Promise<{
  lookup: PlateLookupResult | null;
  speakText: string | null;
  followUpSpeak: string | null;
}> {
  const { agencyId, unitId, parsed } = opts;
  const intent = parsed.intent;
  const pr = parsed.plate_request;

  if (intent === "info_request_912" || (intent === "plate_request" && pr && !pr.plate && !pr.vin)) {
    notePendingPlateRequest(agencyId, unitId);
    const ack = parsed.dispatcher_response?.trim() || `${unitId}, 913.`;
    return { lookup: null, speakText: ack, followUpSpeak: null };
  }

  if (pr?.vin && /^[A-HJ-NPR-Z0-9]{17}$/.test(pr.vin)) {
    const lookup = await lookupVin(agencyId, pr.vin);
    return { lookup, speakText: buildVinReadback(unitId, lookup), followUpSpeak: null };
  }

  if (pr?.plate) {
    const plate = pr.plate;
    const state = pr.state;
    const normalized = plate.trim().toUpperCase();
    if (!/^[A-Z0-9]{2,8}$/.test(normalized)) {
      const lookup = await runPlateLookup(agencyId, plate, state);
      return {
        lookup,
        speakText: buildPlateReadback(unitId, lookup),
        followUpSpeak: null,
      };
    }
    let cadEnabled = false;
    try {
      cadEnabled = await ten8Configured(agencyId);
    } catch {
      cadEnabled = false;
    }
    const cadPromise = cadEnabled
      ? fetchCadPlateLookup(agencyId, plate, state)
      : Promise.resolve({
          found: false,
          vehicleSummary: null,
          stateOnFile: null,
          historyLine: null,
        });
    const dmvPromise = runPlateLookup(agencyId, plate, state);
    const [cad, lookup] = await Promise.all([cadPromise, dmvPromise]);
    // Speak the 10-8 lead and the DMV/VIN tail as ONE fluid transmission, not two.
    const speakText = buildPlateCombinedReadback(unitId, plate, state, cad, lookup);
    return { lookup, speakText, followUpSpeak: null };
  }

  if (intent === "plate_request" || intent === "plate_transmit") {
    if (consumePendingPlateRequest(agencyId, unitId)) {
      return { lookup: null, speakText: `${unitId}, 10-9 your full plate.`, followUpSpeak: null };
    }
  }

  return { lookup: null, speakText: null, followUpSpeak: null };
}
