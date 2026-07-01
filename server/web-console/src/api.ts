// Typed client for the safeT PTT API. All calls are same-origin (the Node server serves this app).

export type Role = "owner" | "admin" | "dispatcher" | "radio";
export type Permission = "talk_priority" | "talk" | "listen_only";

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  unitId: string | null;
  agencyId: number | null;
  agencyName: string | null;
}

export interface AdminUser {
  id: number;
  username: string;
  display_name: string;
  role: Role;
  unit_id: string | null;
  device_type: string | null;
  disabled: boolean;
  agency_id: number | null;
  created_at: string;
  /** Permission template this user follows (channels mirror it), or null. */
  assigned_template_id: number | null;
}

/** Device categories an admin can assign to an account. */
export const DEVICE_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "—" },
  { value: "unit_radio", label: "Unit radio (in-car)" },
  { value: "handheld", label: "Handheld (pacset)" },
  { value: "dispatch_console", label: "Dispatch console" },
  { value: "phone", label: "Phone" },
  { value: "radio_bridge", label: "Radio bridge" },
];

export function deviceTypeLabel(value: string | null): string {
  return DEVICE_TYPE_OPTIONS.find((o) => o.value === (value ?? ""))?.label ?? "—";
}

/** Window event fired when the agency logo is uploaded or removed, so the top bar can refresh. */
export const AGENCY_LOGO_CHANGED_EVENT = "safet:agency-logo-changed";

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled" | "comped";
export type PlanTier = "basic" | "pro";

export interface Agency {
  id: number;
  name: string;
  slug: string;
  radio_key: string | null;
  disabled: boolean;
  created_at: string;
  subscription_status?: SubscriptionStatus;
  plan_tier?: PlanTier;
  trial_ends_at?: string | null;
  logs_unlimited?: boolean;
  billing_email?: string | null;
  signup_completed_at?: string | null;
  /** Present on the owner agency listing; omitted on create/update responses. */
  user_count?: number;
  channel_count?: number;
}

export interface BillingStatus {
  plan_tier: PlanTier;
  subscription_status: SubscriptionStatus;
  trial_ends_at: string | null;
  trial_days_left: number | null;
  billable_seats: number;
  logs_unlimited: boolean;
  transmission_retention_days: number | null;
  billing_configured: boolean;
  portal_available: boolean;
  agency_disabled: boolean;
}

/**
 * Voice codecs the platform supports on the wire. Kept in sync with
 * server/src/voiceCodecs.ts and android-app/.../VoiceCodec.kt.
 */
export const VOICE_CODECS = ["imbe", "codec2_3200", "opus", "ambe_2450"] as const;
export type VoiceCodec = (typeof VOICE_CODECS)[number];

/** Human-readable label for the admin UI dropdown / channel rows. */
export const VOICE_CODEC_LABEL: Record<VoiceCodec, string> = {
  imbe: "IMBE (P25, default)",
  codec2_3200: "Codec2 3200",
  opus: "Opus (wideband)",
  ambe_2450: "AMBE+2 2450 (P25 Phase 2)",
};

/** Compact codec tag for channel cards / pickers — full names stay in
 *  {@link VOICE_CODEC_LABEL} for the admin dropdown. */
export const VOICE_CODEC_BADGE: Record<VoiceCodec, string> = {
  imbe: "IMBE",
  codec2_3200: "C2",
  opus: "OPUS",
  ambe_2450: "AMBE+2",
};

/** Badge text for a channel's codec, or "" when the codec is missing/unknown
 *  (older cached payloads) so callers can simply skip rendering the tag. */
export function voiceCodecBadge(codec: unknown): string {
  if (typeof codec === "string" && (VOICE_CODECS as readonly string[]).includes(codec)) {
    return VOICE_CODEC_BADGE[codec as VoiceCodec];
  }
  return "";
}

/** Safe label when codec may be missing from an API row (e.g. older cached payloads). */
export function voiceCodecLabel(codec: unknown): string {
  if (typeof codec === "string" && (VOICE_CODECS as readonly string[]).includes(codec)) {
    return VOICE_CODEC_LABEL[codec as VoiceCodec];
  }
  return "unknown codec";
}

export function coerceVoiceCodecClient(raw: unknown): VoiceCodec {
  if (typeof raw === "string" && (VOICE_CODECS as readonly string[]).includes(raw)) {
    return raw as VoiceCodec;
  }
  return "imbe";
}

export interface Channel {
  id: number;
  name: string;
  sort_order: number;
  color: string | null;
  /** Zone NAME (joined from the agency's numbered zone bank). */
  zone: string | null;
  zone_id: number | null;
  zone_number: number | null;
  codec: VoiceCodec;
}

/** A numbered channel bank — radios show the number before the channel name ("1 GREEN 1"). */
export interface Zone {
  id: number;
  zone_number: number;
  name: string;
}

export interface Membership {
  user_id: number;
  channel_id: number;
  permission: Permission;
}

export interface TemplateMembership {
  channel_id: number;
  permission: Permission;
}

export interface UserPermissionTemplate {
  id: number;
  agency_id: number;
  name: string;
  memberships: TemplateMembership[];
  created_at: string;
  updated_at: string;
}

/**
 * Per-channel AI dispatch engagement mode.
 *  - off        — dispatcher never listens.
 *  - supervised — only engages when the transmission opens with the wake word "AI".
 *  - full_auto  — listens to every qualifying transmission (legacy ON).
 */
export type AiDispatchMode = "off" | "supervised" | "full_auto";

export interface UserChannel {
  id: number;
  name: string;
  permission: Permission;
  color: string | null;
  zone: string | null;
  zone_number?: number | null;
  codec: VoiceCodec;
  /** True for a simulcast channel — keying it transmits on several real channels. */
  simulcast?: boolean;
  /** Per-channel AI dispatcher (dispatch console only). */
  ai_dispatch_enabled?: boolean;
  /** Three-way AI dispatch engagement mode (dispatch console only). */
  ai_dispatch_mode?: AiDispatchMode;
}

export interface Simulcast {
  id: number;
  name: string;
  member_channel_ids: number[];
}

export interface AuditEntry {
  id: number;
  ts: string;
  actor_user_id: number | null;
  actor_name: string | null;
  action: string;
  target: string | null;
  detail: unknown;
  ip: string | null;
}

