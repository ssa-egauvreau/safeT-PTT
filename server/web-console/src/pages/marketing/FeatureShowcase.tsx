import { DeviceFrame } from "./DeviceFrame";

interface FeatureShowcaseProps {
  kicker?: string;
  title: string;
  body: string;
  bullets?: string[];
  imageSrc: string;
  imageAlt: string;
  variant?: "phone" | "browser";
  reverse?: boolean;
}

export function FeatureShowcase({
  kicker,
  title,
  body,
  bullets,
  imageSrc,
  imageAlt,
  variant = "browser",
  reverse,
}: FeatureShowcaseProps) {
  return (
    <section className={`feature-showcase${reverse ? " feature-showcase-reverse" : ""}`}>
      <div className="feature-showcase-copy">
        {kicker && <span className="lp-kicker">{kicker}</span>}
        <h2>{title}</h2>
        <p>{body}</p>
        {bullets && bullets.length > 0 && (
          <ul className="feature-showcase-bullets">
            {bullets.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        )}
      </div>
      <div className={`feature-showcase-visual feature-showcase-visual--${variant}`}>
        <DeviceFrame variant={variant} src={imageSrc} alt={imageAlt} />
      </div>
    </section>
  );
}
