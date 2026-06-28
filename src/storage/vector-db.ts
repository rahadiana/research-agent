/**
 * In-memory vector database with file persistence for the Research Agent.
 * Uses cosine similarity for semantic search with optional OpenAI embeddings.
 *
 * @module storage/vector-db
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  ResearchResult,
  ResearchStorage,
  Source,
} from '../types/index.js';

// ─── Public Types ────────────────────────────────────────────────────

/**
 * Result from a semantic search query.
 */
export interface SearchMatch {
  /** Unique identifier for the matched embedding record */
  id: string;
  /** Cosine similarity score (0–1), higher is more relevant */
  score: number;
  /** Arbitrary metadata payload attached to the embedding */
  payload: Record<string, unknown>;
}

/**
 * A stored embedding record with its vector, source text, and metadata.
 */
export interface EmbeddingRecord {
  /** Unique ID for this record */
  id: string;
  /** The embedding vector */
  vector: number[];
  /** The original text that was embedded */
  text: string;
  /** Arbitrary metadata (e.g. resultId, sourceId, type) */
  metadata: Record<string, unknown>;
  /** When this embedding was created */
  createdAt: Date;
}

// ─── Internal Types ──────────────────────────────────────────────────

/**
 * Configuration for the VectorDB and Embedding classes.
 */
interface DBConfig {
  /** Directory path for persisting the database file */
  dataDir: string;
  /** OpenAI API key (optional — enables real embeddings) */
  openaiApiKey?: string;
  /** OpenAI embedding model name (default: text-embedding-3-small) */
  embeddingModel?: string;
}

/**
 * Shape of the persisted JSON file on disk.
 */
interface PersistedData {
  embeddings: EmbeddingRecord[];
  results: ResearchResult[];
}

/**
 * Verified shape of the OpenAI Embeddings API response.
 */
interface OpenAIEmbeddingResponse {
  object: string;
  data: Array<{
    object: string;
    index: number;
    embedding: number[];
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

// ─── Math Helpers ────────────────────────────────────────────────────

/**
 * Compute cosine similarity between two equal-length vectors.
 * Returns a value in [0, 1] where 1 = identical direction.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return normA === 0 || normB === 0 ? 0 : dot / (normA * normB);
}

/**
 * SHA-256 hash of a text string (used for embedding cache keys).
 */
function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * L2-normalize a vector so its magnitude equals 1.
 */
function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vector;
  return vector.map(v => v / norm);
}

// ─── Embedding ───────────────────────────────────────────────────────

/**
 * Generates embedding vectors from text input.
 *
 * When an OpenAI API key is available it calls the real Embeddings API.
 * Otherwise it falls back to a simple character-code averaging algorithm
 * (128 dimensions, L2-normalized) which is sufficient for testing and
 * approximate similarity search.
 */
export class Embedding {
  private cache: Map<string, number[]> = new Map();
  private model: string;
  private apiKey?: string;

  /**
   * @param config.apiKey - Optional OpenAI API key
   * @param config.model  - Embedding model name (default: text-embedding-3-small)
   */
  constructor(config: { apiKey?: string; model?: string }) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'text-embedding-3-small';
  }

  /**
   * Generate an embedding vector for a single text string.
   * Results are cached by SHA-256 hash of the text.
   */
  async embed(text: string): Promise<number[]> {
    const key = hashText(text);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const vectors = await this.embedBatch([text]);
    return vectors[0];
  }