export interface AiDispatchActivityEntry {
  id: number;
  transmission_id: number | null;
  channel_name: string | null;
  unit_id: string | null;
  transcript: string;
  intent: string | null;
  summary: string | null;
  dispatcher_response: string | null;
  trigger_emergency_tone: boolean;
  plate_lookup: {
    ok: boolean;
    plate?: string | null;
    state?: string | null;
    year?: string | null;
    make?: string | null;
    model?: string | null;
    color?: string | null;
    vin?: string | null;
    reason?: string;
  } | null;
  error: string | null;
  outcome: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface AiDispatchTestResult {
  request: {
    transcript: string;
    channelName: string;
    unitId: string;
    sendForReal: boolean;
    synthesizeTts: boolean;
  };
  durationMs: number;
  trace: { phase: string; ms: number; detail?: string }[];
  channelAiDispatchEnabled: boolean;
  ten8Configured: boolean;
  parsed: {
    actionable: boolean;
    intent: string;
    unit: string | null;
    summary: string;
    confidence: number;
    dispatcher_response: string | null;
    trigger_emergency_tone: boolean;
    recommended_action: string | null;
    code: string | null;
    location_code: string | null;
    location_name: string | null;
    plate_request: {
      plate: string | null;
      state: string | null;
      vin: string | null;
    } | null;
    info_request: {
      type: string;
      account_code: string | null;
      subject: string | null;
    } | null;
    comment_text: string | null;
  } | null;
  knowledgeContextChars: number;
  knowledgeContextPreview: string;
  plateLookup: {
    ok: boolean;
    plate?: string | null;
    state?: string | null;
    year?: string | null;
    make?: string | null;
    model?: string | null;
    color?: string | null;
    vin?: string | null;
    provider?: string;
    reason?: string;
    message?: string;
    ms?: number;
  } | null;
  ten8Actions: Record<string, unknown>;
  dispatcherReply: string;
  ttsKind: string;
  ttsMp3Base64: string | null;
  followUpDispatcherReply?: string;
  followUpTtsKind?: string;
  followUpTtsMp3Base64?: string | null;
  errors: string[];
}

export interface Ten8ActiveIncident {
  call_id: string;
  incident_type: string | null;
  priority: string | null;
  status: string | null;
  location: string | null;
  updated_at: string;
}

export interface Ten8MapIncident {
  call_id: string;
  label: string;
  incident_type: string | null;
  location: string | null;
  lat: number;
  lon: number;
}

/** Raw result from the admin 10-8 CAD API tester (one action per call). */
export interface Ten8ApiTestResult {
  ok: boolean;
  status?: number;
  /** True when the write was shadowed (live CAD writes are OFF for the agency). */
  shadow?: boolean;
  data: unknown;
  /** Actual base URLs the server resolved for this agency (after per-agency overrides). */
  hosts?: { cadBaseUrl: string | null; newIncidentBaseUrl: string | null };
}

export interface Transmission {
  id: number;
  channel_id: number | null;
  channel_name: string;
  user_id: number | null;
  unit_id: string | null;
  display_name: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number;
  sample_rate: number;
  audio_mime: string;
  transcript: string | null;
  transcript_status: string;
}

/** Live voice relay: who is keyed on a channel (same source as Android `/v1/air`). */
export interface AirState {
  occupied: boolean;
  transmitting_unit_id: string | null;
  transmitting_display_name: string | null;
  /** Bridge / AI dispatch traffic that yields — local PTT is not blocked. */
  transmitting_yields?: boolean;
}

/** Home + scan talker hints (Android `/v1/talk-activity`). */
export interface TalkActivity {
  main: {
    channel: string;
    active: boolean;
    unit_id: string | null;
    username: string | null;
  };
  scan: {
    channel: string;
    active: boolean;
    unit_id: string | null;
    username: string | null;
  };
}

export interface RadioPosition {
  /** The label to show: the officer's shift callsign when assigned, else the raw radio id. */
  unit_id: string;
  /** The radio's own reported id (before any shift-callsign overlay). */
  radio_unit_id?: string;
  user_id: number | null;
  display_name: string | null;
  channel_name: string | null;
  lat: number;
  lon: number;
  accuracy_m: number | null;
  heading: number | null;
  speed_mps: number | null;
  /** Device category of the reporting account (handheld, unit_radio, …), or null. */
  device_type: string | null;
  /** Form-factor from the active SSA shift assignment: "car" | "handheld" | null.
   *  Preferred over device_type for the map glyph when present. */
  radio_kind?: string | null;
  updated_at: string;
}

/** One recorded GPS fix from a radio's position history. */
export interface PositionSample {
  lat: number;
  lon: number;
  accuracy_m: number | null;
  heading: number | null;
  speed_mps: number | null;
  recorded_at: string;
}

/** A map overlay zone drawn by an operator — a circle or a custom polygon. */
export interface Geofence {
  id: number;
  name: string;
  shape: string;
  color: string | null;
  center_lat: number | null;
  center_lon: number | null;
  radius_m: number | null;
  /** Polygon vertices as [lat, lon] pairs; null for a circle geofence. */
  points: [number, number][] | null;
  created_by: string | null;
  created_at: string;
}

export type GeofenceInput =
  | { shape: "circle"; name: string; centerLat: number; centerLon: number; radiusM: number; color?: string | null }
  | { shape: "polygon"; name: string; points: [number, number][]; color?: string | null };

export interface Alert {
  id: number;
  kind: string;
  channel_name: string | null;
  target_unit: string | null;
  from_user_id: number | null;
  from_name: string | null;
  from_unit: string | null;
  message: string | null;
  active: boolean;
  created_at: string;
  cleared_by: string | null;
  cleared_at: string | null;
  /** True when this page/alert carries a picture attachment. */
  has_image?: boolean;
}

export interface AlertResponse {
  id: number;
  alert_id: number;
  unit: string;
  response: string;
  created_at: string;
}

/** Auto-derived activity status for a roster member. */
export type PresenceStatus = "idle" | "transmitting" | "driving" | "emergency";

export interface ChannelMember {
  unit_id: string;
  display_name: string | null;
  kind: string;
  /** Client platform: android, ios, web, desktop, bridge, or unknown. */
  client: string;
  /** Account device category when known (unit_radio, phone, dispatch_console, …). */
  device_type?: string | null;
  connected_ms: number;
  /** Derived from live signals (talker / GPS speed / active emergency). */
  status?: PresenceStatus;
  /** Dispatch console on multiple channels — do not live-move. */
  move_locked?: boolean;
}

export interface UnitAlias {
  unit_id: string;
  label: string;
  updated_at: string;
}

export interface AgencySound {
  kind: string;
  mime: string;
  byte_size: number;
  updated_at: string;
}

export interface KbDocument {
  id: number;
  title: string;
  category: string;
  property_code: string | null;
  filename: string | null;
  mime: string;
  byte_size: number;
  status: string;
  error: string | null;
  chunk_count: number;
  embed_model: string | null;
  created_at: string;
  updated_at: string;
}

export interface KbCategory {
  id: string;
  label: string;
  description: string;
}

export interface KbCategorySection {
  id: string;
  label: string;
  description: string;
  categories: KbCategory[];
}

export interface IntegrationItem {
  key: string;
  label: string;
  description: string;
  kind: "secret" | "text" | "url" | "multiline";
  availability: "active" | "coming_soon";
  placeholder?: string;
  configured: boolean;
  display_value: string | null;
  updated_at: string | null;
}

export interface IntegrationsPayload {
  platform: {
    enabled: boolean;
    llmConfigured: boolean;
    model: string;
    dispatchUnitId: string;
  };
  platform_note: string;
  prompt_source?: "custom" | "sunset_bundled" | "railway_default";
  groups: { id: string; label: string; items: IntegrationItem[] }[];
}

export interface ProviderHealth {
  provider: string;
  label: string;
  status: "ok" | "low" | "out" | "error" | "unknown";
  detail: string;
  remaining?: number | null;
  limit?: number | null;
}

export interface IntegrationHealthPayload {
  providers: ProviderHealth[];
  checkedAt: string;
}

/** Published fleet Android build (public /v1/app/android/version). */
export interface AndroidAppRelease {
  versionCode: number;
  versionName: string;
  /** Path on this server, e.g. /v1/app/android/apk */
  url: string;
  sha256: string;
  mandatory: boolean;
  notes: string;
}

/** One row in the Android OTA release history (newest first). */
export interface AndroidReleaseRecord {
  versionCode: number;
  versionName: string;
  notes: string;
  mandatory: boolean;
  publishedAt: string;
  url: string | null;
  sha256: string | null;
}

export interface Bridge {
  id: number;
  name: string;
  source_type: string;
  source_url: string | null;
  device_hint: string | null;
  target_channel: string;
  direction: string;
  yield_to_units: boolean;
  tx_mode: string;
  vox_threshold: number;
  vox_hang_ms: number;
  enabled: boolean;
  /** Static/hiss filtering on ingest: "off" | "light" | "strong". */
  noise_suppression: string;
  created_at: string;
}

export interface BridgeInput {
  name: string;
  sourceType: string;
  sourceUrl: string | null;
  deviceHint: string | null;
  targetChannel: string;
  direction: string;
  yieldToUnits: boolean;
  txMode: string;
  voxThreshold: number;
  voxHangMs: number;
  enabled: boolean;
  noiseSuppression: string;
}

/** Live ingest status for a stream bridge — its input level and VOX gate state. */
export interface BridgeStatus {
  id: number;
  /** Normalized input level, 0–1. */
  level: number;
  /** Whether the VOX gate is currently keying the channel. */
  keyed: boolean;
  /** Whether the server is actively ingesting this bridge. */
  running: boolean;
  /** When not running, the last failure cause (refused, auth, unreachable, …), else null. */
  reason?: string | null;
}

/** A talkgroup the SDR bridge has heard on Scan All but that has no bridge yet. */
export interface ObservedTalkgroup {
  tgid: number;
  label: string;
  /** Approximate calls heard this bridge session. */
  count: number;
  /** Epoch ms when it was last heard. */
  lastHeard: number;
}

/** A custom soundboard tone-out — an operator-fired audio clip. */
export interface ToneOut {
  id: number;
  name: string;
  /** "once" plays through; "loop" repeats until stopped. */
  play_mode: string;
  /** Built-in glyph kind, used when no custom image is set. */
  icon_kind: string;
  icon_color: string;
  /** True when a custom icon image is set (overrides the built-in glyph). */
  has_image: boolean;
  /** True once an audio clip has been uploaded — a tone-out is firable only then. */
  has_audio: boolean;
  sort_order: number;
}

export class ApiError extends Error {
  status: number;
  constructor(code: string, status: number) {
    super(code);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Per-codec counter pair the dashboard renders as a codec mix legend. */
export interface VoiceLinkCodecEntry {
  framesReceived: number;
  framesDecoded: number;
}

/** One per-window report a client emits roughly every 30 s. Counters only — no
 *  audio, no transcript, no PCM. Kept tiny on the wire (~200-400 bytes
 *  typical; 4 KB server-side cap). */
export interface VoiceLinkTelemetryReport {
  unitId?: string;
  channel?: string;
  clientType?: string;
  /** True when the window ran in a hidden (timer-throttled) browser tab. */
  tabHidden?: boolean;
  counters: {
    framesReceived: number;
    framesDecoded: number;
    decodeFailures: number;
    plcFramesSynthesized: number;
    bufferUnderruns: number;
    maxBufferDepthFrames: number;
    talkSpurtsStarted: number;
    talkSpurtsEnded: number;
    bytesReceived: number;
    /** Uplink bytes — optional for older clients; the server defaults it to 0. */
    bytesSent?: number;
    wallMsObservation: number;
  };
  codecBreakdown: Record<string, VoiceLinkCodecEntry>;
  clientTs: string;
}

export interface DeviceAck {
  id: number;
  ts: string;
  actor_name: string | null;
  target: string | null;
  detail: {
    command?: string;
    commandId?: string | null;
    status?: string;
    detail?: unknown;
  } | null;
}

export interface VoiceLinkUnitSummary {
  unit_id: string;
  last_seen: string;
  reports: number;
  frames_received: number;
  frames_decoded: number;
  decode_failures: number;
  plc_frames_synthesized: number;
  buffer_underruns: number;
  max_buffer_depth_frames: number;
  talk_spurts_started: number;
  talk_spurts_ended: number;
  bytes_received: number;
  /** Uplink bytes (0 from clients that predate the data-usage column). */
  bytes_sent: number;
  wall_ms_observation: number;
  codec_mix: Record<string, VoiceLinkCodecEntry>;
  channels: string[];
  client_types: string[];
  /** Last-hour counters (anchored at the unit's newest report, hidden-tab
   *  windows excluded) — the badge basis. Optional: older servers omit them
   *  and the panel falls back to the whole-range sums. */
  recent_reports?: number;
  recent_frames_decoded?: number;
  recent_plc_frames_synthesized?: number;
  recent_buffer_underruns?: number;
  recent_hidden_reports?: number;
  /** Latest app build this unit reported (fleet OTA / version view). Null until a client sends it. */
  app_version_name?: string | null;
  app_version_code?: number | null;
}

export interface VoiceLinkUnitsResponse {
  units: VoiceLinkUnitSummary[];
  sinceMs: number;
}

export interface VoiceLinkTimeseriesPoint {
  server_ts: string;
  channel: string | null;
  client_type: string | null;
  frames_received: number;
  frames_decoded: number;
  decode_failures: number;
  plc_frames_synthesized: number;
  buffer_underruns: number;
  max_buffer_depth_frames: number;
  talk_spurts_started: number;
  talk_spurts_ended: number;
  bytes_received: number;
  bytes_sent: number;
  wall_ms_observation: number;
  codec_breakdown: Record<string, VoiceLinkCodecEntry>;
}

export interface VoiceLinkTimeseriesResponse {
  unit: string;
  windows: VoiceLinkTimeseriesPoint[];
  sinceMs: number;
}

export interface GlobalAudioConfigResponse {
  config: unknown | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Device-friendly summary of the agency-wide audio config (any logged-in member). */
export interface AudioConfigSummary {
  agcEnabled: boolean;
  noiseSuppression: boolean;
  gainMultiplier: number;
  bypassMicProcessing: boolean;
  /** RX-side post-decode chain, or `null` when no shaping is in effect.
   *  Shape mirrors the `PostDecodeConfig` the voice client's
   *  `postDecodeChain.ts` consumes. */
  postDecode: AudioConfigPostDecode | null;
}

/** Subset of `AudioLabConfig.postDecode` that the voice client applies on RX. */
export interface AudioConfigPostDecode {
  upsampleMode: "duplicate" | "linear" | "polyphase" | "polyphase24";
  hpfEnabled?: boolean;
  hpfHz?: number;
  lpfEnabled?: boolean;
  lpfHz?: number;
  lowShelfEnabled?: boolean;
  lowShelfHz?: number;
  lowShelfDb?: number;
  highShelfEnabled?: boolean;
  highShelfHz?: number;
  highShelfDb?: number;
  presenceEnabled?: boolean;
  presenceHz?: number;
  presenceDb?: number;
  presenceQ?: number;
  saturationAmount?: number;
}

export interface AudioConfigSummaryResponse {
  config: AudioConfigSummary | null;
  updatedAt: string | null;
}

export type AnalyticsRange = "24h" | "7d" | "30d";

export interface AnalyticsSummary {
  range: AnalyticsRange;
  transmissions: number;
  transmissionsPrev: number;
  activeUnits: number;
  activeUnitsPrev: number;
  onAirMs: number;
  onAirMsPrev: number;
  alerts: number;
  alertsPrev: number;
  aiCalls: number;
  aiCallsPrev: number;
  aiEscalated: number;
}

export interface AnalyticsTimeSeriesPoint {
  bucket: string;
  transmissions: number;
  onAirMs: number;
  aiCalls: number;
}

export interface AnalyticsChannelRow {
  channel: string;
  transmissions: number;
  onAirMs: number;
  uniqueUnits: number;
}

export interface AnalyticsUnitRow {
  unitId: string;
  displayName: string | null;
  transmissions: number;
  onAirMs: number;
}

export interface AnalyticsAiOutcomeRow {
  outcome: string;
  count: number;
}

export interface GlobalAudioConfigPushResponse {
  ok: boolean;
  config: unknown;
  updatedAt: string;
  updatedBy: string | null;
}

/** One entry in the Audio Lab preset dropdown — body is not embedded so the
 *  list payload stays small even when an agency saves a long catalogue. */
export interface AudioLabPresetSummary {
  name: string;
  updatedAt: string;
  /** One-line, operator-readable description of what the preset enables. */
  summary: string;
}

export interface AudioLabPresetListResponse {
  presets: AudioLabPresetSummary[];
}

export interface AudioLabPresetResponse {
  name: string;
  config: unknown;
  updatedAt: string;
}

let authToken: string | null = null;

export function setToken(token: string | null): void {
  authToken = token;
}

/** Current bearer token, for transports that cannot send headers (the voice WebSocket). */
export function getToken(): string | null {
  return authToken;
}

/** Dispatched whenever the server tells us our token is no longer accepted. */
export const SESSION_EXPIRED_EVENT = "safet:session-expired";

/**
 * Called by every API path that can come back 401, so an evicted session
 * (account disabled, signed in elsewhere, etc.) drops out of the console
 * within the same tick instead of waiting for the next user click.
 */
function handle401IfNeeded(status: number): void {
  if (status !== 401) return;
  authToken = null;
  try {
    localStorage.removeItem("securityradio.token");
  } catch {
    /* ignore storage quota / private mode */
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
  }
  if (!res.ok) {
    handle401IfNeeded(res.status);
    const code = (data as { error?: string })?.error ?? `http_${res.status}`;
    throw new ApiError(code, res.status);
  }
  return data as T;
}

export const api = {
  verifySignupEmail: (email: string) =>
    request<{ ok: boolean }>("POST", "/v1/signup/verify-email", { email }),
  signup: (input: {
    agency_name: string;
    admin_username: string;
    admin_display_name: string;
    admin_password: string;
    email: string;
    verification_code: string;
    plan_tier: PlanTier;
    accept_terms: boolean;
  }) =>
    request<{ ok: boolean; agencySlug: string; adminUsername: string }>("POST", "/v1/signup", input),
  getBillingStatus: () => request<BillingStatus>("GET", "/v1/billing/status"),
  startBillingCheckout: (plan_tier: PlanTier, logs_unlimited: boolean) =>
    request<{ url: string }>("POST", "/v1/billing/checkout", { plan_tier, logs_unlimited }),
  openBillingPortal: () => request<{ url: string }>("POST", "/v1/billing/portal", {}),
  updateBillingPlan: (plan_tier: PlanTier, logs_unlimited: boolean) =>
    request<{ ok: boolean }>("PATCH", "/v1/billing/plan", { plan_tier, logs_unlimited }),

  login: (username: string, password: string, agencySlug?: string) =>
    request<{ token: string; user: SessionUser }>("POST", "/v1/auth/login", {
      username,
      password,
      ...(agencySlug?.trim() ? { agency_slug: agencySlug.trim().toLowerCase() } : {}),
    }),
  me: () => request<{ user: SessionUser }>("GET", "/v1/auth/me"),
  myChannels: () => request<{ channels: UserChannel[] }>("GET", "/v1/me/channels"),

  listUsers: () => request<{ users: AdminUser[] }>("GET", "/v1/admin/users"),
  createUser: (input: {
    username: string;
    displayName: string;
    password: string;
    role: Role;
    unitId: string | null;
    deviceType: string | null;
  }) => request<{ user: AdminUser }>("POST", "/v1/admin/users", input),
  updateUser: (
    id: number,
    patch: Partial<{
      displayName: string;
      role: Role;
      unitId: string | null;
      deviceType: string | null;
      disabled: boolean;
      password: string;
      /** Bind to a permission template (null unbinds). Binding re-syncs the user's channels. */
      assignedTemplateId: number | null;
    }>,
  ) => request<{ user: AdminUser }>("PATCH", `/v1/admin/users/${id}`, patch),
  deleteUser: (id: number) => request<{ ok: boolean }>("DELETE", `/v1/admin/users/${id}`),

  listChannels: () => request<{ channels: Channel[] }>("GET", "/v1/admin/channels"),
  createChannel: (name: string) => request<{ channel: Channel }>("POST", "/v1/admin/channels", { name }),
  getAdminAgency: () =>
    request<{
      agency: { id: number; name: string; slug: string; defaultCodec: VoiceCodec };
    }>("GET", "/v1/admin/agency"),
  setAgencyDefaultCodec: (codec: VoiceCodec) =>
    request<{
      agency: { id: number; name: string; slug: string; defaultCodec: VoiceCodec };
    }>("PATCH", "/v1/admin/agency", { defaultCodec: codec }),
  updateChannel: (
    id: number,
    patch: { name?: string; color?: string | null; zone_id?: number | null; codec?: VoiceCodec },
  ) => request<{ channel: Channel }>("PATCH", `/v1/admin/channels/${id}`, patch),
  deleteChannel: (id: number) => request<{ ok: boolean }>("DELETE", `/v1/admin/channels/${id}`),

  listZones: () => request<{ zones: Zone[] }>("GET", "/v1/admin/zones"),
  createZone: (zoneNumber: number, name: string) =>
    request<{ zone: Zone }>("POST", "/v1/admin/zones", { zone_number: zoneNumber, name }),
  updateZone: (id: number, patch: { zone_number?: number; name?: string }) =>
    request<{ zone: Zone }>("PATCH", `/v1/admin/zones/${id}`, patch),
  deleteZone: (id: number) => request<{ ok: boolean }>("DELETE", `/v1/admin/zones/${id}`),

  listMemberships: () => request<{ memberships: Membership[] }>("GET", "/v1/admin/memberships"),
  setMembership: (userId: number, channelId: number, permission: Permission) =>
    request<{ ok: boolean }>("PUT", "/v1/admin/memberships", { userId, channelId, permission }),
  removeMembership: (userId: number, channelId: number) =>
    request<{ ok: boolean }>("DELETE", `/v1/admin/memberships?userId=${userId}&channelId=${channelId}`),

  listUserTemplates: () =>
    request<{ templates: UserPermissionTemplate[] }>("GET", "/v1/admin/user-templates"),
  createUserTemplate: (input: { name: string; memberships: { channelId: number; permission: Permission }[] }) =>
    request<{ template: UserPermissionTemplate }>("POST", "/v1/admin/user-templates", input),
  updateUserTemplate: (
    id: number,
    patch: { name?: string; memberships?: { channelId: number; permission: Permission }[] },
  ) => request<{ template: UserPermissionTemplate }>("PATCH", `/v1/admin/user-templates/${id}`, patch),
  deleteUserTemplate: (id: number) =>
    request<{ ok: boolean }>("DELETE", `/v1/admin/user-templates/${id}`),
  applyUserTemplate: (id: number, userId: number) =>
    request<{ ok: boolean; applied: number; skipped: number }>(
      "POST",
      `/v1/admin/user-templates/${id}/apply`,
      { userId },
    ),

  listAudit: (limit = 200) => request<{ entries: AuditEntry[] }>("GET", `/v1/admin/audit?limit=${limit}`),

  listVoiceLinkTelemetry: (opts: { sinceMs?: number; channel?: string } = {}) => {
    const params = new URLSearchParams();
    if (opts.sinceMs && opts.sinceMs > 0) {
      params.set("since", String(opts.sinceMs));
    }
    const channel = opts.channel?.trim();
    if (channel) {
      params.set("channel", channel);
    }
    const qs = params.toString();
    return request<VoiceLinkUnitsResponse>(
      "GET",
      qs ? `/v1/admin/voice-link-telemetry?${qs}` : "/v1/admin/voice-link-telemetry",
    );
  },
  /** Online roster — unit IDs of this agency with a live voice socket right now. */
  listOnlineUnits: () => request<{ units: string[] }>("GET", "/v1/admin/online-units"),
  /** Recent device-command acks for a unit (remote diagnostics). */
  listDeviceAcks: (unitId: string, limit = 20) =>
    request<{ acks: DeviceAck[] }>(
      "GET",
      `/v1/admin/device-acks/${encodeURIComponent(unitId)}?limit=${limit}`,
    ),
  /** Push an admin remote command to one handset over its live voice socket. */
  sendDeviceCommand: (unitId: string, command: string, params?: Record<string, unknown>) =>
    request<{ ok: boolean; reached: number; commandId: string }>(
      "POST",
      "/v1/admin/device-command",
      { unit_id: unitId, command, params: params ?? {} },
    ),
  getVoiceLinkUnitTimeseries: (unitId: string, opts: { sinceMs?: number; channel?: string } = {}) => {
    const params = new URLSearchParams();
    if (opts.sinceMs && opts.sinceMs > 0) {
      params.set("since", String(opts.sinceMs));
    }
    const channel = opts.channel?.trim();
    if (channel) {
      params.set("channel", channel);
    }
    const qs = params.toString();
    const path = `/v1/admin/voice-link-telemetry/${encodeURIComponent(unitId)}`;
    return request<VoiceLinkTimeseriesResponse>("GET", qs ? `${path}?${qs}` : path);
  },
  /** Client → server: counters-only voice-link health report. POSTed every
   *  ~30 s by every audio client (handsets + web). Body is ≤ ~500 bytes so the
   *  channel doesn't add measurable cellular cost — the whole point of this
   *  surface is to SAVE data by enabling triage. */
  postVoiceLinkTelemetry: (body: VoiceLinkTelemetryReport) =>
    request<{ ok: boolean; persisted?: boolean }>("POST", "/v1/telemetry/voice-link", body),

  transmissions: (
    opts: {
      limit?: number;
      search?: string;
      channel?: string;
      user?: string;
      from?: string;
      to?: string;
      sort?: string;
    } = {},
  ) => {
    const params = new URLSearchParams({ limit: String(opts.limit ?? 100) });
    for (const key of ["search", "channel", "user", "from", "to", "sort"] as const) {
      const value = opts[key]?.trim();
      if (value) {
        params.set(key, value);
      }
    }
    return request<{ transmissions: Transmission[] }>("GET", `/v1/transmissions?${params}`);
  },

  air: (channel: string) => {
    const params = new URLSearchParams({ channel: channel.trim() });
    return request<AirState>("GET", `/v1/air?${params}`);
  },

  talkActivity: (opts: { home?: string; scan?: string }) => {
    const params = new URLSearchParams();
    const home = opts.home?.trim();
    const scan = opts.scan?.trim();
    if (home) params.set("home", home);
    if (scan) params.set("scan", scan);
    return request<TalkActivity>("GET", `/v1/talk-activity?${params}`);
  },

  locations: () => request<{ positions: RadioPosition[] }>("GET", "/v1/locations"),
  ten8MapIncidents: () =>
    request<{ incidents: Ten8MapIncident[] }>("GET", "/v1/ten8/map-incidents"),
  agencyUnits: () =>
    request<{ units: { unit_id: string; display_name: string | null }[] }>(
      "GET",
      "/v1/agency/units",
    ),
  locationHistory: (unit: string, from?: string, to?: string) => {
    const params = new URLSearchParams({ unit });
    if (from) {
      params.set("from", from);
    }
    if (to) {
      params.set("to", to);
    }
    return request<{ unit: string; samples: PositionSample[] }>(
      "GET",
      `/v1/locations/history?${params}`,
    );
  },

  geofences: () => request<{ geofences: Geofence[] }>("GET", "/v1/geofences"),
  createGeofence: (input: GeofenceInput) =>
    request<{ geofence: Geofence }>("POST", "/v1/geofences", input),
  deleteGeofence: (id: number) => request<{ ok: boolean }>("DELETE", `/v1/geofences/${id}`),

  alerts: () => request<{ alerts: Alert[] }>("GET", "/v1/alerts"),
  alertResponses: () => request<{ responses: AlertResponse[] }>("GET", "/v1/alerts/responses"),
  sendAlert: (input: { kind: string; channelName: string | null; targetUnit?: string | null; message: string | null }) =>
    request<{ alert: Alert }>("POST", "/v1/alerts", input),
  clearAlert: (id: number) => request<{ alert: Alert }>("POST", `/v1/alerts/${id}/clear`),

  /** Toggles the 10-33 channel marker so radios on that channel show a warning icon. */
  setChannelTen33: (channelName: string, active: boolean) =>
    request<{ ok: boolean; active: boolean }>("POST", "/v1/channels/ten33", { channel: channelName, active }),

  getChannelTen33: (channelName: string) =>
    request<{ active: boolean }>(
      "GET",
      `/v1/channels/ten33?channel=${encodeURIComponent(channelName)}`,
    ),

  getAiDispatchStatus: () =>
    request<{
      platform_enabled: boolean;
      platform_llm_configured: boolean;
      agency_tts_configured: boolean;
      agency_prompt_configured: boolean;
      agency_prompt_source?: "custom" | "sunset_bundled" | "railway_default";
      model: string;
      dispatch_unit_id: string;
      agency_wake_word?: string;
    }>("GET", "/v1/ai-dispatch/status"),

  setChannelAiDispatch: (channelName: string, mode: AiDispatchMode) =>
    request<{ ok: boolean; enabled: boolean; mode: AiDispatchMode }>(
      "POST",
      "/v1/channels/ai-dispatch",
      { channel: channelName, mode },
    ),

  getChannelAiDispatch: (channelName: string) =>
    request<{ enabled: boolean; mode: AiDispatchMode }>(
      "GET",
      `/v1/channels/ai-dispatch?channel=${encodeURIComponent(channelName)}`,
    ),

  getAiDispatchActivity: (limit = 50) =>
    request<{
      count: number;
      entries: AiDispatchActivityEntry[];
      ten8_active_incidents: Ten8ActiveIncident[];
      ten8_recent_webhooks: { id: number; action: string; call_id: string | null; received_at: string }[];
    }>("GET", `/v1/ai-dispatch/activity?limit=${limit}`),

  testAiDispatch: (input: {
    transcript: string;
    channelName: string;
    unitId: string;
    sendForReal?: boolean;
    synthesizeTts?: boolean;
  }) => request<AiDispatchTestResult>("POST", "/v1/ai-dispatch/test", input),

  channelRoster: (channel: string) =>
    request<{ members: ChannelMember[] }>("GET", `/v1/channels/roster?channel=${encodeURIComponent(channel)}`),

  /** Live Channel Control: every channel with its currently-connected members. */
  channelRosters: () =>
    request<{ channels: { channel: string; members: ChannelMember[] }[] }>(
      "GET",
      "/v1/channels/rosters",
    ),

  /** Live Channel Control: push a live move command to a unit. */
  moveUnit: (input: { unitId: string; toChannel: string; fromChannel?: string | null; reason?: string | null }) =>
    request<{ ok: boolean; reached: number }>("POST", "/v1/channels/move", {
      unit_id: input.unitId,
      toChannel: input.toChannel,
      fromChannel: input.fromChannel ?? null,
      reason: input.reason ?? null,
    }),

  /** Live Channel Control: create (or reuse) an emergency channel and pull units in. */
  createEmergencyChannel: (input: { name?: string; unitIds: string[] }) =>
    request<{ ok: boolean; channel: string; reached: number }>("POST", "/v1/channels/emergency", {
      name: input.name ?? null,
      unit_ids: input.unitIds,
    }),

  /** Live Channel Control: delete an emergency channel only if it is still emergency-named. */
  deleteEmergencyChannel: (id: number) =>
    request<{ ok: boolean }>("DELETE", `/v1/channels/emergency/${id}`),

  /** Fires the same /radio/emergency endpoint the Android handsets use; surfaces as an alert. */
  radioEmergency: (input: {
    unitId: string;
    channel: string | null;
    active: boolean;
    displayName?: string | null;
    message?: string | null;
  }) =>
    request<{ ok?: boolean; alert?: unknown; cleared?: number }>(
      "POST",
      "/v1/radio/emergency",
      {
        unit_id: input.unitId,
        channel: input.channel,
        active: input.active,
        display_name: input.displayName ?? null,
        message: input.message ?? null,
      },
    ),

  unitAliases: () => request<{ aliases: UnitAlias[] }>("GET", "/v1/unit-aliases"),
  setUnitAlias: (unitId: string, label: string) =>
    request<{ alias: UnitAlias }>("PUT", "/v1/admin/unit-aliases", { unitId, label }),
  deleteUnitAlias: (unitId: string) =>
    request<{ ok: boolean }>("DELETE", `/v1/admin/unit-aliases/${encodeURIComponent(unitId)}`),

  // --- owner: agencies (platform tenants) --------------------------------
  listAgencies: () => request<{ agencies: Agency[] }>("GET", "/v1/owner/agencies"),
  createAgency: (input: {
    name: string;
    adminUsername: string;
    adminDisplayName: string;
    adminPassword: string;
  }) => request<{ agency: Agency; admin: AdminUser }>("POST", "/v1/owner/agencies", input),
  updateAgency: (id: number, patch: { name?: string; disabled?: boolean; regenerateRadioKey?: boolean }) =>
    request<{ agency: Agency }>("PATCH", `/v1/owner/agencies/${id}`, patch),
  deleteAgency: (id: number) => request<{ ok: boolean }>("DELETE", `/v1/owner/agencies/${id}`),

  agencyUsers: (id: number) => request<{ users: AdminUser[] }>("GET", `/v1/owner/agencies/${id}/users`),
  createAgencyUser: (
    id: number,
    input: {
      username: string;
      displayName: string;
      password: string;
      role: Role;
      unitId: string | null;
      deviceType: string | null;
    },
  ) => request<{ user: AdminUser }>("POST", `/v1/owner/agencies/${id}/users`, input),
  updateAgencyUser: (
    id: number,
    uid: number,
    patch: Partial<{
      displayName: string;
      role: Role;
      unitId: string | null;
      deviceType: string | null;
      disabled: boolean;
      password: string;
    }>,
  ) => request<{ user: AdminUser }>("PATCH", `/v1/owner/agencies/${id}/users/${uid}`, patch),
  deleteAgencyUser: (id: number, uid: number) =>
    request<{ ok: boolean }>("DELETE", `/v1/owner/agencies/${id}/users/${uid}`),

  // --- agency integrations (API keys, webhooks) ----------------------------
  getIntegrations: () => request<IntegrationsPayload>("GET", "/v1/admin/integrations"),
  getIntegrationHealth: () =>
    request<IntegrationHealthPayload>("GET", "/v1/admin/integrations/health"),
  setIntegration: (key: string, value: string) =>
    request<IntegrationsPayload>("PATCH", `/v1/admin/integrations/${encodeURIComponent(key)}`, {
      value,
    }),

  /** Read-only location-feed key for external map integrations (e.g. GateGuard). */
  getLocationKey: () =>
    request<{ location_read_key: string | null }>("GET", "/v1/admin/location-key"),
  /** Issue or rotate the key (rotating invalidates the previous one immediately). */
  rotateLocationKey: () =>
    request<{ location_read_key: string }>("POST", "/v1/admin/location-key"),
  /** Revoke the key — external map access stops, handsets are unaffected. */
  revokeLocationKey: () => request<{ ok: boolean }>("DELETE", "/v1/admin/location-key"),

  /** Latest OTA APK published for handsets (same feed the radio app polls). */
  getAndroidAppRelease: () => request<AndroidAppRelease>("GET", "/v1/app/android/version"),

  /** Android OTA history for the admin Downloads page (newest first). */
  getAndroidReleaseHistory: () =>
    request<{ releases: AndroidReleaseRecord[] }>("GET", "/v1/app/android/releases"),

  // --- custom radio tones ------------------------------------------------
  listSounds: () => request<{ sounds: AgencySound[] }>("GET", "/v1/admin/sounds"),
  deleteSound: (kind: string) =>
    request<{ ok: boolean }>("DELETE", `/v1/admin/sounds/${encodeURIComponent(kind)}`),

  // --- AI dispatcher knowledge base --------------------------------------
  listKbDocuments: () =>
    request<{
      documents: KbDocument[];
      categories: string[];
      category_sections: KbCategorySection[];
      embed_model: string;
    }>("GET", "/v1/admin/kb/documents"),
  deleteKbDocument: (id: number) =>
    request<{ ok: boolean }>("DELETE", `/v1/admin/kb/documents/${id}`),
  reindexKbDocument: (id: number) =>
    request<{ ok: boolean }>("POST", `/v1/admin/kb/documents/${id}/reindex`),

  // --- agency branding ---------------------------------------------------
  deleteAgencyLogo: () => request<{ ok: boolean }>("DELETE", "/v1/admin/agency/logo"),

  // --- radio bridges -----------------------------------------------------
  listBridges: () => request<{ bridges: Bridge[] }>("GET", "/v1/admin/bridges"),
  bridgeStatuses: () =>
    request<{ statuses: BridgeStatus[] }>("GET", "/v1/admin/bridges/status"),
  createBridge: (input: BridgeInput) => request<{ bridge: Bridge }>("POST", "/v1/admin/bridges", input),
  updateBridge: (id: number, patch: Partial<BridgeInput>) =>
    request<{ bridge: Bridge }>("PATCH", `/v1/admin/bridges/${id}`, patch),
  deleteBridge: (id: number) => request<{ ok: boolean }>("DELETE", `/v1/admin/bridges/${id}`),
  /** Talkgroups heard on Scan All that don't have a bridge yet (for the picker). */
  observedTalkgroups: () =>
    request<{ talkgroups: ObservedTalkgroup[] }>("GET", "/v1/admin/bridges/observed"),
  /** Enabled audio-device bridges this agency can run from the desktop console. */
  listRunnableBridges: () => request<{ bridges: Bridge[] }>("GET", "/v1/bridges/runnable"),

  // --- custom soundboard tone-outs ---------------------------------------
  toneOuts: () => request<{ toneOuts: ToneOut[] }>("GET", "/v1/tone-outs"),
  createToneOut: (input: {
    name: string;
    playMode: string;
    iconKind: string;
    iconColor: string;
  }) => request<{ toneOut: ToneOut }>("POST", "/v1/admin/tone-outs", input),
  updateToneOut: (
    id: number,
    patch: Partial<{ name: string; playMode: string; iconKind: string; iconColor: string }>,
  ) => request<{ toneOut: ToneOut }>("PATCH", `/v1/admin/tone-outs/${id}`, patch),
  deleteToneOut: (id: number) => request<{ ok: boolean }>("DELETE", `/v1/admin/tone-outs/${id}`),
  deleteToneOutIcon: (id: number) =>
    request<{ ok: boolean }>("DELETE", `/v1/admin/tone-outs/${id}/icon`),

  // --- simulcast channels ------------------------------------------------
  listSimulcasts: () => request<{ simulcasts: Simulcast[] }>("GET", "/v1/simulcast"),
  createSimulcast: (name: string, channelIds: number[]) =>
    request<{ simulcast: { id: number; name: string } }>("POST", "/v1/simulcast", { name, channelIds }),
  updateSimulcast: (id: number, patch: { name?: string; channelIds?: number[] }) =>
    request<{ ok: boolean }>("PUT", `/v1/simulcast/${id}`, patch),
  deleteSimulcast: (id: number) => request<{ ok: boolean }>("DELETE", `/v1/simulcast/${id}`),

  /** Analytics: agency-scoped operational aggregations. Any member. */
  getAnalyticsSummary: (range: AnalyticsRange) =>
    request<AnalyticsSummary>("GET", `/v1/analytics/summary?range=${range}`),
  getAnalyticsTimeSeries: (range: AnalyticsRange) =>
    request<{ range: AnalyticsRange; points: AnalyticsTimeSeriesPoint[] }>(
      "GET",
      `/v1/analytics/timeseries?range=${range}`,
    ),
  getAnalyticsChannels: (range: AnalyticsRange) =>
    request<{ range: AnalyticsRange; channels: AnalyticsChannelRow[] }>(
      "GET",
      `/v1/analytics/channels?range=${range}`,
    ),
  getAnalyticsUnits: (range: AnalyticsRange) =>
    request<{ range: AnalyticsRange; units: AnalyticsUnitRow[] }>(
      "GET",
      `/v1/analytics/units?range=${range}`,
    ),
  getAnalyticsAiOutcomes: (range: AnalyticsRange) =>
    request<{ range: AnalyticsRange; outcomes: AnalyticsAiOutcomeRow[] }>(
      "GET",
      `/v1/analytics/ai-dispatch?range=${range}`,
    ),

  /** Any logged-in member: read the device-oriented audio config summary
   *  (what handsets / the voice client need to mirror agency settings). */
  getAudioConfigSummary: () =>
    request<AudioConfigSummaryResponse>("GET", "/v1/audio/config"),
  /** Admin: read the current agency-wide audio config (null if never set). */
  getGlobalAudioConfig: () => request<GlobalAudioConfigResponse>("GET", "/v1/admin/audio-config"),
  /** Admin: push a new agency-wide audio config to all users and devices. */
  setGlobalAudioConfig: (config: unknown) =>
    request<GlobalAudioConfigPushResponse>("PUT", "/v1/admin/audio-config", config),

  /** Admin: list saved Audio Lab presets for the caller's agency (newest-touched first). */
  listAudioLabPresets: () =>
    request<AudioLabPresetListResponse>("GET", "/v1/admin/audio-lab-presets"),
  /** Admin: fetch the full AudioLabConfig body for one saved preset. */
  getAudioLabPreset: (name: string) =>
    request<AudioLabPresetResponse>(
      "GET",
      `/v1/admin/audio-lab-presets/${encodeURIComponent(name)}`,
    ),
  /** Admin: upsert a saved preset under the given name (body is an AudioLabConfig). */
  saveAudioLabPreset: (name: string, config: unknown) =>
    request<AudioLabPresetResponse>(
      "PUT",
      `/v1/admin/audio-lab-presets/${encodeURIComponent(name)}`,
      config,
    ),
  /** Admin: delete a saved preset by name. */
  deleteAudioLabPreset: (name: string) =>
    request<{ ok: boolean }>(
      "DELETE",
      `/v1/admin/audio-lab-presets/${encodeURIComponent(name)}`,
    ),

  /** Admin: exercise a single 10-8 CAD Incident API (v1.1.0) action and return the raw JSON. */
  ten8ApiTest: (input: { action: string; params?: Record<string, unknown> }) =>
    request<Ten8ApiTestResult>("POST", "/v1/integrations/ten8/api-test", input),
};

/** Uploads a custom agency logo (raw image body — not JSON). */
export async function uploadAgencyLogo(file: File): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": file.type || "image/png" };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  const res = await fetch("/v1/admin/agency/logo", { method: "PUT", headers, body: file });
  if (!res.ok) {
    handle401IfNeeded(res.status);
    let code = `http_${res.status}`;
    try {
      code = (JSON.parse(await res.text()) as { error?: string }).error ?? code;
    } catch {
      /* keep the generic code */
    }
    throw new ApiError(code, res.status);
  }
}

/** Uploads a custom tone for one sound kind (raw audio body — not JSON). */
export async function uploadSound(kind: string, file: File): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": file.type || "audio/wav" };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  const res = await fetch(`/v1/admin/sounds/${encodeURIComponent(kind)}`, {
    method: "PUT",
    headers,
    body: file,
  });
  if (!res.ok) {
    handle401IfNeeded(res.status);
    let code = `http_${res.status}`;
    try {
      code = (JSON.parse(await res.text()) as { error?: string }).error ?? code;
    } catch {
      /* keep the generic code */
    }
    throw new ApiError(code, res.status);
  }
}

