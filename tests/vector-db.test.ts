import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VectorDB, Embedding } from '../src/storage/vector-db.js';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { v4 as uuid } from 'uuid';
import type { ResearchResult, ResearchProgress } from '../src/types/index.js';

function createMockResult(topic = 'Test Topic'): ResearchResult {
  return {
    id: uuid(),
    query: { topic, depth: 'medium', maxSources: 5 },
    status: 'completed',
    sources: [],
    progress: { phase: 'done', percent: 100, message: 'Done' } satisfies ResearchProgress,
    createdAt: new Date(),
    report: {
      title: `${topic} Report`,
      summary: `Summary about ${topic}`,
      keyFindings: ['Finding 1'],
      sections: [],
      conclusions: ['Conclusion 1'],
      references: [],
      generatedAt: new Date(),
    },
  };
}

describe('Embedding', () => {
  it('should create embedding without API key (fallback)', async () => {
    const emb = new Embedding({});
    const vector = await emb.embed('test text');
    expect(vector).toBeDefined();
    expect(vector.length).toBeGreaterThan(0);
  });

  it('should produce consistent embeddings for same text', async () => {
    const emb = new Embedding({});
    const v1 = await emb.embed('hello world');
    const v2 = await emb.embed('hello world');
    expect(v1).toEqual(v2);
  });

  it('should produce different embeddings for different texts', async () => {
    const emb = new Embedding({});
    const v1 = await emb.embed('hello');
    const v2 = await emb.embed('world');
    expect(v1).not.toEqual(v2);
  });

  it('should handle batch embedding', async () => {
    const emb = new Embedding({});
    const vectors = await emb.embedBatch(['a', 'b', 'c']);
    expect(vectors).toHaveLength(3);
    for (const v of vectors) {
      expect(v.length).toBeGreaterThan(0);
    }
  });

  it('should handle empty text', async () => {
    const emb = new Embedding({});
    const vector = await emb.embed('');
    expect(vector).toBeDefined();
    expect(vector.length).toBe(128);
  });
});

describe('VectorDB', () => {
  let db: VectorDB;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'vector-db-test-'));
    db = new VectorDB({ dataDir });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('should save and retrieve a result', async () => {
    const result = createMockResult();
    await db.saveResult(result);
    const retrieved = await db.getResult(result.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(result.id);
    expect(retrieved!.query.topic).toBe('Test Topic');
  });

  it('should return null for non-existent result', async () => {
    const result = await db.getResult('non-existent');
    expect(result).toBeNull();
  });

  it('should list results with pagination', async () => {
    const results = Array.from({ length: 5 }, (_, i) => createMockResult(`topic-${i}`));
    for (const r of results) {
      await db.saveResult(r);
    }
    const list = await db.listResults(3, 0);
    expect(list).toHaveLength(3);
  });

  it('should delete a result', async () => {
    const result = createMockResult();
    await db.saveResult(result);
    await db.deleteResult(result.id);
    const retrieved = await db.getResult(result.id);
    expect(retrieved).toBeNull();
  });

  it('should persist data to disk', async () => {
    const result = createMockResult();
    await db.saveResult(result);

    const db2 = new VectorDB({ dataDir });
    const retrieved = await db2.getResult(result.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(result.id);
  });

  it('should perform semantic search', async () => {
    const r1 = createMockResult('artificial intelligence');
    const r2 = createMockResult('cooking recipes');
    await db.saveResult(r1);
    await db.saveResult(r2);

    const results = await db.searchResults('AI');
    expect(results.length).toBeGreaterThan(0);
  });
});
