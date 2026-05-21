import { useEffect, useRef } from "react";

interface WaveformProps {
  /** Returns the current 0–1 audio amplitude to plot. */
  getLevel: () => number;
  /** Animate while true; render a flat idle baseline when false. */
  active: boolean;
  /** "tx" tints the bars red (talking), "rx" tints them with the accent (listening). */
  variant: "tx" | "rx";
  /** Number of bars across the strip. */
  bars?: number;
  height?: number;
}

/**
 * A live push-to-talk waveform: a scrolling row of bars whose heights follow the
 * recent audio amplitude. Driven by requestAnimationFrame only while `active`, so
 * idle channels cost nothing.
 */
export function Waveform({ getLevel, active, variant, bars = 28, height = 30 }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Latest getLevel without restarting the rAF loop when the parent re-renders.
  const levelRef = useRef(getLevel);
  levelRef.current = getLevel;
  const valuesRef = useRef<number[]>(new Array(bars).fill(0));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    const accent = variant === "tx" ? "#ef4444" : "#38bdf8";
    let raf = 0;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth || 1;
      const cssH = height;
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const values = valuesRef.current;
      const gap = 2;
      const barW = Math.max(1, (cssW - gap * (bars - 1)) / bars);
      const mid = cssH / 2;

      for (let i = 0; i < bars; i++) {
        // Light easing curve so quiet speech still shows movement.
        const amp = Math.min(1, Math.pow(values[i], 0.6) * 1.6);
        const barH = active ? Math.max(2, amp * (cssH - 2)) : 2;
        const x = i * (barW + gap);
        ctx.fillStyle = accent;
        ctx.globalAlpha = active ? 0.35 + 0.65 * (i / bars) : 0.25;
        const r = Math.min(barW / 2, 2);
        const y = mid - barH / 2;
        // Rounded bar.
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + barW, y, x + barW, y + barH, r);
        ctx.arcTo(x + barW, y + barH, x, y + barH, r);
        ctx.arcTo(x, y + barH, x, y, r);
        ctx.arcTo(x, y, x + barW, y, r);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    if (!active) {
      // Decay to flat, draw once, and stop the loop.
      valuesRef.current = valuesRef.current.map(() => 0);
      draw();
      return;
    }

    const tick = () => {
      const values = valuesRef.current;
      values.shift();
      values.push(levelRef.current());
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, variant, bars, height]);

  return (
    <canvas
      ref={canvasRef}
      className="waveform"
      style={{ width: "100%", height }}
      aria-hidden="true"
    />
  );
}