/** Uploads a knowledge-base PDF (raw body — metadata rides on the query string). */
export async function uploadKbDocument(
  file: File,
  meta: { title: string; category: string; propertyCode?: string },
): Promise<KbDocument> {
  const headers: Record<string, string> = { "Content-Type": "application/pdf" };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  const params = new URLSearchParams({
    title: meta.title,
    category: meta.category,
    filename: file.name,
  });
  if (meta.propertyCode?.trim()) {
    params.set("property_code", meta.propertyCode.trim());
  }
  const res = await fetch(`/v1/admin/kb/documents?${params.toString()}`, {
    method: "POST",
    headers,
    body: file,
  });
  if (!res.ok) {
    handle401IfNeeded(res.status);
    let code = `http_${res.status}`;
    // Express's `raw()` middleware answers 413 with an HTML body, not JSON, so the
    // generic try/parse below would leave a useless "http_413". Map it explicitly
    // here so the UI can show "PDF too large — limit is N MB."
    if (res.status === 413) {
      code = "pdf_too_large";
    } else {
      try {
        code = (JSON.parse(await res.text()) as { error?: string }).error ?? code;
      } catch {
        /* keep the generic code */
      }
    }
    throw new ApiError(code, res.status);
  }
  return (JSON.parse(await res.text()) as { document: KbDocument }).document;
}

