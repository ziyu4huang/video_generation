/**
 * Root.tsx — Composition registration + calculateMetadata.
 *
 * Two compositions are registered:
 *   • `Explainer` — the data-driven templated composition (explainer/animation).
 *   • `Story` — the rich story composition (ticket 06): Explainer's scenes +
 *     per-cut particle overlays + TikTok-style word-pop captions.
 *
 * The orchestrator (src/remotion.ts) selects which to render via the
 * `composition` field in edit_decisions (default `Explainer`). Each composition's
 * duration is derived from the longest cut's out_seconds (+1s tail padding).
 */
import { Composition, type CalculateMetadataFunction } from "remotion";
import React from "react";
import { Explainer, type ExplainerProps } from "./Explainer";
import { Story, type StoryProps } from "./Story";

const calculateExplainer: CalculateMetadataFunction<Record<string, unknown>> = async ({ props }) => {
  const cuts = (props.cuts ?? []) as Array<{ out_seconds?: number }>;
  const lastEnd = cuts.length > 0 ? Math.max(...cuts.map((c) => c.out_seconds || 0)) : 0;
  const durationInFrames = Math.max(1, Math.ceil((lastEnd + 1) * ((props.fps as number) ?? 30)));
  return {
    durationInFrames,
    fps: (props.fps as number) ?? 30,
    width: (props.width as number) ?? 1920,
    height: (props.height as number) ?? 1080,
  };
};

const calculateStory: CalculateMetadataFunction<Record<string, unknown>> = async ({ props }) => {
  const cuts = (props.cuts ?? []) as Array<{ out_seconds?: number }>;
  const lastEnd = cuts.length > 0 ? Math.max(...cuts.map((c) => c.out_seconds || 0)) : 0;
  const durationInFrames = Math.max(1, Math.ceil((lastEnd + 1) * ((props.fps as number) ?? 30)));
  return {
    durationInFrames,
    fps: (props.fps as number) ?? 30,
 width: (props.width as number) ?? 1920,
    height: (props.height as number) ?? 1080,
  };
};

export const Root: React.FC = () => {
  return (
    <>
      <Composition
        id="Explainer"
        component={Explainer as unknown as React.FC<Record<string, unknown>>}
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
        calculateMetadata={calculateExplainer}
      />
      <Composition
        id="Story"
        component={Story as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={30 * 60}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          cuts: [],
          overlays: [],
          audio: {},
          wordCues: [],
          captionStyle: "tiktok",
          transition: "crossfade",
          transitionSeconds: 0.5,
          theme: "dark",
          fps: 30,
          width: 1920,
          height: 1080,
        }}
        calculateMetadata={calculateStory}
      />
    </>
  );
};
