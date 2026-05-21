const STATE_NAMES: Record<string, string> = {
  CA: "California",
  AZ: "Arizona",
  NV: "Nevada",
  OR: "Oregon",
  WA: "Washington",
  TX: "Texas",
  FL: "Florida",
  NY: "New York",
  UT: "Utah",
  CO: "Colorado",
  ID: "Idaho",
  MT: "Montana",
  NM: "New Mexico",
  HI: "Hawaii",
  AK: "Alaska",
};

const LETTER_TO_PHONETIC: Record<string, string> = {
  A: "Alpha",
  B: "Bravo",
  C: "Charlie",
  D: "Delta",
  E: "Echo",
  F: "Foxtrot",
  G: "Golf",
  H: "Hotel",
  I: "India",
  J: "Juliet",
  K: "Kilo",
  L: "Lima",
  M: "Mike",
  N: "November",
  O: "Oscar",
  P: "Papa",
  Q: "Quebec",
  R: "Romeo",
  S: "Sierra",
  T: "Tango",
  U: "Uniform",
  V: "Victor",
  W: "Whiskey",
  X: "X-ray",
  Y: "Yankee",
  Z: "Zulu",
};

const DIGIT_TO_WORD: Record<string, string> = {
  "0": "zero",
  "1": "one",
  "2": "two",
  "3": "three",
  "4": "four",
  "5": "five",
  "6": "six",
  "7": "seven",
  "8": "eight",
  "9": "nine",
};

export function stateCodeToSpoken(state: string | null | undefined): string {
  const s = (state ?? "CA").toUpperCase();
  return STATE_NAMES[s] ?? s;
}

/** Raw plate → NATO phonetic readback (8VWV621 → 8 Victor Whiskey Victor 6 2 1). */
export function plateToSpokenPhonetic(plate: string | null | undefined): string {
  if (!plate) {
    return "";
  }
  const out: string[] = [];
  for (const c of plate.toUpperCase()) {
    if (LETTER_TO_PHONETIC[c]) {
      out.push(LETTER_TO_PHONETIC[c]);
    } else if (DIGIT_TO_WORD[c]) {
      out.push(DIGIT_TO_WORD[c]);
    }
  }
  return out.join(" ");
}

export function vinLast6Spoken(vin: string | null | undefined): string {
  if (!vin || vin.length < 6) {
    return "";
  }
  return plateToSpokenPhonetic(vin.slice(-6));
}

/** Radio unit id for spoken readback (command staff keep 27-0xx; patrol drops 27- prefix). */
export function callSignForReadback(unitId: string): string {
  const u = unitId.trim().toUpperCase();
  if (/^27-0\d{2}$/.test(u)) {
    return u;
  }
  return u.replace(/^27-/, "");
}
