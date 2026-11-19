import React from "react";
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_BODY, FONT_HEADING, GraphicProps, outline, posStyle, rng, useDims, useInOut } from "./shared";

const SIZE = { s: 0.06, m: 0.08, l: 0.1, xl: 0.13 } as const;

// ------------------------------------------------------------------ AnimatedTitle
export const AnimatedTitle: React.FC<GraphicProps> = ({ text, style = "pop", position = "center", size = "l", color, accent, uppercase = true, brand }) => {
  const { frame, fps, durationInFrames, enter, exit } = useInOut();
  const { width, height, min } = useDims();
  const fs = SIZE[size as keyof typeof SIZE] * min;
  const col = color ?? brand.colors.text;
  const acc = accent ?? brand.colors.highlight;
  const shown: string = uppercase ? String(text).toLocaleUpperCase() : String(text);
  const base: React.CSSProperties = {
    fontFamily: FONT_HEADING,
    fontSize: fs,
    lineHeight: 1.05,
    color: col,
    textAlign: "center",
    maxWidth: width * 0.86,
    textShadow: outline(Math.max(2, fs * 0.05)),
    letterSpacing: fs * 0.01,
  };
  let content: React.ReactNode = shown;
  let wrap: React.CSSProperties = {};
  if (style === "pop") {
    wrap = { transform: `scale(${0.4 + 0.6 * enter}) rotate(${interpolate(enter, [0, 1], [-6, 0])}deg)`, opacity: Math.min(1, enter * 2) * exit };
  } else if (style === "slide-up") {
    const y = interpolate(enter, [0, 1], [height * 0.08, 0]);
    wrap = { transform: `translateY(${y}px)`, opacity: enter * exit };
  } else if (style === "typewriter") {
    const n = Math.round(interpolate(frame, [0, durationInFrames * 0.55], [0, shown.length], { extrapolateRight: "clamp" }));
    const caret = frame % Math.round(fps / 2) < fps / 4 ? "|" : " ";
    content = (
      <span>
        {[...shown].slice(0, n).join("")}
        <span style={{ color: acc }}>{n < shown.length || frame < durationInFrames * 0.8 ? caret : ""}</span>
      </span>
    );
    wrap = { opacity: exit };
  } else if (style === "bounce") {
    const words = shown.split(" ");
    content = words.map((w, i) => {
      const s = spring({ frame: frame - i * 4, fps, config: { damping: 9, stiffness: 180 } });
      return (
        <span key={i} style={{ display: "inline-block", transform: `translateY(${(1 - s) * -height * 0.12}px)`, opacity: s > 0.01 ? 1 : 0, marginRight: fs * 0.25 }}>
          {w}
        </span>
      );
    });
    wrap = { opacity: exit };
  } else if (style === "glitch") {
    const g = frame < 14 ? (rng(frame + 7)() - 0.5) * fs * 0.3 : 0;
    content = (
      <span style={{ position: "relative", display: "inline-block" }}>
        <span style={{ position: "absolute", left: g, top: 0, color: "#00E5FF", opacity: frame < 14 ? 0.8 : 0, textShadow: "none" }}>{shown}</span>
        <span style={{ position: "absolute", left: -g, top: 0, color: "#FF2D55", opacity: frame < 14 ? 0.8 : 0, textShadow: "none" }}>{shown}</span>
        <span style={{ position: "relative" }}>{shown}</span>
      </span>
    );
    wrap = { opacity: (frame < 3 ? 0 : 1) * exit, transform: `skewX(${frame < 14 ? g * 0.05 : 0}deg)` };
  } else if (style === "highlight") {
    const sweep = interpolate(frame, [4, 4 + fps * 0.5], [0, 100], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
    content = (
      <span style={{ position: "relative", display: "inline-block", padding: `0 ${fs * 0.2}px` }}>
        <span style={{ position: "absolute", left: 0, top: "18%", height: "70%", width: `${sweep}%`, background: acc, borderRadius: fs * 0.12, zIndex: 0 }} />
        <span style={{ position: "relative", zIndex: 1, color: col }}>{shown}</span>
      </span>
    );
    wrap = { opacity: Math.min(1, enter * 2) * exit };
  }
  return (
    <AbsoluteFill style={{ alignItems: "center", ...posStyle(position, height, width) }}>
      <div style={{ ...base, ...wrap }}>{content}</div>
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------------ Emoji
export const Emoji: React.FC<GraphicProps> = ({ emoji, animation = "pop", x = 0.75, y = 0.3, size = 0.22 }) => {
  const { frame, fps, enter, exit } = useInOut(6);
  const { width, height } = useDims();
  let tr = "";
  if (animation === "pop") tr = `scale(${enter})`;
  if (animation === "float") tr = `translateY(${Math.sin(frame / fps * 3) * height * 0.015 - (1 - enter) * height * 0.05}px)`;
  if (animation === "shake") tr = `scale(${enter}) rotate(${Math.sin(frame * 1.6) * 14}deg)`;
  if (animation === "spin") tr = `scale(${enter}) rotate(${frame * 9}deg)`;
  if (animation === "pulse") tr = `scale(${enter * (1 + 0.12 * Math.sin(frame / fps * 10))})`;
  const fs = size * width;
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: x * width - fs / 2, top: y * height - fs / 2, width: fs, height: fs, fontSize: fs * 0.85, lineHeight: `${fs}px`, textAlign: "center", transform: tr, opacity: exit, fontFamily: "'Apple Color Emoji','Noto Color Emoji',sans-serif", filter: "drop-shadow(0 8px 14px rgba(0,0,0,0.35))" }}>
        {emoji}
      </div>
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------------ Arrow
export const Arrow: React.FC<GraphicProps> = ({ from, to, label, color = "#FFD60A", curve = 0.25, brand }) => {
  const { frame, fps, enter, exit } = useInOut(6);
  const { width, height, min } = useDims();
  const x1 = from.x * width, y1 = from.y * height, x2 = to.x * width, y2 = to.y * height;
  const mx = (x1 + x2) / 2 - (y2 - y1) * curve;
  const my = (y1 + y2) / 2 + (x2 - x1) * curve;
  const d = `M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}`;
  const len = Math.hypot(x2 - x1, y2 - y1) * 1.25;
  const draw = interpolate(frame, [0, fps * 0.5], [0, 1], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const ang = Math.atan2(y2 - my, x2 - mx);
  const hl = min * 0.045;
  const sw = min * 0.014;
  const head = `M ${x2} ${y2} L ${x2 - hl * Math.cos(ang - 0.5)} ${y2 - hl * Math.sin(ang - 0.5)} M ${x2} ${y2} L ${x2 - hl * Math.cos(ang + 0.5)} ${y2 - hl * Math.sin(ang + 0.5)}`;
  return (
    <AbsoluteFill style={{ opacity: exit }}>
      <svg width={width} height={height} style={{ position: "absolute", filter: "drop-shadow(0 4px 6px rgba(0,0,0,0.5))" }}>
        <path d={d} stroke={color} strokeWidth={sw} fill="none" strokeLinecap="round" strokeDasharray={len} strokeDashoffset={len * (1 - draw)} />
        {draw > 0.95 && <path d={head} stroke={color} strokeWidth={sw} fill="none" strokeLinecap="round" />}
      </svg>
      {label && (
        <div style={{ position: "absolute", left: x1, top: y1, transform: `translate(-50%, -120%) scale(${enter})`, fontFamily: FONT_BODY, fontSize: min * 0.045, color: "#000", background: color, padding: `${min * 0.01}px ${min * 0.022}px`, borderRadius: min * 0.015, whiteSpace: "nowrap" }}>
          {label}
        </div>
      )}
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------------ Callout
export const Callout: React.FC<GraphicProps> = ({ rect, shape = "box", label, color = "#FFD60A", dimOutside = false }) => {
  const { frame, fps, enter, exit } = useInOut(6);
  const { width, height, min } = useDims();
  const x = rect.x * width, y = rect.y * height, w = rect.w * width, h = rect.h * height;
  const draw = interpolate(frame, [0, fps * 0.45], [0, 1], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const sw = min * 0.01;
  const per = shape === "circle" ? Math.PI * (w + h) / 2 * 1.05 : 2 * (w + h);
  return (
    <AbsoluteFill style={{ opacity: exit }}>
      <svg width={width} height={height} style={{ position: "absolute" }}>
        {dimOutside && (
          <>
            <defs>
              <mask id="hole">
                <rect width={width} height={height} fill="white" />
                {shape === "circle" ? <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} fill="black" /> : <rect x={x} y={y} width={w} height={h} rx={min * 0.02} fill="black" />}
              </mask>
            </defs>
            <rect width={width} height={height} fill={`rgba(0,0,0,${0.55 * draw})`} mask="url(#hole)" />
          </>
        )}
        {shape === "circle" ? (
          <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} stroke={color} strokeWidth={sw} fill="none" strokeDasharray={per} strokeDashoffset={per * (1 - draw)} />
        ) : (
          <rect x={x} y={y} width={w} height={h} rx={min * 0.02} stroke={color} strokeWidth={sw} fill="none" strokeDasharray={per} strokeDashoffset={per * (1 - draw)} />
        )}
      </svg>
      {label && (
        <div style={{ position: "absolute", left: x + w / 2, top: y, transform: `translate(-50%, -125%) scale(${enter})`, fontFamily: FONT_BODY, fontSize: min * 0.045, color: "#000", background: color, padding: `${min * 0.01}px ${min * 0.022}px`, borderRadius: min * 0.015, whiteSpace: "nowrap" }}>
          {label}
        </div>
      )}
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------------ CountUp
export const CountUp: React.FC<GraphicProps> = ({ from = 0, to, prefix = "", suffix = "", decimals = 0, locale = "en-IN", label, position = "center", color, brand }) => {
  const { frame, durationInFrames, enter, exit } = useInOut();
  const { width, height, min } = useDims();
  const p = interpolate(frame, [0, durationInFrames * 0.7], [0, 1], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const v = from + (to - from) * p;
  const txt = new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(v);
  const bump = p >= 1 ? 1 + 0.08 * Math.max(0, 1 - (frame - durationInFrames * 0.7) / 8) : 1;
  const fs = min * 0.14;
  return (
    <AbsoluteFill style={{ alignItems: "center", ...posStyle(position, height, width), opacity: exit }}>
      {label && <div style={{ fontFamily: FONT_BODY, fontSize: fs * 0.32, color: brand.colors.text, textShadow: outline(3), marginBottom: fs * 0.1, transform: `scale(${enter})` }}>{label}</div>}
      <div style={{ fontFamily: FONT_HEADING, fontSize: fs, color: color ?? brand.colors.highlight, textShadow: outline(fs * 0.04), transform: `scale(${enter * bump})`, fontVariantNumeric: "tabular-nums" }}>
        {prefix}
        {txt}
        {suffix}
      </div>
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------------ ProgressBar
export const ProgressBar: React.FC<GraphicProps> = ({ position = "top", color, thickness = 0.008, brand }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const { width, height } = useDims();
  const h = Math.max(4, thickness * height);
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: 0, [position === "top" ? "top" : "bottom"]: 0, width: width * (frame / Math.max(1, durationInFrames - 1)), height: h, background: color ?? brand.colors.highlight, boxShadow: "0 0 8px rgba(0,0,0,0.4)" }} />
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------------ FollowCTA
const PLATFORM_BG: Record<string, string> = {
  instagram: "linear-gradient(45deg, #F58529, #DD2A7B 50%, #8134AF 75%, #515BD4)",
  youtube: "#FF0000",
  tiktok: "#111111",
  generic: "#2563EB",
};
export const FollowCTA: React.FC<GraphicProps> = ({ text = "Follow", handle, platform = "instagram", position = "bottom" }) => {
  const { frame, fps, durationInFrames, enter, exit } = useInOut();
  const { width, height, min } = useDims();
  const tap = Math.round(durationInFrames * 0.45);
  const pressed = frame >= tap && frame < tap + 5;
  const done = frame >= tap + 3;
  const hand = interpolate(frame, [tap - fps * 0.4, tap], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const fs = min * 0.055;
  const label = done ? (platform === "youtube" ? "Subscribed ✓" : "Following ✓") : platform === "youtube" ? "Subscribe" : text;
  return (
    <AbsoluteFill style={{ alignItems: "center", ...posStyle(position, height, width), opacity: exit }}>
      <div style={{ position: "relative", transform: `scale(${enter * (pressed ? 0.92 : 1)})` }}>
        <div style={{ fontFamily: FONT_BODY, fontSize: fs, color: "#fff", background: done ? "#3A3A3C" : PLATFORM_BG[platform], padding: `${fs * 0.45}px ${fs * 1.1}px`, borderRadius: fs * 2, boxShadow: "0 10px 24px rgba(0,0,0,0.35)", whiteSpace: "nowrap" }}>
          {label}
        </div>
        {handle && <div style={{ fontFamily: FONT_BODY, fontSize: fs * 0.6, color: "#fff", textAlign: "center", marginTop: fs * 0.3, textShadow: outline(2) }}>{handle}</div>}
        <div style={{ position: "absolute", right: -fs * 0.6, top: fs * 0.6, fontSize: fs * 1.4, transform: `translate(${hand * fs}px, ${hand * fs}px)`, opacity: frame < tap + fps * 0.5 ? 1 : 0, fontFamily: "'Apple Color Emoji','Noto Color Emoji'" }}>
          👆
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------------ Confetti
export const Confetti: React.FC<GraphicProps> = ({ count = 120, colors, origin = { x: 0.5, y: 0.6 }, brand }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const { width, height, min } = useDims();
  const palette: string[] = colors ?? [brand.colors.highlight, "#FF2D55", "#34C759", "#0A84FF", "#FFFFFF", "#AF52DE"];
  const r = rng(42);
  const t = frame / fps;
  const fade = interpolate(frame, [durationInFrames - 10, durationInFrames - 1], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const parts = Array.from({ length: count }, (_, i) => {
    const ang = -Math.PI / 2 + (r() - 0.5) * Math.PI * 1.2;
    const sp = (0.6 + r() * 0.9) * height;
    const x = origin.x * width + Math.cos(ang) * sp * t;
    const y = origin.y * height + Math.sin(ang) * sp * t + 0.5 * height * 1.6 * t * t;
    const s = min * (0.012 + r() * 0.014);
    return <div key={i} style={{ position: "absolute", left: x, top: y, width: s, height: s * (0.4 + r()), background: palette[i % palette.length], transform: `rotate(${(r() * 720 * t + i * 30) % 360}deg)`, borderRadius: r() > 0.7 ? s : 2 }} />;
  });
  return <AbsoluteFill style={{ opacity: fade }}>{parts}</AbsoluteFill>;
};

// ------------------------------------------------------------------ Checklist
export const Checklist: React.FC<GraphicProps> = ({ title, items = [], position = "center", brand }) => {
  const { frame, fps, durationInFrames, enter, exit } = useInOut();
  const { width, height, min } = useDims();
  const fs = min * 0.05;
  const step = Math.max(6, Math.floor((durationInFrames * 0.6) / Math.max(1, items.length)));
  return (
    <AbsoluteFill style={{ alignItems: "center", ...posStyle(position, height, width), opacity: exit }}>
      <div style={{ background: "rgba(0,0,0,0.62)", borderRadius: fs * 0.5, padding: `${fs * 0.7}px ${fs * 0.9}px`, minWidth: width * 0.6, transform: `scale(${enter})` }}>
        {title && <div style={{ fontFamily: FONT_HEADING, fontSize: fs * 1.15, color: brand.colors.highlight, marginBottom: fs * 0.4 }}>{title}</div>}
        {items.map((it: string, i: number) => {
          const s = spring({ frame: frame - fps * 0.3 - i * step, fps, config: { damping: 14 } });
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: fs * 0.5, fontFamily: FONT_BODY, fontSize: fs, color: "#fff", margin: `${fs * 0.25}px 0`, opacity: s, transform: `translateX(${(1 - s) * -fs * 2}px)` }}>
              <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: fs * 1.1, height: fs * 1.1, borderRadius: fs * 0.25, background: s > 0.6 ? "#34C759" : "rgba(255,255,255,0.2)", fontSize: fs * 0.8 }}>
                {s > 0.6 ? "✓" : ""}
              </span>
              {it}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
