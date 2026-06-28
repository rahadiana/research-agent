import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ReportExporter } from '../src/export/index.js';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuid } from 'uuid';
import type { ResearchResult, Source, ResearchProgress, ReportSection, SourceMetadata } from '../src/types/index.js';

function createMockResult(topic = 'Test Topic'): ResearchResult {
  const sourceMetadata: SourceMetadata = { wordCount: 100 };
  const sources: Source[] = [
    {
      id: uuid(),
      title: 'Source 1',
      url: 'https://example.com/1',
      content: 'Content 1',
      sourceType: 'web',
      metadata: sourceMetadata,
      collectedAt: new Date(),
    },
  ];
  const sections: ReportSection[] = [
    {
      heading: 'Introduction',
      content: 'Content about ' + topic,
      subsections: [{ heading: 'History', content: 'History content' }],
    },
  ];

  return {
    id: uuid(),
    query: { topic, depth: 'medium', maxSources: 5 },
    status: 'completed',
    sources,
    progress: { phase: 'done', percent: 100, message: 'Done' } satisfies ResearchProgress,
    createdAt: new Date(),
    startedAt: new Date(),
    completedAt: new Date(),
    report: {
      title: `${topic} Report`,
      summary: `This is a test summary about ${topic} and its impact.`,
      keyFindings: ['Finding 1', 'Finding 2'],
      sections,
      conclusions: ['Conclusion 1'],
      references: ['https://example.com'],
      generatedAt: new Date(),
      model: 'gpt-4o-mini',
    },
  };
}

describe('ReportExporter', () => {
  let exporter: ReportExporter;
  let outputDir: string;

  beforeEach(() => {
    outputDir = mkdtempSync(join(tmpdir(), 'export-test-'));
    exporter = new ReportExporter(outputDir);
  });

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  const result = createMockResult('AI Technology');

  it('should export markdown', async () => {
    const output = await exporter.export(result, { format: 'markdown' });
    expect(output.format).toBe('markdown');
    expect(output.content).toContain('# AI Technology Report');
    expect(output.content).toContain('Finding 1');
    expect(output.content).toContain('Conclusion 1');
    expect(output.mimeType).toBe('text/markdown');
  });

  it('should export JSON', async () => {
    const output = await exporter.export(result, { format: 'json' });
    expect(output.format).toBe('json');
    const parsed = JSON.parse(output.content);
    expect(parsed.id).toBe(result.id);
    expect(parsed.query.topic).toBe('AI Technology');
    expect(output.mimeType).toBe('application/json');
  });

  it('should export HTML', async () => {
    const output = await exporter.export(result, { format: 'html' });
    expect(output.format).toBe('html');
    expect(output.content).toContain('<!DOCTYPE html>');
    expect(output.content).toContain('AI Technology Report');
    expect(output.mimeType).toBe('text/html');
  });

  it('should export to file', async () => {
    const filePath = await exporter.exportToFile(result, { format: 'markdown' });
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('AI Technology Report');
  });

  it('should throw error for empty result', async () => {
    const emptyResult = createMockResult();
    emptyResult.report = undefined;
    await expect(exporter.export(emptyResult, { format: 'markdown' })).rejects.toThrow();
  });

  it('should handle includeSources=false', async () => {
    const output = await exporter.export(result, { format: 'markdown', includeSources: false });
    expect(output.content).not.toContain('https://example.com/1');
  });
});
