/**
 * Tests: Research Graph — sub-research (parent/child) & visualisasi data
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ResearchEngine } from '../src/core/research-engine.js';
import { VectorDB } from '../src/storage/vector-db.js';
import type {
  ResearchConfig,
  ResearchResult,
  ResearchQuery,
  ResearchReport,
  Source,
  SourceCollector,
  LLMProvider,
} from '../src/types/index.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createSource(title: string, url: string): Source {
  return {
    id: `src-${title}`,
    title,
    url,
    content: `Content for ${title}`,
    sourceType: 'web',
    metadata: { wordCount: 10 },
    collectedAt: new Date(),
  };
}

function createMockLLM(): LLMProvider {
  return {
    async summarize(text: string): Promise<string> {
      return text.slice(0, 200);
    },
    async synthesize(_sources: Source[], query: ResearchQuery): Promise<ResearchReport> {
      return {
        title: `Report: ${query.topic}`,
        summary: 'Summary from mock LLM.',
        keyFindings: ['Finding A', 'Finding B'],
        sections: [{ heading: 'Intro', content: 'Intro content' }],
        conclusions: ['Conclusion 1'],
        references: ['https://example.com'],
        generatedAt: new Date(),
      };
    },
    async answer(question: string): Promise<string> {
      return `- ${question}\n- Deep dive tentang aspek spesifik lainnya\n- Bagaimana implementasi teknisnya`;
    },
  };
}

function createMockCollector(): SourceCollector {
  return {
    name: 'mock-collector',
    async collect(): Promise<Source[]> {
      return [createSource('Mock Source', 'https://example.com/mock')];
    },
  };
}

function createEngine(dataDir: string, llm?: LLMProvider): ResearchEngine {
  const config: ResearchConfig = {
    openaiApiKey: '',
    openaiModel: 'gpt-4o-mini',
    maxSources: 10,
    depth: 'medium',
    timeoutMs: 5000,
    dataDir,
  };
  const storage = new VectorDB({ dataDir });
  const engine = new ResearchEngine(config, storage, llm ?? createMockLLM());
  engine.registerCollector(createMockCollector());
  return engine;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ResearchEngine — getGraph', () => {
  let dataDir: string;
  let storage: VectorDB;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'graph-test-'));
    storage = new VectorDB({ dataDir });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('mengembalikan nodes + edges untuk parent dan child', async () => {
    const engine = createEngine(dataDir);
    const parent: ResearchResult = {
      id: 'parent-1',
      query: { topic: 'AI', depth: 'medium', maxSources: 5 },
      status: 'completed',
      sources: [createSource('S1', 'https://a.com')],
      progress: { phase: 'done', percent: 100, message: 'done' },
      createdAt: new Date(),
      childIds: ['child-1'],
    };
    const child: ResearchResult = {
      id: 'child-1',
      query: { topic: 'Deep Learning', depth: 'quick', maxSources: 3 },
      status: 'running',
      sources: [],
      progress: { phase: 'searching', percent: 10, message: 'searching' },
      createdAt: new Date(),
      parentId: 'parent-1',
    };
    await storage.saveResult(parent);
    await storage.saveResult(child);

    const graph = await engine.getGraph();

    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toEqual({ from: 'parent-1', to: 'child-1' });

    const parentNode = graph.nodes.find((n) => n.id === 'parent-1');
    expect(parentNode).toBeDefined();
    expect(parentNode!.childCount).toBe(1);
    expect(parentNode!.label).toBe('AI');

    const childNode = graph.nodes.find((n) => n.id === 'child-1');
    expect(childNode!.parentId).toBe('parent-1');
    expect(childNode!.status).toBe('running');
  });

  it('tidak membuat edge ganda / edge ke node yang tidak ada', async () => {
    const engine = createEngine(dataDir);
    const a: ResearchResult = {
      id: 'a',
      query: { topic: 'A', depth: 'medium', maxSources: 5 },
      status: 'completed',
      sources: [],
      progress: { phase: 'done', percent: 100, message: 'done' },
      createdAt: new Date(),
      childIds: ['b', 'ghost'], // ghost tidak ada di storage
    };
    const b: ResearchResult = {
      id: 'b',
      query: { topic: 'B', depth: 'medium', maxSources: 5 },
      status: 'completed',
      sources: [],
      progress: { phase: 'done', percent: 100, message: 'done' },
      createdAt: new Date(),
      parentId: 'a',
    };
    await storage.saveResult(a);
    await storage.saveResult(b);

    const graph = await engine.getGraph();

    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toEqual({ from: 'a', to: 'b' });
  });
});

describe('ResearchEngine — addSubResearch (linking)', () => {
  let dataDir: string;
  let storage: VectorDB;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'graph-link-test-'));
    storage = new VectorDB({ dataDir });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('menghubungkan child → parent (parentId + childIds)', async () => {
    const engine = createEngine(dataDir);

    // Buat parent dulu via engine (biar lengkap pipeline-nya)
    const parent = await engine.executeResearch({ topic: 'Parent Topic', depth: 'quick', maxSources: 3 });
    expect(parent.status).toBe('completed');

    // Tambah sub-research
    const child = await engine.addSubResearch(parent.id, {
      topic: 'Child Topic',
      depth: 'quick',
      maxSources: 2,
    });

    expect(child).not.toBeNull();
    expect(child!.parentId).toBe(parent.id);
    expect(child!.tags).toContain('sub-research');
    // Pencarian child harus ter-scope ke konteks induk (fix relevansi)
    expect(child!.query.parentContext).toBe('Parent Topic');

    // Parent harus punya childIds
    const updatedParent = await storage.getResult(parent.id);
    expect(updatedParent!.childIds).toContain(child!.id);

    // getSubResearch harus mengembalikan child
    const children = await engine.getSubResearch(parent.id);
    expect(children).toHaveLength(1);
    expect(children[0].id).toBe(child!.id);

    // getGraph harus mencerminkan hubungan
    const graph = await engine.getGraph();
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toContainEqual({ from: parent.id, to: child!.id });
  });

  it('mengembalikan null jika parent tidak ditemukan', async () => {
    const engine = createEngine(dataDir);
    const result = await engine.addSubResearch('tidak-ada', { topic: 'X' });
    expect(result).toBeNull();
  });
});

describe('ResearchEngine — suggestSubQueries', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'graph-suggest-test-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('menghasilkan saran sub-query dari report parent', async () => {
    const engine = createEngine(dataDir);
    const parent = await engine.executeResearch({ topic: 'AI', depth: 'quick', maxSources: 3 });

    const suggestions = await engine.suggestSubQueries(parent.id, 3);

    expect(Array.isArray(suggestions)).toBe(true);
    expect(suggestions.length).toBeGreaterThan(0);
    // Parsing harus menghapus prefix "- " dan tidak mengandung prefix lagi
    for (const s of suggestions) {
      expect(s.startsWith('- ')).toBe(false);
      expect(s.length).toBeGreaterThanOrEqual(8);
    }
    expect(suggestions.length).toBeLessThanOrEqual(3);
  });

  it('mengembalikan [] jika report belum tersedia', async () => {
    const engine = createEngine(dataDir);
    const storage = new VectorDB({ dataDir });

    // Result tanpa report
    const result: ResearchResult = {
      id: 'no-report',
      query: { topic: 'X', depth: 'quick', maxSources: 3 },
      status: 'running',
      sources: [],
      progress: { phase: 'searching', percent: 10, message: 'searching' },
      createdAt: new Date(),
    };
    await storage.saveResult(result);

    const suggestions = await engine.suggestSubQueries('no-report');
    expect(suggestions).toEqual([]);
  });
});
