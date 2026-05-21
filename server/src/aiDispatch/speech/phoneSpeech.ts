/**
 * Phone numbers for TTS — digit groups with commas (10-8-alert-dashboard formatPhoneForTTS).
 * "714-555-1234" → "7 1 4, 5 5 5, 1 2 3 4"
 */

export function formatPhoneForTts(phone: string | null | undefined): string {
  if (!phone) {
    return "";
  }
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 0) {
    return "";
  }
  let area: string;
  let prefix: string;
  let line: string;
  if (digits.length === 10) {
    area = digits.slice(0, 3);
    prefix = digits.slice(3, 6);
    line = digits.slice(6);
  } else if (digits.length === 11 && digits[0] === "1") {
    area = digits.slice(1, 4);
    prefix = digits.slice(4, 7);
    line = digits.slice(7);
  } else if (digits.length === 7) {
    prefix = digits.slice(0, 3);
    line = digits.slice(3);
    return `${prefix.split("").join(" ")}, ${line.split("").join(" ")}`;
  } else {
    return digits.split("").join(" ");
  }
  return `${area.split("").join(" ")}, ${prefix.split("").join(" ")}, ${line.split("").join(" ")}`;
}
