import React, { useEffect, useState } from "react";
import { continueRender, delayRender, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

export interface Brand {
  colors: { text: string; highlight: string; emphasis: string; outline: string; box: string };
  fonts: { heading: string; body: string };
}

export interface GraphicProps {
  brand: Brand;
  [k: string]: any;
}

/** Font stacks: browser falls back glyph by glyph, so Hindi and Punjabi text just work. */
export const FONT_HEADING = "'VS Heading', 'VS Deva', 'VS Guru', 'Apple Color Emoji', 'Noto Color Emoji', sans-serif";
export const FONT_BODY = "'VS Body', 'VS Deva', 'VS Guru', 'Apple Color Emoji', 'Noto Color Emoji', sans-serif";

const FONTS: Array<[string, string]> = [
  ["VS Heading", "fonts/Anton-Regular.ttf"],
  ["VS Body", "fonts/Poppins-ExtraBold.ttf"],
  ["VS Deva", "fonts/Mukta-ExtraBold.ttf"],
  ["VS Guru", "fonts/MuktaMahee-ExtraBold.ttf"],
];

let fontsPromise: Promise<void> | null = null;
function loadFonts(): Promise<void> {
  if (!fontsPromise) {
    fontsPromise = Promise.all(
      FONTS.map(async ([family, file]) => {
        try {
          const face = new FontFace(family, `url(${staticFile(file)})`);
          await face.load();
          (document.fonts as any).add(face);
        } catch {
          /* missing font: fall back */
        }
      }),
    ).then(() => undefined);
  }
  return fontsPromise;
}

export const FontGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [handle] = useState(() => delayRender("fonts"));
  const [ready, setReady] = useState(false);
  useEffect(() => {
    loadFonts().then(() => {
      setReady(true);
      continueRender(handle);
    });
  }, [handle]);
  return ready ? <>{children}</> : null;
};

/** 0→1 entrance spring and 1→0 exit over the last frames. */
export function useInOut(exitFrames = 8) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 14, stiffness: 160, mass: 0.8 } });
  const exit = interpolate(frame, [durationInFrames - exitFrames, durationInFrames - 1], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return { frame, fps, durationInFrames, enter, exit, alive: Math.min(enter, 1) * exit };
}

export function useDims() {
  const { width, height } = useVideoConfig();
  return { width, height, min: Math.min(width, height) };
}

export const outline = (px: number, color = "#000") =>
  `${color} ${px}px 0, ${color} -${px}px 0, ${color} 0 ${px}px, ${color} 0 -${px}px, ${color} ${px}px ${px}px, ${color} -${px}px -${px}px, ${color} ${px}px -${px}px, ${color} -${px}px ${px}px, rgba(0,0,0,0.45) 0 ${px * 2}px ${px * 3}px`;

/** Vertical placement. "bottom" sits above the caption zone (captions occupy roughly 20–35% from the bottom on vertical video). */
export const posStyle = (position: "top" | "center" | "bottom", height: number, width?: number): React.CSSProperties => {
  const vertical = width === undefined ? true : height > width * 1.05;
  return position === "top"
    ? { justifyContent: "flex-start", paddingTop: height * (vertical ? 0.16 : 0.08) }
    : position === "bottom"
      ? { justifyContent: "flex-end", paddingBottom: height * (vertical ? 0.42 : 0.2) }
      : { justifyContent: "center" };
};

/** Deterministic pseudo-random numbers (renders must be identical every time). */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}