/** Fetches a transmission's WAV audio as a Blob (a bearer header cannot ride on <audio src>). */
export async function fetchTransmissionAudio(id: number): Promise<Blob> {
  const headers: Record<string, string> = {};
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  const res = await fetch(`/v1/transmissions/${id}/audio`, { headers });
  if (!res.ok) {
    handle401IfNeeded(res.status);
    throw new ApiError(`http_${res.status}`, res.status);
  }
  return res.blob();
}

/** Uploads a raw file body to one of the bearer-protected API endpoints. */
async function uploadRaw(path: string, file: File, fallbackType: string): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": file.type || fallbackType };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  const res = await fetch(path, { method: "PUT", headers, body: file });
  if (!res.ok) {
    handle401IfNeeded(res.status);
    let code = `http_${res.status}`;
    try {
      code = (JSON.parse(await res.text()) as { error?: string }).error ?? code;
    } catch {
      /* keep the generic code */
    }
    throw new ApiError(code, res.status);
  }
}

/** Uploads a soundboard tone-out's audio clip (raw body — not JSON). */
export function uploadToneOutAudio(id: number, file: File): Promise<void> {
  return uploadRaw(`/v1/admin/tone-outs/${id}/audio`, file, "audio/wav");
}

/** Attaches a picture to a page/alert (raw image body — not JSON). */
export function uploadAlertImage(id: number, file: File): Promise<void> {
  return uploadRaw(`/v1/alerts/${id}/image`, file, "image/jpeg");
}

