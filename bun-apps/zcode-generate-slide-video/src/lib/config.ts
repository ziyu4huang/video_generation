export interface VideoConfig {
  /** Deck project dir: contains *.slides/ (and optionally deck.config.json + narration.json). */
  deckDir: string;
  /** Output MP4 path. */
  out: string;
  /** Base URL of the HTTP server serving the deck (slide JS expects http(s)). */
  baseUrl: string;
  /** Voice backend: "say" (macOS built-in) or "mlx" (mlx-audio, Apple GPU). */
  tts: "say" | "mlx";
  /** Voice name — backend-specific: say "Samantha"; mlx-audio Kokoro "zf_xiaobei" (zh female). */
  voice: string;
  /** Words per minute — say backend only. */
  rate: number;
  /** Python interpreter for the mlx backend (repo venv by default). */
  ttsPython: string;
  /** mlx-audio model repo id. */
  ttsModel: string;
  /** mlx-audio language code (Kokoro: "z" = Mandarin, "a" = US English). */
  ttsLang: string;
  /** Speech speed — mlx backend (1.0 = normal). */
  speed: number;
  /** Minimum seconds a slide stays on screen (audio may extend it). */
  minSeconds: number;
  /** Silence before narration starts on each slide, seconds. */
  lead: number;
  /** Silence after narration ends, seconds. */
  tail: number;
  width: number;
  height: number;
  fps: number;
  /** Crossfade duration between slides, seconds. */
  transition: number;
  /** Keep the work dir after rendering (debugging). */
  keep: boolean;
  /** Reuse an existing work dir's frames/wavs instead of re-rendering. */
  reuse: boolean;
  /** Static stills (old behavior) instead of build-in animations. */
  static: boolean;
  /** Explicit slides dir; default: the single *.slides/ dir inside deckDir. */
  slidesDir?: string;
  /** Explicit narration file; default: <deckDir>/narration.json if present. */
  narrationFile?: string;
}

export interface NarrationSlide {
  /** Slide file name inside the .slides dir, e.g. "slide-3.html". */
  file: string;
  /** Narration text spoken over the slide. */
  text: string;
  /** Optional query string appended to the slide URL, e.g. "embed=1". */
  query?: string;
  /**
   * Archify viewer only: patch the artifact's detailLevel() so relationship
   * labels render at 100% zoom (the viewer hides them at MAP depth by
   * default). Use for static renders (video/frames) of diagram slides.
   */
  revealLabels?: boolean;
  /** Optional title used in reports/derived narration. */
  title?: string;
}

export interface NarrationFile {
  slides: NarrationSlide[];
}

export interface SegmentPlan {
  file: string;
  url: string;
  wavPath: string;
  pngPath: string;
  segPath: string;
  /** Segment duration in seconds (lead + audio + tail, clamped to minSeconds). */
  duration: number;
  audioDuration: number;
}

/** Parse ["--deck","dir","--keep"] → {deck:"dir", keep:true}. Values may carry =. */
export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    let key = argv[i]!;
    if (!key.startsWith("--")) throw new Error(`unexpected positional argument: ${key}`);
    key = key.slice(2);
    let value: string | boolean = true;
    const eq = key.indexOf("=");
    if (eq >= 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
      value = argv[++i]!;
    }
    if (key in out) throw new Error(`duplicate flag: --${key}`);
    out[key] = value;
  }
  return out;
}

const NUMERIC = new Set(["rate", "seconds", "lead", "tail", "width", "height", "fps", "transition", "speed"]);