  /**
   * Generate embedding vectors for multiple texts.
   * Uncached texts are batched and sent together for efficiency.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const uncached: { index: number; text: string }[] = [];
    const results: (number[] | undefined)[] = new Array(texts.length);

    // Separate cached and uncached texts
    for (let i = 0; i < texts.length; i++) {
      const key = hashText(texts[i]);
      const cached = this.cache.get(key);
      if (cached) {
        results[i] = cached;
      } else {
        uncached.push({ index: i, text: texts[i] });
      }
    }

    // All texts were cached
    if (uncached.length === 0) {
      return results as number[][];
    }

    // Generate embeddings for uncached texts
    let vectors: number[][];
    if (this.apiKey) {
      vectors = await this.openAIEmbed(uncached.map(u => u.text));
    } else {
      vectors = uncached.map(u => this.fallbackEmbed(u.text));
    }

    // Store in cache and results array
    for (let j = 0; j < uncached.length; j++) {
      const u = uncached[j];
      const vec = vectors[j];
      const key = hashText(u.text);
      this.cache.set(key, vec);
      results[u.index] = vec;
    }

    return results as number[][];
  }

  /**
   * Call the OpenAI Embeddings API for a batch of texts.
   * Sends up to 20 texts per request.
   */
  private async openAIEmbed(texts: string[]): Promise<number[][]> {
    const allVectors: number[][] = [];
    const batchSize = 20;

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: batch,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `OpenAI Embeddings API error (${response.status}): ${errorBody}`,
        );
      }

      const json = (await response.json()) as OpenAIEmbeddingResponse;

      // Sort by index to guarantee the caller receives vectors in input order
      json.data.sort((a, b) => a.index - b.index);

      allVectors.push(...json.data.map(d => d.embedding));
    }

    return allVectors;
  }

  /**
   * Fallback embedding that works without an API key.
   *
   * Algorithm:
   * 1. Accumulate character codes into a 128-dimensional vector
   * 2. Divide each dimension by the character count (averaging)
   * 3. L2-normalize the result
   *
   * This produces a crude semantic signal useful for testing but
   * should not be relied on for production-quality search.
   */
  private fallbackEmbed(text: string): number[] {
    const dim = 128;
    const vector = new Array(dim).fill(0);
    let count = 0;

    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      vector[i % dim] += code;
      count++;
    }

    if (count > 0) {
      for (let i = 0; i < dim; i++) {
        vector[i] /= count;
      }
    }

    return normalize(vector);
  }
}

// ─── VectorDB ────────────────────────────────────────────────────────

/**
 * In-memory vector database with file persistence.
 *
 * Implements the {@link ResearchStorage} interface and adds semantic
 * search capabilities via cosine similarity over stored embeddings.
 *
 * Data is automatically persisted to `{dataDir}/vector-db.json` after
 * every write operation and loaded from disk at construction time.
 */
export class VectorDB implements ResearchStorage {
  private results: Map<string, ResearchResult> = new Map();
  private embeddings: Map<string, EmbeddingRecord> = new Map();
  private embedder: Embedding;
  private dataDir: string;
  private filePath: string;
  /** Track file mtime to auto-reload when another process writes */
  private fileMtime: number = 0;

  /**
   * @param config.dataDir        - Directory for the persistence file
   * @param config.openaiApiKey   - Optional OpenAI API key for real embeddings
   * @param config.embeddingModel - Embedding model name override
   */
  constructor(config: DBConfig) {
    this.dataDir = config.dataDir;
    this.filePath = path.join(config.dataDir, 'vector-db.json');
    this.embedder = new Embedding({
      apiKey: config.openaiApiKey,
      model: config.embeddingModel,
    });
    this.loadFromDisk();
  }

  // ── ResearchStorage Implementation ────────────────────────────────

