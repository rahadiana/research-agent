import { describe, it, expect } from 'vitest';
import type {
  ResearchQuery,
  Source,
  ResearchResult,
  ResearchReport,
  ResearchDepth,
  ResearchStatus,
  ResearchProgress,
  SourceMetadata,
  ReportSection,
} from '../src/types/index.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasKeys<T extends string>(obj: Record<string, unknown>, keys: T[]): obj is Record<T, unknown> {
  return keys.every(k => k in obj);
}

describe('ResearchQuery', () => {
  it('should create a valid ResearchQuery with minimal fields', () => {
    const query: ResearchQuery = { topic: 'Artificial Intelligence' };
    expect(query.topic).toBe('Artificial Intelligence');
    expect(query.depth).toBeUndefined();
    expect(query.maxSources).toBeUndefined();
    expect(query.questions).toBeUndefined();
  });

  it('should create a valid ResearchQuery with all fields', () => {
    const query: ResearchQuery = {
      topic: 'Quantum Computing',
      questions: ['What is it?', 'How does it work?'],
      depth: 'deep',
      maxSources: 15,
      filters: {
        domains: ['arxiv.org'],
        dateFrom: new Date('2024-01-01'),
        dateTo: new Date('2026-01-01'),
        languages: ['en'],
      },
    };
    expect(query.topic).toBe('Quantum Computing');
    expect(query.questions).toHaveLength(2);
    expect(query.depth).toBe('deep');
    expect(query.maxSources).toBe(15);
    expect(query.filters?.domains).toEqual(['arxiv.org']);
  });

  it('should accept all valid depth values', () => {
    const depths: ResearchDepth[] = ['quick', 'medium', 'deep'];
    for (const depth of depths) {
      const query: ResearchQuery = { topic: 'Test', depth };
      expect(query.depth).toBe(depth);
    }
  });

  it('should validate topic is a non-empty string', () => {
    const query: ResearchQuery = { topic: 'AI' };
    expect(typeof query.topic).toBe('string');
    expect(query.topic.length).toBeGreaterThan(0);
  });
});

describe('Source', () => {
  it('should create a valid Source with minimal fields', () => {
    const metadata: SourceMetadata = { wordCount: 500 };
    const source: Source = {
      id: 'src-1',
      title: 'Test Source',
      url: 'https://example.com',
      content: 'Source content here',
      sourceType: 'web',
      metadata,
      collectedAt: new Date(),
    };
    expect(source.id).toBe('src-1');
    expect(source.title).toBe('Test Source');
    expect(source.url).toBe('https://example.com');
    expect(source.sourceType).toBe('web');
    expect(source.metadata.wordCount).toBe(500);
  });

  it('should create a valid Source with all fields', () => {
    const metadata: SourceMetadata = {
      author: 'John Doe',
      publishDate: new Date('2025-01-01'),
      domain: 'example.com',
      wordCount: 1200,
      language: 'en',
      fileSize: 2048,
    };
    const source: Source = {
      id: 'src-2',
      title: 'Full Source',
      url: 'https://example.com/article',
      content: 'Full article content here',
      summary: 'A brief summary',
      sourceType: 'pdf',
      metadata,
      collectedAt: new Date('2025-06-01'),
      relevanceScore: 0.95,
    };
    expect(source.summary).toBe('A brief summary');
    expect(source.sourceType).toBe('pdf');
    expect(source.relevanceScore).toBe(0.95);
    expect(source.metadata.author).toBe('John Doe');
  });

  it('should accept all valid source types', () => {
    const types: Array<'web' | 'pdf' | 'api'> = ['web', 'pdf', 'api'];
    for (const sourceType of types) {
      const source: Source = {
        id: 's',
        title: 'T',
        url: 'https://example.com',
        content: 'C',
        sourceType,
        metadata: { wordCount: 100 },
        collectedAt: new Date(),
      };
      expect(source.sourceType).toBe(sourceType);
    }
  });
});

