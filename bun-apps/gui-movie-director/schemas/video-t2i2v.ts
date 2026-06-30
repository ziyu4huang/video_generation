import type { UnifiedCommand } from "./types";

export const videoT2i2vCommand: UnifiedCommand = {
  action: "video-t2i2v",
  submitLabel: "Generate T2I2V",
  runningLabel: "Running pipeline...",
  fields: [
    // --- Shared ---
    { key: "prompt", cliFlag: "--prompt", control: "prompt", label: "Image Prompt", required: true, section: "Image Stage (ZImage T2I)" },
    { key: "seed", cliFlag: "--seed", control: "number", label: "Base Seed", default: 99, compact: true, section: "Image Stage (ZImage T2I)" },

    // --- T2I stage ---
    { key: "t2i_transformer", cliFlag: "--t2i-transformer", control: "text", label: "T2I Transformer", default: "moody-pro-mix", section: "Image Stage (ZImage T2I)" },
    { key: "t2i_steps", cliFlag: "--t2i-steps", control: "number", label: "T2I Steps", default: 9, compact: true, section: "Image Stage (ZImage T2I)" },
    { key: "t2i_seed", cliFlag: "--t2i-seed", control: "number", label: "T2I Seed (override)", compact: true, section: "Image Stage (ZImage T2I)" },
    { key: "t2i_width", cliFlag: "--t2i-width", control: "number", label: "Width", default: 640, compact: true, section: "Image Stage (ZImage T2I)" },
    { key: "t2i_height", cliFlag: "--t2i-height", control: "number", label: "Height", default: 960, compact: true, section: "Image Stage (ZImage T2I)" },
    { key: "t2i_lora_path", cliFlag: "--t2i-lora-path", control: "text", label: "T2I LoRA Path", section: "Image Stage (ZImage T2I)" },
    { key: "t2i_lora_scale", cliFlag: "--t2i-lora-scale", control: "range", label: "T2I LoRA Scale", default: 1.0, min: 0, max: 2, section: "Image Stage (ZImage T2I)" },

    // --- VLM stage ---
    { key: "action", cliFlag: "--action", control: "text", label: "Action Intent (zh-TW)", multiline: true, placeholder: "例：她微笑走向鏡頭，說「嗯…」", section: "VLM Prompt Assistant" },
    { key: "vlm_api_url", cliFlag: "--vlm-api-url", control: "text", label: "VLM API URL (optional)", section: "VLM Prompt Assistant" },

    // --- Video stage ---
    { key: "transformer", cliFlag: "--transformer", control: "select", label: "LTX Transformer", default: "dasiwa",
      choices: [
        { value: "dasiwa", label: "DaSiWa (recommended)" },
        { value: "dev", label: "Dev" },
        { value: "distilled", label: "Distilled (fast)" },
      ],
      section: "Video Stage (LTX I2V)" },
    { key: "frames", cliFlag: "--frames", control: "number", label: "Frames", default: 97, compact: true, section: "Video Stage (LTX I2V)" },
    { key: "fps", cliFlag: "--fps", control: "number", label: "FPS", default: 24, compact: true, section: "Video Stage (LTX I2V)" },
    { key: "cfg_scale", cliFlag: "--cfg-scale", control: "number", label: "CFG Scale", compact: true, section: "Video Stage (LTX I2V)" },
    { key: "stg_scale", cliFlag: "--stg-scale", control: "number", label: "STG Scale", compact: true, section: "Video Stage (LTX I2V)" },
    { key: "stage1_steps", cliFlag: "--stage1-steps", control: "number", label: "Stage 1 Steps", compact: true, section: "Video Stage (LTX I2V)" },
    { key: "stage2_steps", cliFlag: "--stage2-steps", control: "number", label: "Stage 2 Steps", compact: true, section: "Video Stage (LTX I2V)" },
    { key: "hq", cliFlag: "--hq", control: "toggle", label: "HQ", section: "Video Stage (LTX I2V)" },
    { key: "distilled", cliFlag: "--distilled", control: "toggle", label: "Distilled mode", section: "Video Stage (LTX I2V)" },
    { key: "teacache", cliFlag: "--teacache", control: "toggle", label: "TeaCache", section: "Video Stage (LTX I2V)" },
    { key: "lora_path", cliFlag: "--lora-path", control: "text", label: "Video LoRA Path", section: "Video Stage (LTX I2V)" },
    { key: "lora_scale", cliFlag: "--lora-scale", control: "range", label: "Video LoRA Scale", default: 1.0, min: 0, max: 2, section: "Video Stage (LTX I2V)" },
  ],
};
