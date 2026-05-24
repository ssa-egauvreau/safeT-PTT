import type { ReactNode } from "react";
import type { PresenceStatus } from "../api";
import { IconAlertTriangle, IconBolt, IconCar, IconMobile, type IconProps } from "../icons";

/** Accessible label for each presence status (icon-only in the UI). */
export const PRESENCE_LABEL: Record<PresenceStatus, string> = {
  idle: "Idle",
  transmitting: "On air",
  driving: "Driving",
  emergency: "Emergency",
};

const PRESENCE_ICON: Record<PresenceStatus, (props: IconProps) => ReactNode> = {
  idle: IconPauseCircle,
  transmitting: IconBolt,
  driving: IconCar,
  emergency: IconAlertTriangle,
};

/** Platform label for tooltips on client icons. */
export const CLIENT_PLATFORM_LABEL: Record<string, string> = {
  android: "Android",
  ios: "iOS",
  web: "Web browser",
  desktop: "Desktop",
  bridge: "Bridge",
  windows: "Windows",
};

function clientIcon(client: string): ((props: IconProps) => ReactNode) | null {
  switch (client) {
    case "android":
      return IconAndroid;
    case "ios":
      return IconApple;
    case "web":
      return IconGlobe;
    case "desktop":
    case "windows":
      return IconDesktop;
    case "bridge":
      return IconBridge;
    default:
      return client.includes("mobile") || client.includes("phone") ? IconMobile : null;
  }
}

/** Status icon with colour class (replaces text chips like "Idle" / "Driving"). */
export function PresenceStatusBadge({
  status,
  size = 14,
  className = "",
}: {
  status: PresenceStatus;
  size?: number;
  className?: string;
}) {
  const label = PRESENCE_LABEL[status];
  const Icon = PRESENCE_ICON[status];
  return (
    <span
      className={`roster-status-icon ${status}${className ? ` ${className}` : ""}`}
      title={label}
      aria-label={label}
      role="img"
    >
      <Icon size={size} />
    </span>
  );
}

/** Client platform icon (Android, Apple, Windows/desktop, web, …). */
export function ClientPlatformBadge({
  client,
  size = 13,
  className = "",
}: {
  client: string;
  size?: number;
  className?: string;
}) {
  const Icon = clientIcon(client);
  if (!Icon) {
    return null;
  }
  const label = CLIENT_PLATFORM_LABEL[client] ?? client;
  return (
    <span
      className={`roster-client-icon${className ? ` ${className}` : ""}`}
      title={label}
      aria-label={label}
      role="img"
    >
      <Icon size={size} />
    </span>
  );
}

/** Simplified Android robot head (brand-neutral geometric mark). */
export function IconAndroid(props: IconProps) {
  return (
    <svg width={props.size ?? 18} height={props.size ?? 18} viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        fill="currentColor"
        d="M8.2 4.8a1.2 1.2 0 0 1 2.2-.8l.4.8h2.4l.4-.8a1.2 1.2 0 1 1 2.2.8l-.5 1H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7.8a2 2 0 0 1 2-2h.7l-.5-1ZM7 10.5h10v6.5H7V10.5Zm2.2-1.8a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8Zm5.6 0a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8Z"
      />
    </svg>
  );
}

/** Apple mark — simple silhouette for iOS handsets. */
export function IconApple(props: IconProps) {
  return (
    <svg width={props.size ?? 18} height={props.size ?? 18} viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        fill="currentColor"
        d="M16.2 3.2c.1 1.4-.4 2.8-1.3 3.9-.9 1.1-2.4 2-3.8 1.9-.1-1.3.5-2.6 1.3-3.6.9-1.1 2.4-1.9 3.8-2.2ZM16.4 7.4c2.2.1 3.8 1.3 4.8 1.3 1 0 2.5-1.2 4.1-1.1 2.1.1 3.6 1.2 4.6 3-4 2.3-3.3 8.3.6 10.4-.9 1.3-2 2.6-3.4 2.5-1.3-.1-1.8-.8-3.4-.8-1.6 0-2.1.8-3.4.8-1.4 0-2.5-1.1-3.4-2.4 2.9-1.6 3.4-5.8.6-7.7Z"
      />
    </svg>
  );
}

/** Desktop / Windows-style monitor. */
export function IconDesktop(props: IconProps) {
  return (
    <svg width={props.size ?? 18} height={props.size ?? 18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <rect x="3" y="4" width="18" height="12" rx="1.6" />
      <path d="M8 20h8M12 16v4" />
      <rect x="7" y="8" width="4" height="4" rx="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Globe — web console. */
export function IconGlobe(props: IconProps) {
  return (
    <svg width={props.size ?? 18} height={props.size ?? 18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </svg>
  );
}

/** Link — bridge / relay client. */
export function IconBridge(props: IconProps) {
  return (
    <svg width={props.size ?? 18} height={props.size ?? 18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M4 12h6M14 12h6M10 8l4 4-4 4" />
    </svg>
  );
}

/** Circle with pause bars — standby / idle. */
export function IconPauseCircle(props: IconProps) {
  return (
    <svg width={props.size ?? 18} height={props.size ?? 18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="9" />
      <line x1="10" y1="9" x2="10" y2="15" />
      <line x1="14" y1="9" x2="14" y2="15" />
    </svg>
  );
}
