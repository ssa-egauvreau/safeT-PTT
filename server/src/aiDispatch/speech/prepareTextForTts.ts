/**
 * ElevenLabs TTS preparation — ported from 10-8-alert-dashboard prepareTextForTTS().
 * Turns dispatcher text into phrasing radios expect: "913" → "nine thirteen",
 * "32-08" → "thirty-two oh-eight", "10-97" → "ten" + pause + "ninety seven",
 * "27-000" → "twenty seven thousand", other dashes → SSML breaks (not "to").
 */

import { spokenizeAddress } from "./addressSpeech.js";
import {
  CALL_TYPE_LOWERCASE_ONLY,
  CALL_TYPE_SPOKEN,
  callTypeSpokenKeysByLength,
} from "./callTypeSpoken.js";
import { digitWord, spokenAccountCode, twoDigitSpoken } from "./numbers.js";
import { formatPhoneForTts } from "./phoneSpeech.js";
import { expandUSStatesForSpeech } from "./stateSpeech.js";

/** SSML pause where a dash appeared — avoids TTS reading hyphen as "to". */
const DASH_BREAK = '<break time="0.28s" />';

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
    const flags = CALL_TYPE_LOWERCASE_ONLY.has(code) ? "g" : "gi";
    out = replaceWordBounded(out, code, spoken, flags);
  }
  return out;
}

/** ElevenLabs often spells ALL CAPS "UNIT" letter-by-letter; keep the radio word "unit". */
function normalizeUnitWordForSpeech(text: string): string {
  return text.replace(/\bUNIT\b/gi, "unit");
}

/** LLM / lookup lines that embed a street address after a fixed phrase. */
function spokenizeEmbeddedAddresses(text: string): string {
  return text.replace(
    /\b(full address is|address is)\s+([^.<]+(?:,\s*[^.<]+)*)/gi,
    (match, _label: string, addr: string) => {
      const spoken = spokenizeAddress(expandUSStatesForSpeech(addr.trim()));
      return match.replace(addr, spoken);
    },
  );
}

/**
 * SSA account codes in XX-YY form (18-06, 32-08).
 * Skips 10-XX (handled by [expandTenCodesForSpeech]) and 27-0XX (command staff).
 */
function expandAccountCodesForSpeech(text: string): string {
  return text.replace(/\b(\d{2})-(\d{2})\b/g, (match, a: string, b: string) => {
    if (a === "10") {
      return match;
    }
    if (a === "27") {
      return match;
    }
    return spokenAccountCode(`${a}${b}`);
  });
}

function spokenTenCodeSuffix(suffix: string): string {
  const digits = suffix.replace(/\D/g, "");
  if (!digits) {
    return suffix;
  }
  if (digits.length === 1) {
    return digitWord(parseInt(digits, 10));
  }
  if (digits.length === 2) {
    return twoDigitSpoken(parseInt(digits, 10));
  }
  if (digits.length === 3) {
    const head = parseInt(digits[0]!, 10);
    const tail = parseInt(digits.slice(1), 10);
    return `${digitWord(head)} ${twoDigitSpoken(tail)}`;
  }
  return digits
    .split("")
    .map((d) => digitWord(parseInt(d, 10)))
    .join(" ");
}

/** 10-97 → "ten" + pause + "ninety seven" (not "ten to ninety seven"). */
function expandTenCodesForSpeech(text: string): string {
  return text.replace(/\b10-(\d{1,3})\b/gi, (_match, suffix: string) => {
    return `ten${DASH_BREAK}${spokenTenCodeSuffix(suffix)}`;
  });
}

/** US phone patterns embedded in free text → digit-group TTS form. */
function expandPhoneNumbersInText(text: string): string {
  return text.replace(
    /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    (m) => formatPhoneForTts(m),
  );
}

function speakDigitToken(token: string): string {
  if (/^\d{1,2}$/.test(token)) {
    return twoDigitSpoken(parseInt(token, 10));
  }
  if (/^\d{3}$/.test(token)) {
    const head = parseInt(token[0]!, 10);
    const tail = parseInt(token.slice(1), 10);
    return `${digitWord(head)} ${twoDigitSpoken(tail)}`;
  }
  return token
    .split("")
    .map((d) => digitWord(parseInt(d, 10)))
    .join(" ");
}

/** Remaining digit-hyphen-digit (e.g. rare codes) → spoken groups with a pause, not "to". */
function expandRemainingDigitHyphens(text: string): string {
  let out = text.replace(/\b(\d+)-(\d+)\b/g, (_match, left: string, right: string) => {
    return `${speakDigitToken(left)}${DASH_BREAK}${speakDigitToken(right)}`;
  });
  out = out.replace(/(\d)-([A-Za-z])\b/gi, `$1${DASH_BREAK}$2`);
  return out;
}

/** Any leftover hyphen → SSML break (dash must never be read as "to"). */
function hyphensToSpeechBreaks(text: string): string {
  if (!text.includes("-")) {
    return text;
  }
  return text.replace(/-/g, DASH_BREAK);
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
  let out = normalizeUnitWordForSpeech(text);
  out = expandUSStatesForSpeech(out);
  out = spokenizeEmbeddedAddresses(out);
  out = expandAbbreviationsForSpeech(out);
  out = expandCallTypesForSpeech(out);
  out = expandAccountCodesForSpeech(out);
  out = expandTenCodesForSpeech(out);
  out = expandPhoneNumbersInText(out);
  out = expandRemainingDigitHyphens(out);
  out = hyphensToSpeechBreaks(out);
  out = addSpeechPacing(out);
  return out;
}