/** Flags → VideoConfig with defaults; throws on missing required/unknown flags. */
export function toConfig(args: Record<string, string | boolean>): VideoConfig {
  const known = new Set([
    "deck", "out", "base-url", "tts", "voice", "rate", "tts-python", "tts-model", "tts-lang",
    "speed", "seconds", "lead", "tail", "width", "height", "fps", "transition", "keep", "reuse",
    "slides-dir", "narration", "static", "help",
  ]);
  for (const key of Object.keys(args)) {
    if (!known.has(key)) throw new Error(`unknown flag: --${key} (see --help)`);
  }
  if (args.help) throw new Error(HELP);
  const deckDir = String(args.deck ?? "");
  if (!deckDir) throw new Error(HELP);
  const num = (key: string, dflt: number): number =>
    args[key] === undefined ? dflt : Number(args[key]);
  for (const key of NUMERIC) {
    if (args[key] !== undefined && !Number.isFinite(num(key, NaN))) {
      throw new Error(`--${key} must be a number`);
    }
  }
  const tts = String(args.tts ?? "say");
  if (tts !== "say" && tts !== "mlx") throw new Error(`--tts must be say|mlx, got ${tts}`);
  return {
    deckDir,
    out: String(args.out ?? ""),
    baseUrl: String(args["base-url"] ?? "http://127.0.0.1:8123"),
    tts,
    voice: String(args.voice ?? (tts === "mlx" ? "zf_xiaoxiao" : "Samantha")),
    rate: num("rate", 175),
    ttsPython: String(args["tts-python"] ?? "python/venv/bin/python"),
    ttsModel: String(args["tts-model"] ?? "mlx-community/Kokoro-82M-bf16"),
    ttsLang: String(args["tts-lang"] ?? "z"),
    speed: num("speed", 1.0),
    minSeconds: num("seconds", 3),
    lead: num("lead", 0.5),
    tail: num("tail", 0.9),
    width: num("width", 1920),
    height: num("height", 1080),
    fps: num("fps", 30),
    transition: num("transition", 0.6),
    keep: args.keep === true,
    reuse: args.reuse === true,
    static: args.static === true,
    slidesDir: args["slides-dir"] === undefined ? undefined : String(args["slides-dir"]),
    narrationFile: args.narration === undefined ? undefined : String(args.narration),
  };
}

export const HELP = `zcode-generate-slide-video — render an HTML slide deck into a narrated MP4.

Usage:
  bun bun-apps/zcode-generate-slide-video/src/cli.ts --deck <deckDir> [flags]

Required:
  --deck <dir>          Deck project dir containing a *.slides/ dir of slide-N.html files.

Common flags:
  --out <file.mp4>      Output path (default: <deckDir>/<slidesDirName>-narrated.mp4).
  --narration <file>    Narration JSON (default: <deckDir>/narration.json; derived from
                        deck.config.json when absent).
  --tts say|mlx         Voice backend (default: say). "mlx" uses mlx-audio (Apple GPU,
                        natural voices; needs python/venv with mlx-audio + misaki[zh]).
  --voice <name>        Backend voice — say: "Samantha" (list: say -v '?');
                        mlx: Kokoro voice, e.g. "zf_xiaoxiao" (zh female, default —
                        natural broadcast tone), "zf_xiaobei" (zh female, brighter),
                        "zm_yunjian" (zh male), "af_heart" (en).
  --rate <wpm>          Speech rate — say only (default: 175).
  --tts-python <path>   Python for the mlx backend (default: python/venv/bin/python).
  --tts-model <repo>    mlx-audio model (default: mlx-community/Kokoro-82M-bf16).
  --tts-lang <code>     Kokoro language code (default: "z" Mandarin; "a" US English).
  --speed <x>           Speech speed — mlx only (default: 1.0).
  --base-url <url>      Server serving the deck (default: http://127.0.0.1:8123).

Tuning:
  --seconds <s>         Minimum per-slide duration (default: 3; audio extends it).
  --lead <s> --tail <s> Silence around narration (default: 0.5 / 0.9).
  --transition <s>      Crossfade between slides (default: 0.6).
  --width --height --fps  Frame size/rate (default: 1920 1080 30).
  --slides-dir <dir>    Explicit slides dir (default: the single *.slides/ in deckDir).
  --keep --reuse        Keep the work dir after rendering / reuse its frames + wavs.
  --static              Still frames (no build-in animations). Default: animated —
                        composed slides stagger their blocks in; diagram slides
                        draw nodes then edges in flow order via CDP screencast.

Narration JSON shape:
  { "slides": [ { "file": "slide-1.html", "text": "…", "query": "embed=1",
                  "revealLabels": true, "title": "optional" } ] }
  revealLabels patches the archify viewer's detailLevel() so relationship labels
  render at 100% zoom — needed for static renders of diagram slides.`;
