import type { ReactNode, SVGProps } from "react";

export type IconProps = { size?: number } & Omit<SVGProps<SVGSVGElement>, "width" | "height" | "children">;

function StrokeIcon({ size = 18, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Lightning bolt — transmit / XMIT. */
export function IconBolt({ size = 18, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...rest}>
      <path d="M13 2 5 13h5l-1 9 9-12h-5l1-8Z" />
    </svg>
  );
}

/** safeT PTT brand mark — signal bars + a T whose stem is a lightning bolt. */
export function SafetMark({ size = 24, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 96 96" aria-hidden="true" {...rest}>
      <rect x="10" y="60" width="12" height="20" rx="2.5" fill="#2563eb" />
      <rect x="26" y="49" width="12" height="31" rx="2.5" fill="#2563eb" />
      <rect x="42" y="38" width="12" height="42" rx="2.5" fill="#2563eb" />
      <rect x="40" y="12" width="46" height="12" rx="3" fill="#2563eb" />
      <path d="M67 24 L53 51 L63 51 L55 84 L80 48 L67 48 L75 24 Z" fill="#22c5e5" />
    </svg>
  );
}

/** Concentric broadcast arcs — the 10-33 channel marker. */
export function IconBeacon(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
      <path d="M7.5 7.5a6.4 6.4 0 0 0 0 9" />
      <path d="M16.5 7.5a6.4 6.4 0 0 1 0 9" />
      <path d="M4.7 4.7a10.3 10.3 0 0 0 0 14.6" />
      <path d="M19.3 4.7a10.3 10.3 0 0 1 0 14.6" />
    </StrokeIcon>
  );
}

/** Warning triangle — emergency. */
export function IconAlertTriangle(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M12 3.5 2.5 20h19L12 3.5Z" />
      <line x1="12" y1="9.5" x2="12" y2="14" />
      <circle cx="12" cy="16.8" r="0.6" fill="currentColor" stroke="none" />
    </StrokeIcon>
  );
}

/** Bell — paging. */
export function IconBell(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M6 16v-5a6 6 0 0 1 12 0v5l1.8 2H4.2L6 16Z" />
      <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
    </StrokeIcon>
  );
}

/** Handheld radio — channels. */
export function IconRadio(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <rect x="7" y="8" width="10" height="13" rx="1.6" />
      <path d="M13.5 8 16.5 3" />
      <line x1="9.5" y1="11.5" x2="14.5" y2="11.5" />
      <circle cx="12" cy="16.5" r="1.6" />
    </StrokeIcon>
  );
}

/** Door with arrow — sign out. */
export function IconLogOut(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M9 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H9" />
      <path d="M15 8.5 18.5 12 15 15.5" />
      <line x1="18.5" y1="12" x2="9" y2="12" />
    </StrokeIcon>
  );
}

/** Shield — mission control. */
export function IconShield(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M12 3.2 19 6v5.2c0 4.7-2.9 8-7 9.6-4.1-1.6-7-4.9-7-9.6V6l7-2.8Z" />
    </StrokeIcon>
  );
}

/** Sun — day theme. */
export function IconSun(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="2.5" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="21.5" />
      <line x1="2.5" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="21.5" y2="12" />
      <line x1="5.3" y1="5.3" x2="7" y2="7" />
      <line x1="17" y1="17" x2="18.7" y2="18.7" />
      <line x1="18.7" y1="5.3" x2="17" y2="7" />
      <line x1="7" y1="17" x2="5.3" y2="18.7" />
    </StrokeIcon>
  );
}

/** Crescent moon — night theme. */
export function IconMoon(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M20 13.5A8 8 0 1 1 10.5 4a6.2 6.2 0 0 0 9.5 9.5Z" />
    </StrokeIcon>
  );
}

/** Person — a connected radio / operator. */
export function IconUser(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
    </StrokeIcon>
  );
}

/** Speaker with one wave — routine tone-out. */
export function IconToneRoutine(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M4 9.5v5h3.2l4.3 3.5V6L7.2 9.5H4Z" />
      <path d="M15 9.8a4 4 0 0 1 0 4.4" />
    </StrokeIcon>
  );
}

/** Speaker with two waves — priority tone-out. */
export function IconTonePriority(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M4 9.5v5h3.2l4.3 3.5V6L7.2 9.5H4Z" />
      <path d="M14.5 10a3.4 3.4 0 0 1 0 4" />
      <path d="M17.6 7.6a7.6 7.6 0 0 1 0 8.8" />
    </StrokeIcon>
  );
}

/** Circled question mark — status-check tone-out. */
export function IconToneStatus(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.6a2.5 2.5 0 0 1 4.7 1.2c0 1.7-2.3 2-2.3 3.6" />
      <circle cx="12" cy="17.2" r="0.6" fill="currentColor" stroke="none" />
    </StrokeIcon>
  );
}

/** Octagon — stop all sounds. */
export function IconStop(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M8.6 3h6.8L21 8.6v6.8L15.4 21H8.6L3 15.4V8.6L8.6 3Z" />
      <line x1="9" y1="12" x2="15" y2="12" />
    </StrokeIcon>
  );
}

/** Headphones — monitor a channel. */
export function IconHeadphones(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
      <path d="M4 14.5a2 2 0 0 1 2-2h1v6H6a2 2 0 0 1-2-2v-2Z" fill="currentColor" />
      <path d="M20 14.5a2 2 0 0 0-2-2h-1v6h1a2 2 0 0 0 2-2v-2Z" fill="currentColor" />
    </StrokeIcon>
  );
}

