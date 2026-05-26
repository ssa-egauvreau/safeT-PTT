// Normalisation for the `client_type` tag a handset sends with each
// location heartbeat. The value drives the per-row platform badge on
// the iOS UNITS roster (and any other console that surfaces a unit's
// reporting device), and is persisted in the `radio_positions` table.
//
// This is a trust boundary: the tag arrives over the wire from a
// handset and lands directly in a DB column, so a malformed client
// must not be able to pollute the table with arbitrary strings.
//
// Kept as a standalone helper (rather than inlined in the route) so the
// allow-list can be unit-tested without spinning up the Express stack.

/**
 * Platform tags that handsets are allowed to report. Anything outside
 * this list is dropped to null so a malformed client can't pollute the
 * `radio_positions.client_type` column with garbage. New first-party
 * platforms must be added here explicitly.
 */
export const ALLOWED_CLIENT_TYPES = ["ios", "android", "web", "radio", "desktop"] as const;

export type ClientType = (typeof ALLOWED_CLIENT_TYPES)[number];

const ALLOWED_SET: Set<string> = new Set(ALLOWED_CLIENT_TYPES);

/**
 * Validate and normalise a raw `client_type` value from a location-report
 * body. Accepts any value (typically `unknown` straight off the request body)
 * and returns one of the allow-listed strings — or `null` if the value is
 * missing, mistyped, or outside the allow-list.
 *
 *  - Strings are trimmed and lower-cased before comparison so a client that
 *    sends "IOS" or " ios " still gets credit for being on iOS.
 *  - Non-string values (numbers, objects, booleans, null, undefined) always
 *    return null so a confused client can't write a JSON object into the
 *    DB column.
 *  - On the upsert path, `null` is treated by the SQL as "preserve the
 *    previously-known value" (see `upsertPosition`'s COALESCE), so this
 *    function's `null` return is the same shape that a legacy client which
 *    never sent the field at all would produce.
 */
export function normalizeClientType(raw: unknown): ClientType | null {
  if (typeof raw !== "string") {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return ALLOWED_SET.has(normalized) ? (normalized as ClientType) : null;
}
