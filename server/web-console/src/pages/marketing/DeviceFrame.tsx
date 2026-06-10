interface DeviceFrameProps {
  variant: "phone" | "browser";
  src: string;
  alt: string;
}

export function DeviceFrame({ variant, src, alt }: DeviceFrameProps) {
  return (
    <div className={`device-frame device-frame-${variant}`}>
      <div className="device-frame-chrome" aria-hidden="true">
        {variant === "browser" ? (
          <>
            <span />
            <span />
            <span />
          </>
        ) : (
          <span className="device-frame-notch" />
        )}
      </div>
      <img src={src} alt={alt} loading="lazy" className="device-frame-shot" />
    </div>
  );
}
