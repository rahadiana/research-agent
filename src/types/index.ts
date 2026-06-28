/**
 * Research Agent — Core Types & Interfaces
 */

/** Research query dari user */
export interface ResearchQuery {
  /** Topik yang ingin diteliti */
  topic: string;
  /** Pertanyaan spesifik (opsional) */
  questions?: string[];
  /** Kedalaman riset */
  depth?: ResearchDepth;
  /** Jumlah maksimal sumber */
  maxSources?: number;
  /** Filter sumber (domain, tanggal, dll) */
  filters?: ResearchFilters;
}

export type ResearchDepth = 'quick' | 'medium' | 'deep';

export interface ResearchFilters {
  domains?: string[];
  dateFrom?: Date;
  dateTo?: Date;
  languages?: string[];
}

/** Sumber informasi yang dikumpulkan */
export interface Source {
  id: string;
  title: string;
  url: string;
  content: string;
  summary?: string;
  sourceType: 'web' | 'pdf' | 'api';
  metadata: SourceMetadata;
  collectedAt: Date;
  relevanceScore?: number;
}

export interface SourceMetadata {
  author?: string;
  publishDate?: Date;
  domain?: string;
  wordCount: number;
  language?: string;
  fileSize?: number;
}

/** Status dari sebuah research task */
export type ResearchStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Hasil riset lengkap */
export interface ResearchResult {
  id: string;
  query: ResearchQuery;
  status: ResearchStatus;
  sources: Source[];
  report?: ResearchReport;
  error?: string;
  progress: ResearchProgress;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  /** ID parent — untuk sub-research (child → parent) */
  parentId?: string;
  /** ID anak-anak — untuk lihat cabang riset */
  childIds?: string[];
  /** Versi — naik tiap kali di-rerun */
  version?: number;
  /** Tag untuk grouping */
  tags?: string[];
}

/** Update payload untuk edit report */
export interface ResearchUpdate {
  summary?: string;
  keyFindings?: string[];
  sections?: ReportSection[];
  conclusions?: string[];
  title?: string;
}

export interface ResearchProgress {
  phase: 'queued' | 'searching' | 'collecting' | 'processing' | 'synthesizing' | 'done';
  percent: number;
  message: string;
}

/** Report hasil sintesis */
export interface ResearchReport {
  title: string;
  summary: string;
  keyFindings: string[];
  sections: ReportSection[];
  conclusions: string[];
  references: string[];
  generatedAt: Date;
  model?: string;
}

export interface ReportSection {
  heading: string;
  content: string;
  subsections?: ReportSection[];
}

/** Configuration */
export interface ResearchConfig {
  openaiApiKey: string;
  openaiModel: string;
  serpapiKey?: string;
  maxSources: number;
  depth: ResearchDepth;
  timeoutMs: number;
  dataDir: string;
}

/** Plugin interface untuk collector */
export interface SourceCollector {
  name: string;
  collect(query: ResearchQuery): Promise<Source[]>;
}

/** Storage interface */
export interface ResearchStorage {
  saveResult(result: ResearchResult): Promise<void>;
  getResult(id: string): Promise<ResearchResult | null>;
  listResults(limit?: number, offset?: number): Promise<ResearchResult[]>;
  deleteResult(id: string): Promise<void>;
  searchResults(query: string): Promise<ResearchResult[]>;
  /** Cari child results berdasarkan parentId */
  searchByParent(parentId: string): Promise<ResearchResult[]>;
  /** Update partial result (edit report, dll) */
  updateResult(id: string, updates: Partial<ResearchResult>): Promise<ResearchResult | null>;
}

/** LLM Provider interface */
export interface LLMProvider {
  summarize(text: string, maxLength?: number): Promise<string>;
  synthesize(sources: Source[], query: ResearchQuery): Promise<ResearchReport>;
  answer(question: string, context: string): Promise<string>;
}