  /**
   * Save (or overwrite) a research result and index its content for search.
   *
   * Generates embeddings for the query topic and every source (title + content),
   * stores them alongside the result, and persists to disk.
   */
  async saveResult(result: ResearchResult): Promise<void> {
    this.results.set(result.id, result);

    // Prepare texts for embedding
    const textsToEmbed: string[] = [result.query.topic];
    for (const source of result.sources) {
      textsToEmbed.push(source.title, source.content);
    }

    const vectors = await this.embedder.embedBatch(textsToEmbed);

    // Embed the query topic under the result ID
    const topicRecord: EmbeddingRecord = {
      id: `${result.id}::topic`,
      vector: vectors[0],
      text: result.query.topic,
      metadata: { resultId: result.id, type: 'topic' },
      createdAt: new Date(),
    };
    this.embeddings.set(topicRecord.id, topicRecord);

    // Embed each source title and content
    let vecIdx = 1;
    for (const source of result.sources) {
      const titleRecord: EmbeddingRecord = {
        id: `${result.id}::source::${source.id}`,
        vector: vectors[vecIdx],
        text: source.title,
        metadata: { resultId: result.id, sourceId: source.id, type: 'source' },
        createdAt: new Date(),
      };
      this.embeddings.set(titleRecord.id, titleRecord);
      vecIdx++;

      const contentRecord: EmbeddingRecord = {
        id: `${result.id}::content::${source.id}`,
        vector: vectors[vecIdx],
        text: source.content,
        metadata: { resultId: result.id, sourceId: source.id, type: 'content' },
        createdAt: new Date(),
      };
      this.embeddings.set(contentRecord.id, contentRecord);
      vecIdx++;
    }

    await this.persist();
  }

  /**
   * Retrieve a single research result by its ID.
   * Returns `null` when no result matches.
   */
  async getResult(id: string): Promise<ResearchResult | null> {
    this.checkReload();
    return this.results.get(id) ?? null;
  }

  /**
   * List research results with pagination, newest first.
   *
   * @param limit  - Maximum number of results to return (default: 10)
   * @param offset - Number of results to skip (default: 0)
   */
  async listResults(limit = 10, offset = 0): Promise<ResearchResult[]> {
    this.checkReload();
    const all = Array.from(this.results.values());
    all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return all.slice(offset, offset + limit);
  }

  /**
   * Delete a research result and all of its associated embeddings.
   */
  async deleteResult(id: string): Promise<void> {
    this.results.delete(id);

    // Remove all embeddings that belong to this result
    const embedKeys = Array.from(this.embeddings.keys()).filter(k =>
      k.startsWith(`${id}::`),
    );
    for (const key of embedKeys) {
      this.embeddings.delete(key);
    }

    await this.persist();
  }

  /**
   * Semantic search across all stored research results.
   *
   * Embeds the query, finds the most similar embeddings via cosine similarity,
   * de-duplicates by result ID, and returns results sorted by relevancy.
   */
  async searchResults(query: string): Promise<ResearchResult[]> {
    this.checkReload();
    const matches = await this.semanticSearch(query, 20);
    const resultIds = new Set<string>();

    for (const match of matches) {
      const payload = match.payload as { resultId?: string };
      if (payload.resultId) {
        resultIds.add(payload.resultId);
      }
    }

    const matched: ResearchResult[] = [];
    for (const id of resultIds) {
      const r = this.results.get(id);
      if (r) matched.push(r);
    }

    // Sort results by highest individual embedding score
    const scoreMap = new Map<string, number>();
    for (const match of matches) {
      const payload = match.payload as { resultId?: string };
      if (payload.resultId) {
        const existing = scoreMap.get(payload.resultId) ?? 0;
        scoreMap.set(payload.resultId, Math.max(existing, match.score));
      }
    }

    matched.sort(
      (a, b) => (scoreMap.get(b.id) ?? 0) - (scoreMap.get(a.id) ?? 0),
    );

    return matched;
  }

  // ── Additional Methods ────────────────────────────────────────────

