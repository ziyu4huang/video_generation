/**
 * Root.tsx — Composition registration + calculateMetadata.
 *
 * The composition id is `Explainer` (what the renderer's `--props` target). Its
 * duration is derived from the longest cut's out_seconds (+1s tail padding for
 * the final fade). Width/height/fps come from the props (`width`,`height`,`fps`)
 * so the orchestrator controls the delivery frame.
 */
import { Composition, type CalculateMetadataFunction } from "remotion";
import { Explainer, type ExplainerProps } from "./Explainer";

const calculateMetadata: CalculateMetadataFunction<ExplainerProps> = async ({ props }) => {
  const cuts = props.cuts ?? [];
  const lastEnd = cuts.length > 0 ? Math.max(...cuts.map((c) => c.out_seconds || 0)) : 0;
  const durationInFrames = Math.max(1, Math.ceil((lastEnd + 1) * (props.fps ?? 30)));
  return {
    durationInFrames,
    fps: props.fps ?? 30,
    width: props.width ?? 1920,
    height: props.height ?? 1080,
  };
};

export const Root: React.FC = () => {
  return (
    <>
      <Composition
        id="Explainer"
        component={Explainer}
        durationInFrames={30 * 60}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          cuts: [],
          overlays: [],
          audio: {},
          transition: "crossfade",
          transitionSeconds: 0.5,
          theme: "dark",
          fps: 30,
          width: 1920,
          height: 1080,
        }}
        calculateMetadata={calculateMetadata}
      />
    </>
  );
};