/** Fetches a page/alert's picture attachment as a Blob. */
export async function fetchAlertImage(id: number): Promise<Blob> {
  const headers: Record<string, string> = {};
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  const res = await fetch(`/v1/alerts/${id}/image`, { headers });
  if (!res.ok) {
    handle401IfNeeded(res.status);
    throw new ApiError(`http_${res.status}`, res.status);
  }
  return res.blob();
}

/** Uploads a soundboard tone-out's custom icon image (raw body — not JSON). */
export function uploadToneOutIcon(id: number, file: File): Promise<void> {
  return uploadRaw(`/v1/admin/tone-outs/${id}/icon`, file, "image/png");
}

/** Fetches a tone-out's audio clip as a Blob (a bearer header cannot ride on a URL). */
export async function fetchToneOutAudio(id: number): Promise<Blob> {
  const headers: Record<string, string> = {};
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  const res = await fetch(`/v1/tone-outs/${id}/audio`, { headers });
  if (!res.ok) {
    handle401IfNeeded(res.status);
    throw new ApiError(`http_${res.status}`, res.status);
  }
  return res.blob();
}

/** Fetches a tone-out's custom icon image as a Blob. */
export async function fetchToneOutIcon(id: number): Promise<Blob> {
  const headers: Record<string, string> = {};
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  const res = await fetch(`/v1/tone-outs/${id}/icon`, { headers });
  if (!res.ok) {
    handle401IfNeeded(res.status);
    throw new ApiError(`http_${res.status}`, res.status);
  }
  return res.blob();
}

