/**
 * Tests: Final Report gabungan (induk + sub-query) builder markdown
 */

import { describe, it, expect } from 'vitest';
import { v4 as uuid } from 'uuid';

import { buildFinalReportMarkdown } from '../src/export/final-report.js';
import type { ResearchResult, Source, ResearchReport } from '../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSource(title: string): Source {
  return {
    id: uuid(),
    title,
    url: `https://example.com/${title}`,
    content: `Content ${title}`,
    sourceType: 'web',
    metadata: { wordCount: 10 },
    collectedAt: new Date(),
  };
}

function createReport(topic: string): ResearchReport {
  return {
    title: `Report: ${topic}`,
    summary: `Ringkasan tentang ${topic}.`,
    keyFindings: [`Temuan 1 ${topic}`, `Temuan 2 ${topic}`],
    sections: [{ heading: `Bagian ${topic}`, content: `Isi bagian ${topic}.` }],
    conclusions: [`Kesimpulan ${topic}`],
    references: ['https://example.com/ref'],
    generatedAt: new Date(),
  };
}

function createResult(id: string, topic: string, opts?: { parentId?: string; status?: ResearchResult['status']; report?: ResearchReport | null; sources?: Source[] }): ResearchResult {
  return {
    id,
    query: { topic, depth: 'medium', maxSources: 5, parentContext: undefined },
    status: opts?.status ?? 'completed',
    sources: opts?.sources ?? [createSource(topic)],
    report: opts?.report !== null ? (opts?.report ?? createReport(topic)) : undefined,
    progress: { phase: 'done', percent: 100, message: 'done' },
    createdAt: new Date(),
    parentId: opts?.parentId,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildFinalReportMarkdown', () => {
  it('menyusun header + blok induk + blok sub-query', () => {
    const root = createResult('root', 'Rahadiana Nugraha');
    const child = createResult('child', 'Proyek GitHub', { parentId: 'root' });

    const md = buildFinalReportMarkdown(root, [root, child]);

    expect(md).toContain('# Final Report: Rahadiana Nugraha');
    expect(md).toContain('2 riset dalam 1 pohon');
    expect(md).toContain('## 1. Rahadiana Nugraha');
    expect(md).toContain('### 2. Proyek GitHub');
    expect(md).toContain('Ringkasan tentang Rahadiana Nugraha.');
    expect(md).toContain('Ringkasan tentang Proyek GitHub.');
  });

  it('blok induk muncul sebelum sub-query', () => {
    const root = createResult('root', 'Induk');
    const child = createResult('child', 'Anak', { parentId: 'root' });

    const md = buildFinalReportMarkdown(root, [root, child]);

    expect(md.indexOf('## 1. Induk')).toBeLessThan(md.indexOf('### 2. Anak'));
  });

  it('sub-query tanpa report → catatan status, bukan error', () => {
    const root = createResult('root', 'Induk');
    const running = createResult('child', 'Anak', { parentId: 'root', status: 'running', report: null });

    const md = buildFinalReportMarkdown(root, [root, running]);

    expect(md).toContain('Belum ada report');
    expect(md).toContain('Sedang berjalan');
    expect(md).not.toContain('Ringkasan tentang Anak.');
  });

  it('sub-query gagal → menampilkan pesan error', () => {
    const root = createResult('root', 'Induk');
    const failed = createResult('child', 'Anak', {
      parentId: 'root',
      status: 'failed',
      report: null,
    });
    failed.error = 'Waktu habis';

    const md = buildFinalReportMarkdown(root, [root, failed]);

    expect(md).toContain('Waktu habis');
    expect(md).toContain('Gagal');
  });

  it('grandchild (sub-sub-query) memakai heading lebih dalam', () => {
    const root = createResult('root', 'Induk');
    const child = createResult('child', 'Anak', { parentId: 'root' });
    const grandchild = createResult('grand', 'Cucu', { parentId: 'child' });

    const md = buildFinalReportMarkdown(root, [root, child, grandchild]);

    expect(md).toContain('## 1. Induk');
    expect(md).toContain('### 2. Anak');
    expect(md).toContain('#### 3. Cucu');
  });

  it('riset tunggal tanpa child tetap valid', () => {
    const root = createResult('root', 'Solo');

    const md = buildFinalReportMarkdown(root, [root]);

    expect(md).toContain('1 riset dalam 1 pohon');
    expect(md).toContain('## 1. Solo');
    expect(md).not.toContain('### 2.');
  });

  it('membersihkan HTML/script dari konten report', () => {
    const root = createResult('root', 'Induk');
    root.report!.summary = 'Ringkasan <style>table{display:none}</style><script>alert(1)</script> bersih.';

    const md = buildFinalReportMarkdown(root, [root]);

    expect(md).not.toContain('<style');
    expect(md).not.toContain('<script');
    expect(md).toContain('Ringkasan');
    expect(md).toContain('bersih.');
  });

  it('menampilkan metadata status/sumber/depth', () => {
    const root = createResult('root', 'Induk');

    const md = buildFinalReportMarkdown(root, [root]);

    expect(md).toContain('**Status:** Selesai');
    expect(md).toContain('**Sumber:** 1');
    expect(md).toContain('**Depth:** medium');
  });
});
