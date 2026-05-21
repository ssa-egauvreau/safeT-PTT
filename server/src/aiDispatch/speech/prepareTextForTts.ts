/**
 * ElevenLabs TTS preparation — ported from 10-8-alert-dashboard prepareTextForTTS().
 * Turns dispatcher text into phrasing radios expect: "913" → "nine thirteen",
 * "27-000" → "twenty seven thousand", "10-8" → "10 8", SSML pacing breaks.
 */

import { CALL_TYPE_SPOKEN, callTypeSpokenKeysByLength } from "./callTypeSpoken.js";

const COMMAND_STAFF_PRONUNCIATION: Record<string, string> = {
  "27-000": "twenty seven thousand",
  "27-010": "twenty seven zero ten",
  "27-020": "twenty seven zero twenty",
  "27-030": "zero thirty",
};

/** Radio / info codes — applied before call-type map. */
const SPELL_CODES: Record<string, string> = {
  "911": "nine eleven",
  "912": "nine twelve",
  "913": "nine thirteen",
  "415": "four fifteen",
  "459": "four fifty-nine",
  "484": "four eighty-four",
  "586": "five eighty-six",
  "925": "nine twenty-five",
  "940": "nine forty",
  "951": "nine fifty-one",
  "961": "nine sixty-one",
  "907A": "nine oh seven Alpha",
  "907B": "nine oh seven Bravo",
  "415A": "four fifteen Alpha",
  "415B": "four fifteen Bravo",
  "415E": "four fifteen Echo",
  "459A": "four fifty-nine Alpha",
  "459B": "four fifty-nine Bravo",
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceWordBounded(text: string, pattern: string, replacement: string, flags = "gi"): string {
  const re = new RegExp(`\\b${escapeRegExp(pattern)}\\b`, flags);
  return text.replace(re, replacement);
}

function expandAbbreviationsForSpeech(text: string): string {
  if (!text) {
    return text;
  }
  let out = text;

  for (const [id, spoken] of Object.entries(COMMAND_STAFF_PRONUNCIATION)) {
    out = replaceWordBounded(out, id, spoken, "g");
  }

  for (const [code, spoken] of Object.entries(SPELL_CODES)) {
    if (/[A-Z]$/i.test(code)) {
      out = replaceWordBounded(out, code, spoken, "gi");
    }
  }
  for (const [code, spoken] of Object.entries(SPELL_CODES)) {
    if (!/[A-Z]$/i.test(code)) {
      out = replaceWordBounded(out, code, spoken, "g");
    }
  }

  out = out.replace(/\b(NE|NW|SE|SW)\.?\s+(?=[A-Z])/g, (_m, d: string) => {
    const map: Record<string, string> = {
      NE: "Northeast",
      NW: "Northwest",
      SE: "Southeast",
      SW: "Southwest",
    };
    return `${map[d.toUpperCase()]} `;
  });
  out = out.replace(/\b([NSEW])\.?\s+(?=[A-Z])/g, (_m, d: string) => {
    const map: Record<string, string> = { N: "North", S: "South", E: "East", W: "West" };
    return `${map[d.toUpperCase()]} `;
  });

  const streetTypes: Array<[RegExp, string]> = [
    [/\bSt\.(?=\s|$|,)/g, "Street"],
    [/\bSt(?=\s|$|,)/g, "Street"],
    [/\bAve\.?(?=\s|$|,)/gi, "Avenue"],
    [/\bBlvd\.?(?=\s|$|,)/gi, "Boulevard"],
    [/\bRd\.?(?=\s|$|,)/gi, "Road"],
    [/\bDr\.?(?=\s|$|,)/gi, "Drive"],
    [/\bLn\.?(?=\s|$|,)/gi, "Lane"],
    [/\bCt\.?(?=\s|$|,)/gi, "Court"],
    [/\bPl\.?(?=\s|$|,)/gi, "Place"],
    [/\bPkwy\.?(?=\s|$|,)/gi, "Parkway"],
    [/\bHwy\.?(?=\s|$|,)/gi, "Highway"],
    [/\bTer\.?(?=\s|$|,)/gi, "Terrace"],
    [/\bCir\.?(?=\s|$|,)/gi, "Circle"],
    [/\bApt\.?(?=\s|$|,)/gi, "Apartment"],
    [/\bSte\.?(?=\s|$|,)/gi, "Suite"],
    [/\bBldg\.?(?=\s|$|,)/gi, "Building"],
  ];
  for (const [re, sub] of streetTypes) {
    out = out.replace(re, sub);
  }

  return out;
}

function expandCallTypesForSpeech(text: string): string {
  let out = text;
  for (const code of callTypeSpokenKeysByLength()) {
    const spoken = CALL_TYPE_SPOKEN[code];
    if (!spoken) {
      continue;
    }
    out = replaceWordBounded(out, code, spoken, "gi");
  }
  return out;
}

/** Digit-hyphen-digit → spaces so TTS reads "10 8" not "ten dash eight". */
function despaceHyphensInCodes(text: string): string {
  if (!text) {
    return text;
  }
  let out = text;
  out = out.replace(/(\d)-(\d)/g, "$1 $2");
  out = out.replace(/(\d)-([A-Za-z])\b/g, "$1 $2");
  return out;
}

function addSpeechPacing(text: string): string {
  if (!text || /<break\s/i.test(text)) {
    return text;
  }
  let out = text;
  out = out.replace(/([.?!])(\s+|$)/g, '$1<break time="0.45s" />$2');
  out = out.replace(/([;:])(\s+|$)/g, '$1<break time="0.35s" />$2');
  out = out.replace(/,(\s+|$)/g, ',<break time="0.30s" />$1');
  out = out.replace(/(<break\s[^>]*>)\s*\1/g, "$1");
  return out;
}

/** Full pipeline before ElevenLabs (matches legacy 10-8 dispatcher server). */
export function prepareTextForTts(text: string): string {
  let out = expandAbbreviationsForSpeech(text);
  out = expandCallTypesForSpeech(out);
  out = despaceHyphensInCodes(out);
  out = addSpeechPacing(out);
  return out;
}
