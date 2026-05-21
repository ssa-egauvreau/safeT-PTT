/**
 * ElevenLabs TTS precache phrase list — same set as 10-8-alert-dashboard buildPrecachePhraseList().
 */

const RADIO_UNITS = ["151", "231", "334", "351", "352", "401", "402", "403"];
const COMMAND_UNITS = ["27-000", "27-010", "27-020", "27-030"];

export function buildPrecachePhraseList(): string[] {
  const phrases = new Set<string>();

  for (const p of [
    "Copy",
    "10-4",
    "Standby",
    "Negative",
    "Affirm",
    "That's affirm",
    "Received",
    "I copy",
    "Roger",
  ]) {
    phrases.add(p);
  }

  for (const u of RADIO_UNITS) {
    phrases.add(`Copy ${u}`);
  }

  for (const u of RADIO_UNITS) {
    phrases.add(`${u}, 913`);
  }

  for (const u of RADIO_UNITS) {
    phrases.add(`Copy ${u}, 10-8`);
    phrases.add(`Copy ${u}, 10-7`);
    phrases.add(`Copy ${u}, 10-23`);
    phrases.add(`Copy ${u}, 10-97`);
    phrases.add(`Copy ${u}, 10-98`);
    phrases.add(`Copy ${u}, 10-19`);
    phrases.add(`Copy ${u}, code 4`);
  }

  phrases.add("Copy. Standby.");
  for (const u of RADIO_UNITS) {
    phrases.add(`${u}, copy. Standby.`);
  }
  for (const u of COMMAND_UNITS) {
    phrases.add(`${u}, copy. Standby.`);
  }

  return Array.from(phrases);
}

export function normalizeForTtsPrecache(text: string): string {
  return String(text)
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/, "")
    .toLowerCase();
}
