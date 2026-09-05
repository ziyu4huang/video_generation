/**
 * app.tsx — FLUX² Director: expert web UI over the swift/flux2 CLI.
 *
 * Layout: left control rail (presets, prompt, sampling, LoRA stack) +
 * main stage (live job / result) + gallery strip (manifest-driven history).
 * Progress rides one SSE stream per job; generations are single-flight
 * (the server 409s while the 9B transformer owns the GPU).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  LORA_STACKS,
  QUALITY_PRESETS,
  SIZE_PRESETS,
  VOICE_CHOICES,
  randomSeed,
  resolveStack,
  type LoraPresetEntry,
} from "./presets";

// ─── API types ───────────────────────────────────────────────────────────────

interface Health {
  ok: boolean;
  flux2Bin: string;
  flux2BinExists: boolean;
  metallib: string;
  metallibExists: boolean;
  modelsDir: string;
  outputDir: string;
  running: boolean;
}

interface ModelInventory {
  transformers: string[];
  loras: string[];
  upscaleModels: string[];
  vaes: string[];
  modelsDir: string;
}

interface GalleryItem {
  png: string;
  baseName: string;
  mtimeMs: number;
  width?: number;
  height?: number;
  seed?: string;
  steps?: number;
  prompt?: string;
  negativePrompt?: string;
  cfgScale?: number;
  transformer?: string;
  command?: string;
  loras?: string[];
  loraScales?: number[];
  elapsedSec?: number;
  createdAt?: string;
}

type JobStatus = "running" | "done" | "failed" | "cancelled";
type JobStage =
  | "queued"
  | "loading"
  | "generating"
  | "writing"
  | "keyframes"
  | "grid"
  | "voice"
  | "rendering"
  | "mixing"
  | "done";

interface ActiveJob {
  id: string;
  kind: "t2i" | "upscale" | "story";
  status: JobStatus;
  stage: JobStage;
  outputPath?: string;
  error?: string;
  createdAt: number;
  finishedAt?: number;
}

const STAGE_LABEL: Record<JobStage, string> = {
  queued: "Queued",
  loading: "Loading models",
  generating: "Diffusing",
  writing: "Writing storyboard (brain)",
  keyframes: "Keyframing (flux2)",
  grid: "Stitching grid",
  voice: "Narrating (Kokoro)",
  rendering: "Rendering video (LTX)",
  mixing: "Mixing voice + soundtrack",
  done: "Finished",
};

interface StoryRun {
  title?: string;
  idea?: string;
  scenes?: string[];
  narrations?: string[];
  panels?: string[];
  voiced?: boolean;
  brainModel?: string;
  seconds?: number;
  seed?: string;
  finalVideo?: string;
  createdAt?: string;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data;
}

const mediaUrl = (p: string): string => `/api/media?path=${encodeURIComponent(p)}`;

// ─── Story panel ────────────────────────────────────────────────────────────

const STORY_SIZES = [
  { label: "Landscape 960×544", width: 960, height: 544 },
  { label: "Portrait 640×960", width: 640, height: 960 },
];

function StoryPanel(props: {
  authorMode: "manual" | "auto";
  onAuthorModeChange: (m: "manual" | "auto") => void;
  idea: string;
  onIdeaChange: (v: string) => void;
  voice: string;
  onVoiceChange: (v: string) => void;
  scenes: string[];
  onScenesChange: (scenes: string[]) => void;
  seconds: number;
  onSecondsChange: (s: number) => void;
  width: number;
  height: number;
  onSizeChange: (w: number, h: number) => void;
  seed: string;
  onSeedChange: (s: string) => void;
}) {
  const { scenes, onScenesChange, seconds, onSecondsChange } = props;
  const setScene = (i: number, v: string) => onScenesChange(scenes.map((s, j) => (j === i ? v : s)));
  const setCount = (n: number) =>
    onScenesChange(
      n <= scenes.length
        ? scenes.slice(0, n)
        : [...scenes, ...Array.from({ length: n - scenes.length }, () => "")],
    );
  return (
    <>
      <section className="panel">
        <Field label="Author" aside={<span className="hint">auto = local brain writes everything</span>}>
          <div className="chip-row">
            <Chip active={props.authorMode === "manual"} onClick={() => props.onAuthorModeChange("manual")} title="you write each scene">
              Manual
            </Chip>
            <Chip
              active={props.authorMode === "auto"}
              onClick={() => props.onAuthorModeChange("auto")}
              title="one idea in — brain writes scenes, Kokoro speaks, LTX films"
            >
              Auto ✨
            </Chip>
          </div>
        </Field>

        {props.authorMode === "auto" ? (
          <>
            <Field label="Idea" aside={<span className="hint">any language · ⌘↵</span>}>
              <textarea
                value={props.idea}
                onChange={(e) => props.onIdeaChange(e.target.value)}
                placeholder="one line — e.g. “a stray cat guards a temple through four seasons”"
                rows={3}
              />
            </Field>
            <Field label="Narrator voice" aside={<span className="hint">Kokoro 82M · local</span>}>
              <select value={props.voice} onChange={(e) => props.onVoiceChange(e.target.value)}>
                {VOICE_CHOICES.map((v) => (
                  <option key={v.id} value={v.id}>{v.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Scenes" aside={<span className="hint">1–4 · brain writes each</span>}>
              <div className="chip-row">
                {[1, 2, 3, 4].map((n) => (
                  <Chip key={n} active={scenes.length === n} title={`${n} scene${n > 1 ? "s" : ""}`} onClick={() => setCount(n)}>
                    {n}
                  </Chip>
                ))}
              </div>
            </Field>
          </>
        ) : (
          <>
            <Field label="Scenes" aside={<span className="hint">1–4 · one LTX clip each, with voice</span>}>
              <div className="chip-row">
                {[1, 2, 3, 4].map((n) => (
                  <Chip
                    key={n}
                    active={scenes.length === n}
                    title={n < scenes.length ? "remove scenes from the end" : "add a scene"}
                    onClick={() => setCount(n)}
                  >
                    {n}
                  </Chip>
                ))}
              </div>
            </Field>
            {scenes.map((s, i) => (
              <Field key={i} label={`Scene ${i + 1}`} aside={<span className="hint">voice cues welcome (rain, meow…)</span>}>
                <textarea value={s} rows={4} onChange={(e) => setScene(i, e.target.value)} placeholder={`what happens in scene ${i + 1}`} />
              </Field>
            ))}
          </>
        )}
      </section>
      <section className="panel">
        <h3>Timing</h3>
        <Slider label="Seconds / scene" value={seconds} min={1} max={8} step={1} hint="LTX snaps to 8k+1 frames @ 24 fps" onChange={onSecondsChange} />
        <Field label="Format">
          <div className="chip-row">
            {STORY_SIZES.map((s) => (
              <Chip key={s.label} active={props.width === s.width && props.height === s.height} onClick={() => props.onSizeChange(s.width, s.height)}>
                {s.label}
              </Chip>
            ))}
          </div>
        </Field>
        <Field label="Seed">
          <div className="seed-row">
            <input className="mono" type="text" value={props.seed} onChange={(e) => props.onSeedChange(e.target.value.replace(/[^\d]/g, ""))} />
            <button type="button" className="btn btn-ghost" title="random seed" onClick={() => props.onSeedChange(randomSeed())}>🎲</button>
          </div>
        </Field>
      </section>
    </>
  );
}

// ─── Small controlled inputs ────────────────────────────────────────────────

function Field(props: { label: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">
        {props.label}
        {props.aside ? <span className="field-aside">{props.aside}</span> : null}
      </span>
      {props.children}
    </label>
  );
}

function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  hint?: string;
  onChange: (v: number) => void;
}) {
  return (
    <Field
      label={props.label}
      aside={<span className="mono">{props.value}</span>}
    >
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      {props.hint ? <span className="hint">{props.hint}</span> : null}
    </Field>
  );
}

function Chip(props: {
  active?: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button type="button" className={`chip${props.active ? " active" : ""}`} title={props.title} onClick={props.onClick}>
      {props.children}
    </button>
  );
}

// ─── LoRA stack panel ───────────────────────────────────────────────────────

function LoraPanel(props: {
  available: string[] | undefined;
  selected: LoraPresetEntry[];
  onChange: (entries: LoraPresetEntry[]) => void;
}) {
  const { available, selected, onChange } = props;
  const byName = useMemo(() => new Map(selected.map((l) => [l.name, l.scale])), [selected]);

  const toggle = (name: string) => {
    if (byName.has(name)) {
      onChange(selected.filter((l) => l.name !== name));
    } else {
      onChange([...selected, { name, scale: 1.0 }]);
    }
  };

  const applyStack = (stackId: string) => {
    const stack = LORA_STACKS.find((s) => s.id === stackId);
    if (!stack) return;
    onChange(resolveStack(stack, available));
  };

  const missing = selected.filter((l) => available && !available.includes(l.name));

  return (
    <div className="lora-panel">
      <div className="stack-buttons">
        {LORA_STACKS.map((s) => (
          <Chip key={s.id} title={s.hint} onClick={() => applyStack(s.id)}>
            {s.label}
          </Chip>
        ))}
        <Chip active={false} onClick={() => onChange([])} title="remove every LoRA">
          Clear
        </Chip>
      </div>
      {missing.length > 0 ? (
        <div className="warn-note">
          not on disk (skipped at generate): {missing.map((l) => l.name).join(", ")}
        </div>
      ) : null}
      <div className="lora-list">
        {(available ?? []).map((name) => {
          const on = byName.has(name);
          return (
            <div key={name} className={`lora-row${on ? " on" : ""}`}>
              <label className="lora-name">
                <input type="checkbox" checked={on} onChange={() => toggle(name)} />
                <span className="mono">{name}</span>
              </label>
              {on ? (
                <input
                  type="range"
                  min={0.05}
                  max={1.5}
                  step={0.05}
                  value={byName.get(name) ?? 1}
                  title={`scale ${byName.get(name) ?? 1}`}
                  onChange={(e) =>
                    onChange(selected.map((l) => (l.name === name ? { name, scale: Number(e.target.value) } : l)))
                  }
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main app ───────────────────────────────────────────────────────────────

export function App() {
  // Server state.
  const [health, setHealth] = useState<Health | null>(null);
  const [models, setModels] = useState<ModelInventory | null>(null);
  const [gallery, setGallery] = useState<GalleryItem[]>([]);

  // Generation form.
  const [presetId, setPresetId] = useState("quality");
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [transformer, setTransformer] = useState("");
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [steps, setSteps] = useState(8);
  const [cfgScale, setCfgScale] = useState(1.0);
  const [seed, setSeed] = useState<string>(randomSeed);
  /** Locked seed = every Generate reuses it (iterate on one composition).
   *  Unlocked (default) = a fresh random seed after each successful run, so
   *  hitting Generate twice doesn't silently produce the same image. */
  const [lockSeed, setLockSeed] = useState(false);
  const [lora, setLora] = useState<LoraPresetEntry[]>([]);
  const [strictGate, setStrictGate] = useState(false);
  const [autoUpscale, setAutoUpscale] = useState(true);

  // Job + result state.
  const [job, setJob] = useState<ActiveJob | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [selected, setSelected] = useState<GalleryItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const esRef = useRef<EventSource | null>(null);

  // Story mode state.
  const [mode, setMode] = useState<"image" | "story">("image");
  const [authorMode, setAuthorMode] = useState<"manual" | "auto">("auto");
  const [storyIdea, setStoryIdea] = useState("");
  const [storyVoice, setStoryVoice] = useState("");
  const [storyScenes, setStoryScenes] = useState<string[]>([]);
  const [storySeconds, setStorySeconds] = useState(2);
  const [storyWidth, setStoryWidth] = useState(960);
  const [storyHeight, setStoryHeight] = useState(544);
  const [storySeed, setStorySeed] = useState<string>("42");
  const [storyRuns, setStoryRuns] = useState<StoryRun[]>([]);
  const [storyResult, setStoryResult] = useState<StoryRun | null>(null);
  /** The finished story's script panel — scrolled into view on completion
   *  (stage-main is the app's inner scroll area, so new content lands below
   *  the fold behind the video preview). */
  const scriptPanelRef = useRef<HTMLDivElement | null>(null);

  const refreshGallery = useCallback(() => {
    api<{ items: GalleryItem[] }>("/api/gallery").then((d) => setGallery(d.items)).catch(() => {});
  }, []);

  const refreshStories = useCallback((): Promise<StoryRun[]> => {
    return api<{ defaultStory: StoryRun; stories: StoryRun[] }>("/api/story")
      .then((d) => {
        setStoryRuns(d.stories);
        setStoryScenes((prev) =>
          prev.length > 0 ? prev : (d.defaultStory.scenes?.slice(0, 4) ?? [""]),
        );
        return d.stories;
      })
      .catch(() => [] as StoryRun[]);
  }, []);

  useEffect(() => {
    api<Health>("/api/health").then(setHealth).catch((e) => setError(String(e.message ?? e)));
    api<ModelInventory>("/api/models").then(setModels).catch(() => {});
    refreshGallery();
    refreshStories();
  }, [refreshGallery, refreshStories]);

  // Apply a quality preset (steps + auto-upscale + LoRA stack, filtered to disk).
  const applyPreset = useCallback(
    (id: string) => {
      const p = QUALITY_PRESETS.find((x) => x.id === id);
      if (!p) return;
      setPresetId(id);
      setSteps(p.steps);
      setAutoUpscale(p.autoUpscale);
      if (p.stackId === null) {
        setLora([]);
      } else {
        const stack = LORA_STACKS.find((s) => s.id === p.stackId);
        if (stack) setLora(resolveStack(stack, models?.loras));
      }
    },
    [models?.loras],
  );

  const trackJob = useCallback((jobId: string, kind: ActiveJob["kind"]) => {
    esRef.current?.close();
    setLog([]);
    setJob({ id: jobId, kind, status: "running", stage: "queued", createdAt: Date.now() });
    const es = new EventSource(`/api/jobs/${jobId}/events`);
    esRef.current = es;
    es.onmessage = (e) => {
      let evt: { type: string; job?: ActiveJob & { id: string }; stage?: JobStage; id?: string; text?: string };
      try {
        evt = JSON.parse(e.data);
      } catch {
        return;
      }
      if (evt.type === "state" && evt.job) {
        const incoming = evt.job;
        setJob((prev) => {
          const next = prev && prev.id === incoming.id ? { ...prev, ...incoming } : incoming;
          return next;
        });
      } else if (evt.type === "stage" && evt.stage) {
        setJob((prev) => (prev ? { ...prev, stage: evt.stage! } : prev));
      } else if (evt.type === "log" && evt.text) {
        setLog((prev) => [...prev.slice(-400), evt.text!]);
      }
    };
  }, []);

  // Stop the stream + settle the UI when the tracked job leaves "running".
  useEffect(() => {
    if (!job || job.status === "running") return;
    esRef.current?.close();
    esRef.current = null;
    refreshGallery();
    if (job.kind === "story") {
      // story.json on the server is the source of truth (auto stories carry
      // title/narrations the local form never had) — surface the run this
      // job produced.
      void refreshStories().then((runs) => {
        setStoryResult((prev) => runs.find((r) => r.finalVideo === job.outputPath) ?? prev ?? runs[0] ?? null);
        // Bring the fresh story's script panel into view once rendered.
        setTimeout(() => scriptPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 150);
      });
    }
    if (job.kind === "t2i" && job.status === "done" && !lockSeed) {
      setSeed(randomSeed());
    }
    if (job.kind !== "story" && job.status === "done" && job.outputPath) {
      const source = gallery.find((g) => g.png === job.outputPath);
      setSelected(
        source ?? {
          png: job.outputPath,
          baseName: job.outputPath.split("/").pop() ?? job.outputPath,
          mtimeMs: Date.now(),
        },
      );
    }
    if (job.status === "failed" || job.status === "cancelled") {
      setError(job.error ?? `job ${job.status}`);
    }
  }, [job?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const busy = job?.status === "running";

  /** Generation params as one object — the single payload shape for t2i runs. */
  interface GenParams {
    prompt: string;
    negativePrompt?: string;
    transformer?: string;
    width?: number;
    height?: number;
    steps?: number;
    cfgScale?: number;
    seed?: string;
    lora?: Array<{ name: string; scale: number }>;
  }

  /** POST /api/generate + track. Shared by the form, Regenerate, and Load. */
  const submitGenerate = useCallback(
    async (params: GenParams) => {
      setError(null);
      if (!params.prompt?.trim()) {
        setError("prompt is required");
        return false;
      }
      try {
        const { jobId } = await api<{ jobId: string }>("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...params, strictGate, autoUpscale }),
        });
        trackJob(jobId, "t2i");
        return true;
      } catch (e) {
        setError(String((e as Error).message ?? e));
        return false;
      }
    },
    [strictGate, autoUpscale, trackJob],
  );

  /** Form state → params (LoRAs filtered to what exists on disk). */
  const formParams = useCallback((): GenParams => {
    const kept = lora.filter((l) => !models?.loras || models.loras.includes(l.name));
    return {
      prompt,
      negativePrompt: cfgScale > 1 ? negativePrompt : undefined,
      transformer: transformer || undefined,
      width,
      height,
      steps,
      cfgScale,
      seed: /^\d+$/.test(seed) ? seed : undefined,
      lora: kept.length ? kept : undefined,
    };
  }, [prompt, negativePrompt, transformer, width, height, steps, cfgScale, seed, lora, models?.loras]);

  const generate = useCallback(async () => {
    await submitGenerate(formParams());
  }, [submitGenerate, formParams]);

  /**
   * Gallery item → params. Only meaningful for t2i outputs (upscale sidecars
   * carry no generation settings worth re-running). LoRAs re-filtered to
   * disk so a deleted adapter can't fail the rerun.
   */
  const itemParams = useCallback(
    (item: GalleryItem): GenParams | null => {
      if (item.command && item.command !== "t2i") return null;
      if (!item.prompt) return null;
      const loras = (item.loras ?? [])
        .filter((name) => !models?.loras || models.loras.includes(name))
        .map((name, i) => ({ name, scale: item.loraScales?.[i] ?? 1 }));
      return {
        prompt: item.prompt,
        negativePrompt: item.negativePrompt || undefined,
        transformer: item.transformer || undefined,
        width: item.width,
        height: item.height,
        steps: item.steps,
        cfgScale: item.cfgScale,
        seed: item.seed,
        lora: loras.length ? loras : undefined,
      };
    },
    [models?.loras],
  );

  /** Load an item's settings into the form (no generation). */
  const loadFromItem = useCallback(
    (item: GalleryItem) => {
      const p = itemParams(item);
      if (!p) {
        setError("this image has no t2i settings to load (upscale/other command)");
        return;
      }
      setPrompt(p.prompt);
      setNegativePrompt(p.negativePrompt ?? "");
      setTransformer(p.transformer ?? "");
      if (p.width) setWidth(p.width);
      if (p.height) setHeight(p.height);
      if (p.steps) setSteps(p.steps);
      if (p.cfgScale !== undefined) setCfgScale(p.cfgScale);
      if (p.seed) setSeed(p.seed);
      setLora(p.lora ?? []);
      setPresetId("custom");
      setError(null);
    },
    [itemParams],
  );

  /** Regenerate: rerun an item EXACTLY (same seed/settings → same image). */
  const regenerateFromItem = useCallback(
    async (item: GalleryItem) => {
      const p = itemParams(item);
      if (!p) {
        setError("only t2i images can be regenerated");
        return;
      }
      // Pin the seed for a faithful rerun, and show it in the form.
      if (p.seed) setSeed(p.seed);
      await submitGenerate(p);
    },
    [itemParams, submitGenerate],
  );

  // Auto-upscale chain: when a t2i job finishes, run 4× on its output.
  useEffect(() => {
    if (job?.status !== "done" || job.kind !== "t2i" || !autoUpscale || !job.outputPath) return;
    api<{ jobId: string }>("/api/upscale", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: job.outputPath }),
    })
      .then(({ jobId }) => trackJob(jobId, "upscale"))
      .catch((e) => setError(String((e as Error).message ?? e)));
  }, [job?.status, job?.kind, job?.outputPath]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Live progress: parse the pipeline's step telemetry from the log ──
  // ("   step k/N  (x.xs/step)" — printed by Flux2T2IPipeline per denoise
  // step) plus a ticking wall clock while a job runs.
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const stepInfo = useMemo(() => {
    // t2i jobs step through the whole diffusion pass; story jobs only during
    // the keyframes stage (the bar resets per panel — still shows life).
    if (job?.kind !== "t2i" && !(job?.kind === "story" && job.stage === "keyframes")) return null;
    for (let i = log.length - 1; i >= 0; i--) {
      const m = log[i]!.match(/step (\d+)\/(\d+)\s+\(([\d.]+)s\/step\)/);
      if (m) return { step: Number(m[1]), total: Number(m[2]), secPerStep: Number(m[3]) };
    }
    return null;
  }, [log, job?.kind, job?.stage]);

  const elapsedSec = job ? Math.max(0, ((job.status === "running" ? nowTick : (job as { finishedAt?: number }).finishedAt ?? nowTick) - job.createdAt) / 1000) : 0;
  const etaSec = stepInfo && job?.kind === "t2i" ? Math.max(0, stepInfo.secPerStep * (stepInfo.total - stepInfo.step) + 2) : null;
  const progressPct = stepInfo ? Math.round((stepInfo.step / stepInfo.total) * 100) : null;

  const upscale = useCallback(async (png: string) => {
    setError(null);
    try {
      const { jobId } = await api<{ jobId: string }>("/api/upscale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: png }),
      });
      trackJob(jobId, "upscale");
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, [trackJob]);

  const generateStory = useCallback(async () => {
    setError(null);
    const body: Record<string, unknown> = {
      seconds: storySeconds,
      width: storyWidth,
      height: storyHeight,
      seed: /^\d+$/.test(storySeed) ? storySeed : undefined,
    };
    if (authorMode === "auto") {
      const idea = storyIdea.trim();
      if (idea.length < 3) {
        setError("auto mode needs an idea (at least 3 characters)");
        return;
      }
      body.auto = { idea, voice: storyVoice };
      body.sceneCount = storyScenes.length || 4;
    } else {
      const scenes = storyScenes.map((s) => s.trim()).filter(Boolean);
      if (scenes.length === 0) {
        setError("at least one scene prompt is required");
        return;
      }
      body.scenes = scenes;
    }
    try {
      const { jobId } = await api<{ jobId: string }>("/api/story", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      trackJob(jobId, "story");
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, [authorMode, storyIdea, storyVoice, storyScenes, storySeconds, storyWidth, storyHeight, storySeed, trackJob]);

  const cancel = useCallback(() => {
    if (!job) return;
    fetch(`/api/jobs/${job.id}/cancel`, { method: "POST" }).catch(() => {});
  }, [job?.id]);

  // ⌘/Ctrl+Enter generates.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (!busy) void (mode === "story" ? generateStory() : generate());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, mode, generate, generateStory]);

  const visibleGallery = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return gallery;
    return gallery.filter((g) => (g.prompt ?? "").toLowerCase().includes(q) || g.baseName.toLowerCase().includes(q));
  }, [gallery, filter]);

  const activeStackName = LORA_STACKS.find((s) =>
    JSON.stringify(resolveStack(s, models?.loras)) === JSON.stringify(lora),
  )?.label;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">FLUX²</span>
          <span className="brand-name">Director</span>
          <span className="brand-sub">Flux2 Klein 9B · native MLX</span>
        </div>
        <div className="top-status">
          <div className="mode-switch">
            <button type="button" className={`mode-btn${mode === "image" ? " active" : ""}`} onClick={() => setMode("image")}>
              Image
            </button>
            <button
              type="button"
              className={`mode-btn${mode === "story" ? " active" : ""}`}
              onClick={() => {
                setMode("story");
                // Surface the newest past story instead of an empty stage.
                setStoryResult((prev) => prev ?? storyRuns[0] ?? null);
              }}
            >
              Story
            </button>
          </div>
          {busy ? <span className="pill pill-live">● {mode === "story" ? "rendering" : "generating"}</span> : null}
          <span className={`pill ${health?.flux2BinExists && health?.metallibExists ? "pill-ok" : "pill-bad"}`}>
            {!health?.flux2BinExists
              ? "flux2 missing"
              : !health?.metallibExists
                ? "mlx.metallib missing"
                : "flux2 ready"}
          </span>
        </div>
      </header>

      {error ? (
        <div className="error-banner" onClick={() => setError(null)}>
          {error} <span className="dismiss">×</span>
        </div>
      ) : null}

      <div className="layout">
        {/* ── Control rail ── */}
        <aside className="controls">
          {mode === "image" ? (
            <>
          <section className="panel">
            <Field label="Quality preset">
              <div className="chip-row">
                {QUALITY_PRESETS.map((p) => (
                  <Chip key={p.id} active={presetId === p.id} title={p.hint} onClick={() => applyPreset(p.id)}>
                    {p.label}
                  </Chip>
                ))}
              </div>
              <span className="hint">{QUALITY_PRESETS.find((p) => p.id === presetId)?.hint ?? "custom settings"}</span>
            </Field>

            <Field label="Prompt" aside={<span className="hint">zh-TW ok · ⌘↵</span>}>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="describe the image — subject, scene, lighting, mood"
                rows={5}
              />
            </Field>

            {cfgScale > 1 ? (
              <Field label="Negative prompt" aside={<span className="hint">used when cfg &gt; 1</span>}>
                <textarea
                  value={negativePrompt}
                  onChange={(e) => setNegativePrompt(e.target.value)}
                  placeholder="what to avoid"
                  rows={2}
                />
              </Field>
            ) : null}
          </section>

          <section className="panel">
            <h3>Resolution</h3>
            <div className="chip-row">
              {SIZE_PRESETS.map((s) => (
                <Chip
                  key={s.label}
                  active={width === s.width && height === s.height}
                  onClick={() => {
                    setWidth(s.width);
                    setHeight(s.height);
                  }}
                >
                  {s.label}
                </Chip>
              ))}
            </div>
            <div className="wh-row">
              <label>
                W<input
                  type="number"
                  min={256}
                  max={2048}
                  step={16}
                  value={width}
                  onChange={(e) => setWidth(Number(e.target.value) || 0)}
                />
              </label>
              <label>
                H<input
                  type="number"
                  min={256}
                  max={2048}
                  step={16}
                  value={height}
                  onChange={(e) => setHeight(Number(e.target.value) || 0)}
                />
              </label>
            </div>

            <h3>Sampling</h3>
            <Slider label="Steps" value={steps} min={1} max={12} step={1} hint="4 = distilled fast · 8+ = cleaner detail" onChange={setSteps} />
            <Slider
              label="CFG"
              value={cfgScale}
              min={1}
              max={2}
              step={0.05}
              hint="1.0 recommended for distilled Klein"
              onChange={setCfgScale}
            />
            <Field label="Seed" aside={<span className="hint">{lockSeed ? "locked" : "auto-rolls"}</span>}>
              <div className="seed-row">
                <input
                  className="mono"
                  type="text"
                  value={seed}
                  onChange={(e) => setSeed(e.target.value.replace(/[^\d]/g, ""))}
                />
                <button
                  type="button"
                  className={`btn btn-ghost${lockSeed ? " locked" : ""}`}
                  title={lockSeed ? "seed locked — every run reuses it (toggle to auto-roll)" : "seed auto-rolls after each run (toggle to lock)"}
                  onClick={() => setLockSeed((v) => !v)}
                >
                  {lockSeed ? "🔒" : "🔓"}
                </button>
                <button type="button" className="btn btn-ghost" title="random seed" onClick={() => setSeed(randomSeed())}>
                  🎲
                </button>
              </div>
            </Field>

            <Field label="Transformer">
              <select value={transformer} onChange={(e) => setTransformer(e.target.value)}>
                <option value="">klein-9b (default)</option>
                {(models?.transformers ?? []).map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </Field>
          </section>

          <section className="panel">
            <h3>
              LoRA stack
              <span className="count-badge">{lora.length}</span>
              {activeStackName ? <span className="hint"> · {activeStackName}</span> : null}
            </h3>
            <LoraPanel available={models?.loras} selected={lora} onChange={setLora} />
          </section>

          <section className="panel">
            <h3>Post</h3>
            <label className="toggle">
              <input type="checkbox" checked={autoUpscale} onChange={(e) => setAutoUpscale(e.target.checked)} />
              <span>Auto 4× upscale (RealPLKSR)</span>
            </label>
            <label className="toggle">
              <input type="checkbox" checked={strictGate} onChange={(e) => setStrictGate(e.target.checked)} />
              <span>Strict quality gate (fail on noise/blank)</span>
            </label>
          </section>
            </>
          ) : (
            <StoryPanel
              authorMode={authorMode}
              onAuthorModeChange={setAuthorMode}
              idea={storyIdea}
              onIdeaChange={setStoryIdea}
              voice={storyVoice}
              onVoiceChange={setStoryVoice}
              scenes={storyScenes}
              onScenesChange={setStoryScenes}
              seconds={storySeconds}
              onSecondsChange={setStorySeconds}
              width={storyWidth}
              height={storyHeight}
              onSizeChange={(w, h) => {
                setStoryWidth(w);
                setStoryHeight(h);
              }}
              seed={storySeed}
              onSeedChange={setStorySeed}
            />
          )}

          <button
            type="button"
            className="btn btn-generate"
            disabled={busy}
            onClick={() => void (mode === "story" ? generateStory() : generate())}
          >
            {busy
              ? `${STAGE_LABEL[job?.stage ?? "queued"]}…`
              : mode === "story"
                ? authorMode === "auto"
                  ? "Auto-generate Story ✨"
                  : "Generate Story"
                : "Generate"}
          </button>
        </aside>

        {/* ── Stage ── */}
        <main className="stage">
          <section className="stage-main panel">
            {/* The story video only owns the stage IN story mode — after
                visiting Story, a lingering storyResult must not swallow
                image-mode gallery selections. */}
            {mode === "story" && storyResult?.finalVideo ? (
              <>
                <video className="preview story-preview" src={mediaUrl(storyResult.finalVideo)} controls autoPlay loop />
                <div className="meta-row">
                  <span className="meta story-title">
                    {storyResult.title ? <b>“{storyResult.title}”</b> : <b>story</b>}
                    {storyResult.voiced ? <span className="pill pill-ok">voiced</span> : null}
                  </span>
                  <span className="meta">
                    <b>{storyResult.scenes?.filter((s) => s.trim()).length ?? 0} scenes</b>
                  </span>
                  {storyResult.seconds ? <span className="meta">{storyResult.seconds}s / scene</span> : null}
                  {storyResult.seed ? <span className="meta">seed <b className="mono">{storyResult.seed}</b></span> : null}
                  <span className="spacer" />
                  <a className="btn btn-ghost" href={mediaUrl(storyResult.finalVideo)} download>
                    Download mp4
                  </a>
                </div>
                {storyResult.idea || (storyResult.narrations?.length ?? 0) > 0 ? (
                  <div className="script-panel" ref={scriptPanelRef}>
                    {storyResult.idea ? <p className="script-idea">💡 {storyResult.idea}</p> : null}
                    <div className="scene-strip">
                      {(storyResult.scenes ?? []).map((visual, i) => (
                        <div className="scene-card" key={i}>
                          {storyResult.panels?.[i] ? (
                            <img src={mediaUrl(storyResult.panels[i]!)} alt={`scene ${i + 1} keyframe`} loading="lazy" />
                          ) : null}
                          <div className="scene-body">
                            <span className="scene-no">Scene {i + 1}</span>
                            {storyResult.narrations?.[i] ? (
                              <p className="scene-narration">“{storyResult.narrations[i]}”</p>
                            ) : null}
                            <p className="scene-visual" title={visual}>{visual}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                {storyRuns.length > 0 ? (
                  <div className="stories-strip">
                    <span className="hint">past stories:</span>
                    {storyRuns.slice(0, 8).map((r, i) => (
                      <Chip key={r.finalVideo ?? i} active={storyResult.finalVideo === r.finalVideo} onClick={() => setStoryResult(r)}>
                        {r.title ? r.title.slice(0, 24) : `${r.scenes?.length ?? 0}×${r.seconds}s`}
                        <span className="dim"> · {String(r.createdAt ?? "").slice(5, 16).replace("T", " ")}</span>
                      </Chip>
                    ))}
                  </div>
                ) : null}
              </>
            ) : selected ? (
              <>
                <img className="preview" src={mediaUrl(selected.png)} alt={selected.prompt ?? selected.baseName} />
                <div className="meta-row">
                  {selected.seed ? <span className="meta">seed <b className="mono">{selected.seed}</b></span> : null}
                  {selected.steps ? <span className="meta">steps <b className="mono">{selected.steps}</b></span> : null}
                  {selected.cfgScale !== undefined ? <span className="meta">cfg <b className="mono">{selected.cfgScale}</b></span> : null}
                  {selected.width ? <span className="meta">{selected.width}×{selected.height}</span> : null}
                  {selected.loras?.length ? <span className="meta">{selected.loras.length} LoRA</span> : null}
                  {selected.command ? <span className="meta pill">{selected.command}</span> : null}
                  {selected.elapsedSec ? <span className="meta dim">{selected.elapsedSec.toFixed(1)}s</span> : null}
                  <span className="spacer" />
                  {itemParams(selected) ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-primary"
                        title="re-run this image with its exact settings (same seed)"
                        disabled={busy}
                        onClick={() => void regenerateFromItem(selected)}
                      >
                        ↻ Regenerate
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        title="load this image's settings into the form"
                        onClick={() => loadFromItem(selected)}
                      >
                        Load settings
                      </button>
                    </>
                  ) : null}
                  <button type="button" className="btn btn-ghost" onClick={() => void upscale(selected.png)} disabled={busy}>
                    Upscale 4×
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void navigator.clipboard.writeText(selected.png).catch(() => {})}
                  >
                    Copy path
                  </button>
                </div>
                <details className="meta-panel">
                  <summary>Generation metadata</summary>
                  <dl className="meta-grid">
                    <dt>prompt</dt>
                    <dd className="meta-prompt" title={selected.prompt}>{selected.prompt ?? <span className="dim">—</span>}</dd>
                    {selected.negativePrompt ? (
                      <>
                        <dt>negative</dt>
                        <dd>{selected.negativePrompt}</dd>
                      </>
                    ) : null}
                    <dt>transformer</dt>
                    <dd className="mono">{selected.transformer ?? "klein-9b (default)"}</dd>
                    <dt>seed</dt>
                    <dd className="mono">{selected.seed ?? "—"}</dd>
                    <dt>steps</dt>
                    <dd className="mono">{selected.steps ?? "—"}</dd>
                    <dt>cfg</dt>
                    <dd className="mono">{selected.cfgScale ?? "—"}</dd>
                    <dt>size</dt>
                    <dd className="mono">{selected.width ? `${selected.width}×${selected.height}` : "—"}</dd>
                    <dt>loras</dt>
                    <dd className="mono">
                      {selected.loras?.length
                        ? selected.loras.map((n, i) => `${n}@${selected.loraScales?.[i] ?? 1}`).join(", ")
                        : <span className="dim">none</span>}
                    </dd>
                    <dt>elapsed</dt>
                    <dd className="mono">{selected.elapsedSec ? `${selected.elapsedSec.toFixed(1)}s` : "—"}</dd>
                    <dt>created</dt>
                    <dd className="mono">{selected.createdAt ? selected.createdAt.replace("T", " ").slice(0, 19) : "—"}</dd>
                    <dt>file</dt>
                    <dd className="mono dim meta-file" title={selected.png}>{selected.png}</dd>
                  </dl>
                </details>
              </>
            ) : (
              <div className="placeholder">
                <div className="placeholder-mark">FLUX²</div>
                <p>Image mode: describe a shot, pick a quality preset, hit Generate.</p>
                <p>Story · Auto ✨: one idea in — the local brain writes the scenes, Kokoro speaks, LTX films.</p>
                <p>Story · Manual: one prompt per scene — LTX renders each clip with its own generated voice &amp; sound.</p>
                <p className="dim">Output lands in {health?.outputDir ?? "the shared output dir"}.</p>
              </div>
            )}

            {job ? (
              <div className={`job-card${busy ? " live" : ""}`}>
                <div className="job-head">
                  <span className={`stage-dot ${job.stage}`} />
                  <b>{job.kind === "upscale" ? "Upscale 4×" : job.kind === "story" ? "Story" : "Generate"}</b>
                  <span className="dim">{STAGE_LABEL[job.stage]}</span>
                  {job.status === "running" ? (
                    <>
                      <span className="meta mono dim">{elapsedSec.toFixed(0)}s</span>
                      {etaSec !== null && stepInfo ? (
                        <span className="meta dim">
                          step {stepInfo.step}/{stepInfo.total} · eta ~{etaSec.toFixed(0)}s
                        </span>
                      ) : null}
                      <span className="spacer" />
                    </>
                  ) : (
                    <>
                      <span className="meta mono dim">{elapsedSec.toFixed(0)}s total</span>
                      <span className={`pill ${job.status === "done" ? "pill-ok" : job.status === "failed" ? "pill-bad" : ""}`}>
                        {job.status}
                      </span>
                    </>
                  )}
                  {job.status === "running" ? (
                    <button type="button" className="btn btn-ghost btn-danger" onClick={cancel}>Cancel</button>
                  ) : null}
                </div>
                {job.status === "running" && stepInfo ? (
                  <div className="progress-track" role="progressbar" aria-valuenow={progressPct ?? 0} aria-valuemin={0} aria-valuemax={100}>
                    <div className="progress-fill" style={{ width: `${progressPct}%` }} />
                  </div>
                ) : null}
                {log.length > 0 ? (
                  <pre className="job-log">{log.slice(-10).join("\n")}</pre>
                ) : (
                  <pre className="job-log dim">waiting for flux2 output…</pre>
                )}
              </div>
            ) : null}
          </section>

          <section className="panel gallery">
            <div className="gallery-head">
              <h3>Gallery <span className="count-badge">{visibleGallery.length}</span></h3>
              <input
                className="gallery-filter"
                type="search"
                placeholder="filter by prompt…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <button type="button" className="btn btn-ghost" onClick={refreshGallery}>Refresh</button>
            </div>
            <div className="gallery-grid">
              {visibleGallery.map((g) => (
                <button
                  type="button"
                  key={g.png}
                  className={`thumb${selected?.png === g.png ? " active" : ""}`}
                  title={g.prompt ?? g.baseName}
                  onClick={() => {
                    // Exploring the gallery is an image-mode action — snap
                    // out of Story so the preview is actually visible.
                    setMode("image");
                    setSelected(g);
                  }}
                >
                  <img src={mediaUrl(g.png)} loading="lazy" alt={g.baseName} />
                  <span className="thumb-meta">
                    {g.command === "upscale" ? "4× " : ""}{g.seed ? `seed ${g.seed}` : g.baseName}
                  </span>
                </button>
              ))}
              {visibleGallery.length === 0 ? <p className="dim pad">No generations yet.</p> : null}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
