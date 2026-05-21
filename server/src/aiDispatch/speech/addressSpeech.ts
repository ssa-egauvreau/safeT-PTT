/**
 * Street addresses for radio TTS (10-8-alert-dashboard spokenizeAddress).
 */

import { digitWord, numberToWords } from "./numbers.js";

export function spokenizeAddress(addr: string | null | undefined): string {
  if (!addr) {
    return "";
  }
  let out = String(addr);

  out = out.replace(/,?\s*USA\b/i, "").replace(/,?\s*United States\b/i, "");
  out = out.replace(/,\s*[A-Z]{2}\s+\d{5}(-\d{4})?\b/g, "");
  out = out.replace(/,?\s*\b\d{5}(-\d{4})?\s*$/, "");
  out = out.replace(/,\s*[A-Z]{2}\s*$/, "");

  out = out.replace(/\b([NSEW])\s/gi, (_m, d: string) => {
    const map: Record<string, string> = { N: "North", S: "South", E: "East", W: "West" };
    return `${map[d.toUpperCase()]} `;
  });
  out = out.replace(/\bNE\s/gi, "Northeast ")
    .replace(/\bNW\s/gi, "Northwest ")
    .replace(/\bSE\s/gi, "Southeast ")
    .replace(/\bSW\s/gi, "Southwest ");

  const streetTypes: Array<[RegExp, string]> = [
    [/\bSt\.?\b/gi, "Street"],
    [/\bAve\.?\b/gi, "Avenue"],
    [/\bBlvd\.?\b/gi, "Boulevard"],
    [/\bRd\.?\b/gi, "Road"],
    [/\bDr\.?\b/gi, "Drive"],
    [/\bLn\.?\b/gi, "Lane"],
    [/\bCt\.?\b/gi, "Court"],
    [/\bPl\.?\b/gi, "Place"],
    [/\bPkwy\.?\b/gi, "Parkway"],
    [/\bHwy\.?\b/gi, "Highway"],
    [/\bWay\b/gi, "Way"],
    [/\bTer\.?\b/gi, "Terrace"],
    [/\bCir\.?\b/gi, "Circle"],
    [/\bApt\.?\b/gi, "Apartment"],
    [/\bSte\.?\b/gi, "Suite"],
    [/\bBldg\.?\b/gi, "Building"],
  ];
  for (const [re, sub] of streetTypes) {
    out = out.replace(re, sub);
  }

  out = out.replace(/\b(\d+)\b/g, (_m, n: string) => {
    const num = parseInt(n, 10);
    if (Number.isNaN(num)) {
      return n;
    }
    if (num < 100) {
      return numberToWords(num);
    }
    if (num < 1000) {
      const hundreds = Math.floor(num / 100);
      const tens = num % 100;
      if (tens === 0) {
        return `${digitWord(hundreds)} hundred`;
      }
      if (tens < 10) {
        return `${digitWord(hundreds)} oh ${digitWord(tens)}`;
      }
      return `${digitWord(hundreds)} ${numberToWords(tens)}`;
    }
    if (num < 10000) {
      const left = Math.floor(num / 100);
      const right = num % 100;
      if (right === 0) {
        return `${numberToWords(left)} hundred`;
      }
      if (right < 10) {
        return `${numberToWords(left)} oh ${digitWord(right)}`;
      }
      return `${numberToWords(left)} ${numberToWords(right)}`;
    }
    return n
      .split("")
      .map((d) => digitWord(parseInt(d, 10)))
      .join(" ");
  });

  return out.replace(/,\s*$/, "").replace(/\s{2,}/g, " ").trim();
}
