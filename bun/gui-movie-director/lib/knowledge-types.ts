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
  manifest: { status: string; elapsed_seconds: number } | null;
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
