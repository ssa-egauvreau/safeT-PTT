/**
 * Property / map / web addresses before ElevenLabs — numbers as words, states spelled out.
 */

import { spokenizeAddress } from "./addressSpeech.js";
import { expandUSStatesForSpeech } from "./stateSpeech.js";

export function prepareLocationForTts(location: string | null | undefined): string {
  if (!location?.trim()) {
    return location ?? "";
  }
  let out = expandUSStatesForSpeech(location.trim());
  out = spokenizeAddress(out);
  return out;
}
