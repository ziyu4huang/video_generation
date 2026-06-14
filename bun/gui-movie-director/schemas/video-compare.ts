import type { UnifiedCommand } from "./types";

export const videoCompareCommand: UnifiedCommand = {
  action: "video-compare",
  submitLabel: "Start Compare",
  runningLabel: "Comparing...",
  fields: [
    // Source image
    { key: "source_image", cliFlag: "--source-image", control: "image", label: "Source Image",
      placeholder: "Reference image (omit to auto-generate via Z-Image)" },
    // Prompt (inherited from video-generate shared args)
    { key: "prompt", cliFlag: "--prompt", control: "prompt", label: "Video Prompt" },
    // Z-Image generation (used when --source-image is omitted)
    { key: "image_prompt", cliFlag: "--image-prompt", control: "text", label: "Z-Image Prompt",
      placeholder: "Prompt for reference image generation" },
    { key: "image_width", cliFlag: "--image-width", control: "number", label: "Z-Image Width", default: 640 },
    { key: "image_height", cliFlag: "--image-height", control: "number", label: "Z-Image Height", default: 960 },
    { key: "image_steps", cliFlag: "--image-steps", control: "number", label: "Z-Image Steps" },
    // Caption control
    { key: "skip_caption", cliFlag: "--skip-caption", control: "toggle", label: "Skip Captioning" },
    { key: "caption_style", cliFlag: "--caption-style", control: "select", label: "Caption Style",
      choices: [
        { value: "", label: "Default (prompt)" },
        { value: "default", label: "Default" },
        { value: "photography", label: "Photography" },
        { value: "prompt", label: "Prompt" },
        { value: "profile", label: "Profile" },
        { value: "style", label: "Style" },
        { value: "score", label: "Score" },
        { value: "compare", label: "Compare" },
        { value: "review", label: "Review" },
      ], default: "" },
    // Pipeline selection
    { key: "pipelines", cliFlag: "--pipelines", control: "text", label: "Pipelines",
      default: "i2v,distilled-i2v,hq-i2v", placeholder: "Comma-separated: i2v,distilled-i2v,hq-i2v,t2v,distilled-t2v" },
    // Video generation params (shared)
    { key: "frames", cliFlag: "--frames", control: "number", label: "Frames", default: 97 },
    { key: "seed", cliFlag: "--seed", control: "number", label: "Seed", default: 42 },
    { key: "width", cliFlag: "--width", control: "number", label: "Width", default: 704 },
    { key: "height", cliFlag: "--height", control: "number", label: "Height", default: 448 },
    { key: "stage1_steps", cliFlag: "--stage1-steps", control: "number", label: "Stage 1 Steps", default: 8 },
    { key: "dry_run", cliFlag: "--dry-run", control: "toggle", label: "Dry Run",
      help: "Print comparison plan without generating" },
  ],
};