/** Human-readable copy for the API error codes the UI can surface. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const map: Record<string, string> = {
      invalid_login: "Incorrect username or password.",
      owner_use_platform_portal: "Platform owner accounts sign in without an agency code, from the Platform portal.",
      missing_credentials: "Enter a username and password.",
      missing_fields: "Fill in every required field.",
      missing_name: "Enter a name.",
      username_taken: "That username is already in use.",
      duplicate: "That name is already in use.",
      last_admin: "You cannot remove the last administrator.",
      cannot_delete_self: "You cannot delete your own account.",
      not_found: "That item no longer exists.",
      forbidden: "You do not have access to that.",
      unauthorized: "Your session expired — sign in again.",
      database_unavailable: "The database is not configured on the server.",
      bad_role: "Unknown role.",
      agency_disabled: "Your agency has been disabled. Contact your platform owner.",
      agency_suspended_billing:
        "Your free trial has ended or payment failed. Add billing in safeT Control to restore service.",
      ai_dispatch_requires_pro: "AI dispatch requires the Pro plan. Upgrade in Billing.",
      trial_already_used: "A free trial has already been used with this email address.",
      invalid_verification_code: "That verification code is invalid or expired.",
      terms_required: "You must accept the Terms of Service, Privacy Policy, and EULA.",
      billing_not_configured: "Billing is not configured on this server yet.",
      session_superseded: "Signed in on another device — sign in again here if you want to continue.",
      unit_move_locked:
        "That operator has the dispatch console open on multiple channels and cannot be moved.",
      pdf_too_large:
        "PDF is too large to upload (default limit 50 MB). Compress the file or split it before retrying.",
    };
    return map[error.message] ?? `Request failed (${error.message}).`;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}