/** Speaker with sound waves — channel volume. */
export function IconVolume(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M4 9v6h3l5 4V5L7 9H4Z" fill="currentColor" />
      <path d="M15.5 9.5a3.5 3.5 0 0 1 0 5" />
      <path d="M18 7a7 7 0 0 1 0 10" />
    </StrokeIcon>
  );
}

/** Speaker with a slash — muted channel. */
export function IconVolumeMuted(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M4 9v6h3l5 4V5L7 9H4Z" fill="currentColor" />
      <line x1="16" y1="9.5" x2="21" y2="14.5" />
      <line x1="21" y1="9.5" x2="16" y2="14.5" />
    </StrokeIcon>
  );
}

/** Check mark — included plan features. */
export function IconCheck(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M4.5 12.5 9.5 17.5 19.5 6.5" />
    </StrokeIcon>
  );
}

/** Arrow pointing right — call-to-action affordance. */
export function IconArrowRight(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <line x1="4" y1="12" x2="19" y2="12" />
      <path d="M13 6 19.5 12 13 18" />
    </StrokeIcon>
  );
}

/** Map pin — GPS unit location. */
export function IconMapPin(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M12 21.5c4.5-4.2 7-7.7 7-11.3a7 7 0 0 0-14 0c0 3.6 2.5 7.1 7 11.3Z" />
      <circle cx="12" cy="10" r="2.6" />
    </StrokeIcon>
  );
}

/** Four-panel dashboard grid. */
export function IconDashboard(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="8" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" />
    </StrokeIcon>
  );
}

/** Gear — settings / admin. */
export function IconSettings(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.8v2.2M12 19v2.2M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M2.8 12h2.2M19 12h2.2M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6" />
    </StrokeIcon>
  );
}

/** Sparkle — AI / assistant. */
export function IconAi(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M12 3.5 13.8 8.2 18.5 10 13.8 11.8 12 16.5 10.2 11.8 5.5 10 10.2 8.2Z" />
      <path d="M5 5.5l.9 2.1 2.1.9-2.1.9L5 11.5l-.9-2.1-2.1-.9 2.1-.9Z" />
      <path d="M18.5 14.5l.7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7Z" />
    </StrokeIcon>
  );
}

/** In-car / cruiser radio unit. */
export function IconCar(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M3 14.5v-2l2.5-2 3-4.5h7l2.5 4.5 2.5 2v2" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="10" y1="6" x2="10" y2="12" />
      <rect x="9" y="4.5" width="4" height="2" rx="0.5" />
      <circle cx="7.5" cy="14.5" r="2" />
      <circle cx="16.5" cy="14.5" r="2" />
    </StrokeIcon>
  );
}

/** Smartphone — mobile radio app. */
export function IconMobile(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <rect x="7" y="3" width="10" height="18" rx="2" />
      <line x1="10" y1="6" x2="14" y2="6" />
      <circle cx="12" cy="17" r="0.8" fill="currentColor" stroke="none" />
    </StrokeIcon>
  );
}

/** Record dot — live control / recording. */
export function IconRecord(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" />
    </StrokeIcon>
  );
}

/** Play triangle — replay transmission audio. */
export function IconPlay(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M9 6.5v11l9-5.5-9-5.5Z" fill="currentColor" stroke="none" />
    </StrokeIcon>
  );
}

/** Pause bars — pause replay. */
export function IconPause(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <line x1="9" y1="6" x2="9" y2="18" />
      <line x1="15" y1="6" x2="15" y2="18" />
    </StrokeIcon>
  );
}

/** Waveform — recording & transcription. */
export function IconWaveform(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <line x1="4" y1="11" x2="4" y2="13" />
      <line x1="8" y1="8" x2="8" y2="16" />
      <line x1="12" y1="4" x2="12" y2="20" />
      <line x1="16" y1="8" x2="16" y2="16" />
      <line x1="20" y1="11" x2="20" y2="13" />
    </StrokeIcon>
  );
}

/** Padlock — encrypted voice. */
export function IconLock(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
      <circle cx="12" cy="15.2" r="0.7" fill="currentColor" stroke="none" />
    </StrokeIcon>
  );
}

/** Built-in glyphs an admin can assign to a custom soundboard tone-out. */
export const TONE_OUT_ICON_KINDS = [
  "waveform",
  "bell",
  "beacon",
  "alert",
  "bolt",
  "routine",
  "priority",
  "status",
  "radio",
  "headphones",
] as const;

export type ToneOutIconKind = (typeof TONE_OUT_ICON_KINDS)[number];

const TONE_OUT_ICON_MAP: Record<ToneOutIconKind, (props: IconProps) => ReactNode> = {
  waveform: IconWaveform,
  bell: IconBell,
  beacon: IconBeacon,
  alert: IconAlertTriangle,
  bolt: IconBolt,
  routine: IconToneRoutine,
  priority: IconTonePriority,
  status: IconToneStatus,
  radio: IconRadio,
  headphones: IconHeadphones,
};

/** Renders one built-in soundboard glyph by its kind, falling back to a waveform. */
export function ToneOutIcon({ kind, ...props }: { kind: string } & IconProps) {
  const Icon = TONE_OUT_ICON_MAP[kind as ToneOutIconKind] ?? IconWaveform;
  return <Icon {...props} />;
}
