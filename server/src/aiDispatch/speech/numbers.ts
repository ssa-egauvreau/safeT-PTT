/** Digit and number speech helpers (from 10-8-alert-dashboard dispatcher-server.js). */

const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];

const TEENS = [
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];

const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

export function digitWord(n: number): string {
  return ONES[n] ?? String(n);
}

export function numberToWords(n: number): string {
  if (n < 0 || n > 99) {
    return String(n);
  }
  if (n < 20) {
    return n < 10 ? ONES[n]! : TEENS[n - 10]!;
  }
  const t = Math.floor(n / 10);
  const o = n % 10;
  return o === 0 ? TENS[t]! : `${TENS[t]}-${digitWord(o)}`;
}

function twoDigitSpoken(n: number): string {
  if (n < 10) {
    return ONES[n]!;
  }
  if (n < 20) {
    return TEENS[n - 10]!;
  }
  const t = Math.floor(n / 10);
  const o = n % 10;
  return o === 0 ? TENS[t]! : `${TENS[t]}-${ONES[o]}`;
}

/**
 * SSA account codes on radio: 1805 → "eighteen-oh-five", 3127 → "thirty-one twenty-seven".
 */
export function spokenAccountCode(code: string | number | null | undefined): string {
  if (code == null) {
    return "";
  }
  const digits = String(code).replace(/[^0-9]/g, "");
  if (!digits) {
    return "";
  }
  if (digits.length === 4) {
    const first = parseInt(digits.slice(0, 2), 10);
    const second = parseInt(digits.slice(2, 4), 10);
    if (second === 0) {
      return `${twoDigitSpoken(first)} hundred`;
    }
    const secondSpoken =
      second < 10 ? `oh-${ONES[second]}` : twoDigitSpoken(second);
    return `${twoDigitSpoken(first)}-${secondSpoken}`;
  }
  if (digits.length === 3) {
    const first = parseInt(digits.slice(0, 1), 10);
    const rest = parseInt(digits.slice(1, 3), 10);
    if (rest < 10) {
      return `${ONES[first]}-oh-${ONES[rest]}`;
    }
    return `${ONES[first]} ${twoDigitSpoken(rest)}`;
  }
  if (digits.length <= 2) {
    return twoDigitSpoken(parseInt(digits, 10));
  }
  return digits
    .split("")
    .map((d) => ONES[parseInt(d, 10)]!)
    .join(" ");
}

/** Four-digit account as dash form for display: 3208 → "32-08". */
export function accountCodeDashForm(code: string): string {
  const digits = String(code).replace(/[^0-9]/g, "");
  if (digits.length === 4) {
    return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  }
  return digits;
}
