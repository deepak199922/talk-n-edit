import React from "react";
import { AbsoluteFill, Composition, Sequence } from "remotion";
import { FontGate, GraphicProps } from "./shared";

export type Registry = Record<string, React.FC<any>>;

interface InputProps {
  component: string;
  props: Record<string, any>;
  brand: GraphicProps["brand"];
  width: number;
  height: number;
  fps: number;
  frames: number;
}

interface StackProps {
  layers: Array<{ component: string; props: Record<string, any>; from: number; frames: number }>;
  brand: GraphicProps["brand"];
  width: number;
  height: number;
  fps: number;
  frames: number;
}

/** One composition that renders any registered graphic; size and length come from the input props. */
export function makeRoot(registry: Registry): React.FC {
  const Graphic: React.FC<InputProps> = ({ component, props, brand }) => {
    const C = registry[component];
    if (!C) throw new Error(`Unknown graphic component: ${component}`);
    return (
      <AbsoluteFill style={{ backgroundColor: "transparent" }}>
        <FontGate>
          <C {...props} brand={brand} />
        </FontGate>
      </AbsoluteFill>
    );
  };
  // Several graphics drawn together in one pass (same pixels as drawing them one by one and stacking them in order).
  // Inside a Sequence, useCurrentFrame and useVideoConfig().durationInFrames are the layer's own, as in "Graphic".
  const Stack: React.FC<StackProps> = ({ layers, brand }) => (
    <AbsoluteFill style={{ backgroundColor: "transparent" }}>
      <FontGate>
        {layers.map((l, i) => {
          const C = registry[l.component];
          if (!C) throw new Error(`Unknown graphic component: ${l.component}`);
          return (
            <Sequence key={i} from={l.from} durationInFrames={Math.max(1, l.frames)}>
              <AbsoluteFill style={{ backgroundColor: "transparent" }}>
                <C {...l.props} brand={brand} />
              </AbsoluteFill>
            </Sequence>
          );
        })}
      </FontGate>
    </AbsoluteFill>
  );
  return () => (
    <>
    <Composition
      id="Graphic"
      component={Graphic as any}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={60}
      defaultProps={{ component: "AnimatedTitle", props: { text: "Preview" }, brand: { colors: { text: "#FFFFFF", highlight: "#FFD60A", emphasis: "#FFD60A", outline: "#000000", box: "#000000" }, fonts: { heading: "Anton", body: "Poppins" } }, width: 1080, height: 1920, fps: 30, frames: 60 } as any}
      calculateMetadata={({ props }: { props: InputProps }) => ({ width: props.width, height: props.height, fps: props.fps, durationInFrames: Math.max(1, props.frames) })}
    />
    <Composition
      id="Stack"
      component={Stack as any}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={60}
      defaultProps={{ layers: [], brand: { colors: { text: "#FFFFFF", highlight: "#FFD60A", emphasis: "#FFD60A", outline: "#000000", box: "#000000" }, fonts: { heading: "Anton", body: "Poppins" } }, width: 1080, height: 1920, fps: 30, frames: 60 } as any}
      calculateMetadata={({ props }: { props: StackProps }) => ({ width: props.width, height: props.height, fps: props.fps, durationInFrames: Math.max(1, props.frames) })}
    />
    </>
  );
}