  /**
   * Perform raw semantic search across all stored embeddings.
   *
   * @param query - The natural-language search string
   * @param topK  - Number of top matches to return (default: 10)
   * @returns Matches sorted by cosine similarity score (descending)
   */
  async semanticSearch(query: string, topK = 10): Promise<SearchMatch[]> {
    const queryVec = await this.embedder.embed(query);
    const scored: SearchMatch[] = [];

    for (const [id, record] of this.embeddings) {
      const score = cosineSimilarity(queryVec, record.vector);
      scored.push({
        id,
        score,
        payload: {
          ...record.metadata,
          text: record.text,
        },
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /**
   * Index a single source for a given result so it becomes
   * discoverable through semantic search.
   */
  async indexSource(resultId: string, source: Source): Promise<void> {
    const texts = [source.title, source.content];
    const vectors = await this.embedder.embedBatch(texts);

    const titleRecord: EmbeddingRecord = {
      id: `${resultId}::source::${source.id}`,
      vector: vectors[0],
      text: source.title,
      metadata: { resultId, sourceId: source.id, type: 'source' },
      createdAt: new Date(),
    };
    this.embeddings.set(titleRecord.id, titleRecord);

    const contentRecord: EmbeddingRecord = {
      id: `${resultId}::content::${source.id}`,
      vector: vectors[1],
      text: source.content,
      metadata: { resultId, sourceId: source.id, type: 'content' },
      createdAt: new Date(),
    };
    this.embeddings.set(contentRecord.id, contentRecord);

    await this.persist();
  }

  // ── New API methods ─────────────────────────────────────────────

  async searchByParent(parentId: string): Promise<ResearchResult[]> {
    this.checkReload();
    const children: ResearchResult[] = [];
    for (const result of this.results.values()) {
      if (result.parentId === parentId) {
        children.push(result);
      }
    }
    return children.sort(
      (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
    );
  }

  async updateResult(
    id: string,
    updates: Partial<ResearchResult>,
  ): Promise<ResearchResult | null> {
    const existing = this.results.get(id);
    if (!existing) return null;

    const updated: ResearchResult = {
      ...existing,
      ...updates,
      // Jangan timpa field yang penting kalo undefined
      id: existing.id,
      query: updates.query ?? existing.query,
      sources: updates.sources ?? existing.sources,
      progress: updates.progress ?? existing.progress,
    };

    this.results.set(id, updated);
    await this.persist();
    return updated;
  }

  // ── Persistence ──────────────────────────────────────────────────

  /**
   * Write all in-memory data to `{dataDir}/vector-db.json`.
   */
  private async persist(): Promise<void> {
    if (!existsSync(this.dataDir)) {
      await mkdir(this.dataDir, { recursive: true });
    }

    const data: PersistedData = {
      embeddings: Array.from(this.embeddings.values()),
      results: Array.from(this.results.values()),
    };

    await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * Load data from the persistence file during construction.
   * If the file is missing or corrupt the database starts empty.
   */
  /**
   * Auto-reload from disk jika file berubah sejak load terakhir.
   * Memungkinkan multi-process (dashboard + CLI) berbagi data yang sama.
   */
  private checkReload(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const currentMtime = statSync(this.filePath).mtimeMs;
      if (currentMtime > this.fileMtime) {
        this.loadFromDisk();
      }
    } catch {
      // ignore — read will use stale data
    }
  }

  private loadFromDisk(): void {
    if (!existsSync(this.filePath)) return;

    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as PersistedData;
      this.fileMtime = statSync(this.filePath).mtimeMs;

      // Hydrate ResearchResult objects (restore Date instances)
      for (const result of data.results) {
        this.results.set(result.id, {
          ...result,
          createdAt: new Date(result.createdAt),
          startedAt: result.startedAt ? new Date(result.startedAt) : undefined,
          completedAt: result.completedAt
            ? new Date(result.completedAt)
            : undefined,
          sources: result.sources.map(s => ({
            ...s,
            collectedAt: new Date(s.collectedAt),
            metadata: {
              ...s.metadata,
              publishDate: s.metadata.publishDate
                ? new Date(s.metadata.publishDate)
                : undefined,
            },
          })),
        });
      }

      // Hydrate EmbeddingRecord objects
      for (const record of data.embeddings) {
        this.embeddings.set(record.id, {
          ...record,
          createdAt: new Date(record.createdAt),
        });
      }
    } catch {
      // File is corrupt or unreadable — start with empty state
      this.results = new Map();
      this.embeddings = new Map();
    }
  }
}
