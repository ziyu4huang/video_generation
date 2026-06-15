export interface T2IRunConfig {
  command: string;
  pipeline: string;
  transformer: string;
  prompt: string;
  width: number;
  height: number;
  steps: number;
  seed: number;
  lora_path: string | null;
  lora_scale: number;
  cfg_scale: number;
  [key: string]: unknown;
}

export interface ReviewCaption {
  overall: number;
  detail: number;
  sharpness: number;
  composition: number;
  prompt_adherence: number;
  artifacts: number;
  captured: string[];
  missed: string[];
  issues: string[];
  strengths: string[];
  summary: string;
}

export interface KnowledgeRecord {
  stem: string;
  dirIdx: number;
  imagePath: string;
  run: T2IRunConfig | null;
  manifest: {
    status: string;
    elapsed_seconds: number;
    // Enriched perf profile (optional — older manifests may lack these).
    // Lets the knowledge pipeline correlate model/time/memory with quality.
    memory_peak_mb?: number;
    denoising_seconds?: number;
    avg_step_seconds?: number;
    step_count?: number;
    transformer_model?: string;   // model dir basename, e.g. "zimage-moody-v126"
  } | null;
  caption: ReviewCaption | null;
  hasCaption: boolean;
  qualityScore: number | null;
  pipeline: string;
}

export interface PromptStrategy {
  template: string;
  avgScore: number;
  sampleCount: number;
  bestLora?: string;
}

export interface BestParams {
  pipeline: string;
  steps: number;
  cfgScale: number;
  loraScale?: number;
}

export interface LoraInsight {
  lora: string;
  avgScore: number;
  notes: string;
}

export interface ExampleRecord {
  prompt: string;
  score: number;
  pipeline: string;
  why: string;
  loraPath?: string;
}

export interface StructuredKnowledge {
  topStrategies: PromptStrategy[];
  avoid: string[];
  bestParams: BestParams[];
  loraInsights: LoraInsight[];
  topExamples: ExampleRecord[];
}

export interface KnowledgeReport {
  generatedAt: string;
  model: string;
  recordCount: number;
  avgQualityScore: number;
  markdown: string;
  structured: StructuredKnowledge;
}

export interface KnowledgeIndex {
  version: number;
  lastUpdated: string;
  recordShards: string[];   // relative: "records/records-0000.jsonl"
  totalRecords: number;
  reports: string[];        // relative: "reports/20260615-120000.json"
  latestReport: string | null;
  stats: {
    avgQualityScore: number;
    withCaption: number;
    pipelines: Record<string, number>;
  };
}