describe('ResearchResult', () => {
  it('should create a valid ResearchResult', () => {
    const progress: ResearchProgress = {
      phase: 'searching',
      percent: 50,
      message: 'Searching...',
    };
    const result: ResearchResult = {
      id: 'result-1',
      query: { topic: 'AI' },
      status: 'running',
      sources: [],
      progress,
      createdAt: new Date(),
      startedAt: new Date(),
    };
    expect(result.id).toBe('result-1');
    expect(result.status).toBe('running');
    expect(result.progress.phase).toBe('searching');
    expect(result.sources).toEqual([]);
  });

  it('should create a completed ResearchResult with report', () => {
    const report: ResearchReport = {
      title: 'AI Report',
      summary: 'Summary here',
      keyFindings: ['Finding 1'],
      sections: [],
      conclusions: ['Conclusion 1'],
      references: ['https://example.com'],
      generatedAt: new Date(),
      model: 'gpt-4o-mini',
    };
    const result: ResearchResult = {
      id: 'result-2',
      query: { topic: 'AI', depth: 'deep', maxSources: 10 },
      status: 'completed',
      sources: [],
      report,
      progress: { phase: 'done', percent: 100, message: 'Done' },
      createdAt: new Date(),
      startedAt: new Date(),
      completedAt: new Date(),
    };
    expect(result.status).toBe('completed');
    expect(result.report?.title).toBe('AI Report');
    expect(result.report?.keyFindings).toContain('Finding 1');
    expect(result.query.depth).toBe('deep');
  });

  it('should accept all valid status values', () => {
    const statuses: ResearchStatus[] = ['queued', 'running', 'completed', 'failed', 'cancelled'];
    for (const status of statuses) {
      const result: ResearchResult = {
        id: 'r',
        query: { topic: 'T' },
        status,
        sources: [],
        progress: { phase: 'done', percent: 0, message: '' },
        createdAt: new Date(),
      };
      expect(result.status).toBe(status);
    }
  });
});

describe('ResearchReport', () => {
  it('should create a valid ResearchReport with sections', () => {
    const subsection: ReportSection = {
      heading: 'History',
      content: 'History of AI',
    };
    const section: ReportSection = {
      heading: 'Introduction',
      content: 'Content about AI',
      subsections: [subsection],
    };
    const report: ResearchReport = {
      title: 'Comprehensive AI Report',
      summary: 'A detailed report about AI',
      keyFindings: ['Finding 1', 'Finding 2', 'Finding 3'],
      sections: [section],
      conclusions: ['Conclusion'],
      references: ['https://example.com'],
      generatedAt: new Date(),
      model: 'gpt-4o',
    };
    expect(report.title).toBe('Comprehensive AI Report');
    expect(report.sections).toHaveLength(1);
    expect(report.sections[0].subsections).toHaveLength(1);
    expect(report.sections[0].subsections![0].heading).toBe('History');
    expect(report.model).toBe('gpt-4o');
  });
});

describe('Runtime type validation', () => {
  it('should validate ResearchQuery shape at runtime', () => {
    const valid: unknown = { topic: 'AI', depth: 'medium', maxSources: 5 };
    expect(isObject(valid)).toBe(true);
    if (isObject(valid)) {
      expect(hasKeys(valid, ['topic'])).toBe(true);
      expect(typeof valid.topic === 'string').toBe(true);
    }
  });

  it('should detect invalid ResearchQuery (missing topic)', () => {
    const invalid: unknown = { depth: 'deep' };
    if (isObject(invalid)) {
      expect(hasKeys(invalid, ['topic'])).toBe(false);
    }
  });

  it('should validate ResearchResult shape at runtime', () => {
    const valid: unknown = {
      id: '1',
      query: { topic: 'AI' },
      status: 'completed',
      sources: [],
      progress: { phase: 'done', percent: 100, message: 'Done' },
      createdAt: new Date(),
    };
    expect(isObject(valid)).toBe(true);
    if (isObject(valid)) {
      expect(hasKeys(valid, ['id', 'query', 'status', 'sources', 'progress', 'createdAt'])).toBe(true);
    }
  });

  it('should validate ResearchReport shape at runtime', () => {
    const valid: unknown = {
      title: 'Report',
      summary: 'Summary',
      keyFindings: [],
      sections: [],
      conclusions: [],
      references: [],
      generatedAt: new Date(),
    };
    expect(isObject(valid)).toBe(true);
    if (isObject(valid)) {
      expect(hasKeys(valid, ['title', 'summary', 'keyFindings', 'sections', 'conclusions', 'references', 'generatedAt'])).toBe(true);
    }
  });
});
