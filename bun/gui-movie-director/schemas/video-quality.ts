import type { UnifiedCommand } from "./types";

export const videoQualityCommand: UnifiedCommand = {
  action: "video-quality",
  submitLabel: "Analyze Quality",
  runningLabel: "Analyzing...",
  fields: [
    // Input videos
    { key: "quality_inputs", cliFlag: "--quality-inputs", control: "text", label: "Video Paths",
      required: true, placeholder: "video.mp4 or A.mp4 B.mp4 or manifest.json" },
    // Analysis options
    { key: "sample_every", cliFlag: "--sample-every", control: "number", label: "Sample Every Nth Frame", default: 1, min: 1 },
    { key: "quality_labels", cliFlag: "--quality-labels", control: "text", label: "A/B Labels",
      placeholder: "e.g. Baseline,LoRA" },
    { key: "quality_json", cliFlag: "--quality-json", control: "text", label: "JSON Output Path",
      placeholder: "Default: <input>.quality.json" },
    { key: "no_html", cliFlag: "--no-html", control: "toggle", label: "Skip HTML Report" },
    { key: "quality_lang", cliFlag: "--quality-lang", control: "select", label: "Report Language",
      choices: [
        { value: "en", label: "English" },
        { value: "zh_TW", label: "繁體中文" },
      ], default: "en" },
    { key: "vlm_score", cliFlag: "--vlm-score", control: "toggle", label: "VLM Scoring",
      help: "Also score using Qwen3-VL (requires LM Studio)" },
  ],
};
