export interface ModelCheckSummary {
  total_models: number;
  total_disk_bytes: number;
  total_disk_human: string;
  error_count: number;
  warning_count: number;
  notice_count: number;
  conversion_candidate_count: number;
  orphan_count: number;
}

export interface DiskCategory {
  category: string;
  bytes: number;
  count: number;
  human: string;
}

export interface TopModel {
  label: string;
  bytes: number;
  human: string;
}

export interface ModelValidation {
  errors: string[];
  warnings: string[];
  notices: string[];
}

export interface ModelEntry {
  label: string;
  category: string;
  manifest: Record<string, any>;
  disk_bytes: number;
  disk_human: string;
  weight_file: string | null;
  has_readme: boolean;
  has_config: boolean;
  downloading: boolean;
  disabled: boolean;
  validation: ModelValidation;
  status: "ok" | "warning" | "error";
}

export interface ConversionCandidate {
  label: string;
  format: string;
  size_bytes: number;
  size_human: string;
  target_format: string;
  est_size: number;
  est_size_human: string;
  savings_bytes: number;
  savings_human: string;
  convert_flag: string;
}

export interface OrphanEntry {
  category: string;
  instance: string;
}

export interface ModelCheckResult {
  timestamp: string;
  models_dir: string;
  summary: ModelCheckSummary;
  disk_usage: {
    by_category: DiskCategory[];
    top_models: TopModel[];
  };
  models: ModelEntry[];
  conversion_candidates: ConversionCandidate[];
  orphans: OrphanEntry[];
}
