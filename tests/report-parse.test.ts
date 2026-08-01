/**
 * Regression tests: parsing response LLM → ResearchReport.
 *
 * Bug yang di-fix: LLM mengembalikan JSON valid tapi BUKAN struktur report
 * (misal {"message": ...} atau output terpotong) → report jadi kosong
 * dengan placeholder "Ringkasan tidak tersedia.".
 */

import { describe, it, expect } from 'vitest';

import { parseReportResponse } from '../src/llm/opencode-provider.js';
import { OpenAIProvider } from '../src/llm/llm-client.js';
import type { ResearchQuery, Source, ResearchReport } from '../src/types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSources(): Source[] {
  return [
    {
      id: 's1',
      title: 'Sumber Pertama',
      url: 'https://example.com/1',
      content: 'Konten panjang sumber pertama tentang topik riset dengan banyak detail bermanfaat.',
      summary: 'Ringkasan sumber pertama.',
      sourceType: 'web',
      metadata: { wordCount: 20 },
      collectedAt: new Date(),
    },
    {
      id: 's2',
      title: 'Sumber Kedua',
      url: 'https://example.com/2',
      content: 'Konten sumber kedua yang menjelaskan aspek teknis dan temuan penting lainnya.',
      summary: 'Ringkasan sumber kedua.',
      sourceType: 'web',
      metadata: { wordCount: 20 },
      collectedAt: new Date(),
    },
  ];
}

const QUERY: ResearchQuery = { topic: 'Topik Uji', depth: 'medium', maxSources: 5 };

function assertNoEmptyPlaceholder(report: ResearchReport): void {
  expect(report.summary.trim().length).toBeGreaterThan(0);
  expect(report.summary).not.toBe('Ringkasan tidak tersedia.');
  expect(report.summary).not.toBe('');
}

// ---------------------------------------------------------------------------
// parseReportResponse (OpenCode provider — module function)
// ---------------------------------------------------------------------------

describe('parseReportResponse (OpenCode)', () => {
  it('memakai JSON valid dengan struktur report lengkap', () => {
    const raw = JSON.stringify({
      title: 'Judul dari LLM',
      summary: 'Ringkasan dari LLM.',
      keyFindings: ['Temuan 1'],
      sections: [{ heading: 'Analisis', content: 'Konten analisis.' }],
      conclusions: ['Kesimpulan 1'],
      references: ['https://ref.com'],
    });

    const report = parseReportResponse(raw, QUERY, createSources());

    expect(report.title).toBe('Judul dari LLM');
    expect(report.summary).toBe('Ringkasan dari LLM.');
    expect(report.keyFindings).toEqual(['Temuan 1']);
    expect(report.sections).toHaveLength(1);
    expect(report.conclusions).toEqual(['Kesimpulan 1']);
  });

  it('JSON valid tapi salah struktur (bug lama) → fallback berbasis sources', () => {
    // Persis kasus bug: LLM return objek JSON yang bukan report
    const raw = JSON.stringify({ message: 'Saya tidak bisa membuat laporan saat ini.' });

    const report = parseReportResponse(raw, QUERY, createSources());

    assertNoEmptyPlaceholder(report);
    // Sections harus dibangun dari sources (judul sumber jadi heading)
    expect(report.sections.length).toBeGreaterThan(0);
    expect(report.sections[0].heading).toContain('Sumber');
    expect(report.references).toHaveLength(2);
  });

  it('JSON dalam markdown code block tetap dipakai jika strukturnya benar', () => {
    const raw = '```json\n' + JSON.stringify({ title: 'T', summary: 'S', keyFindings: ['F'] }) + '\n```';

    const report = parseReportResponse(raw, QUERY, createSources());

    expect(report.title).toBe('T');
    expect(report.summary).toBe('S');
  });

  it('response markdown biasa (bukan JSON) → sections dari headings', () => {
    const raw = '# Laporan Uji\n\n## Bagian Satu\n\nIsi bagian satu.\n\n## Bagian Dua\n\nIsi bagian dua.';

    const report = parseReportResponse(raw, QUERY, createSources());

    // Heading level 1 juga jadi section (konsisten dengan logika fallback lama)
    expect(report.sections.length).toBe(3);
    expect(report.sections.map((s) => s.heading)).toEqual(['Laporan Uji', 'Bagian Satu', 'Bagian Dua']);
    assertNoEmptyPlaceholder(report);
  });

  it('garbage total → fallback sections dari sources, summary tidak kosong', () => {
    const report = parseReportResponse('garbage tanpa struktur sama sekali', QUERY, createSources());

    assertNoEmptyPlaceholder(report);
    expect(report.sections.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// OpenAIProvider.parseSynthesisResponse (private method, dipanggil via cast)
// ---------------------------------------------------------------------------

describe('OpenAIProvider.parseSynthesisResponse', () => {
  const provider = new OpenAIProvider({ apiKey: 'sk-test' }) as unknown as {
    parseSynthesisResponse(raw: string, query: ResearchQuery, sources: Source[]): ResearchReport;
  };

  it('JSON valid dengan struktur lengkap → dipakai langsung', () => {
    const raw = JSON.stringify({
      title: 'T',
      summary: 'Ringkasan bagus.',
      keyFindings: ['F1'],
      sections: [{ heading: 'H', content: 'C' }],
    });

    const report = provider.parseSynthesisResponse(raw, QUERY, createSources());

    expect(report.title).toBe('T');
    expect(report.summary).toBe('Ringkasan bagus.');
    expect(report.sections).toHaveLength(1);
  });

  it('JSON valid tapi salah struktur → fallback (sections dari sources)', () => {
    const raw = JSON.stringify({ error: 'rate limited', detail: 'coba lagi' });

    const report = provider.parseSynthesisResponse(raw, QUERY, createSources());

    assertNoEmptyPlaceholder(report);
    expect(report.sections.length).toBeGreaterThan(0);
    expect(report.sections[0].heading).toContain('Sumber');
  });

  it('summary kosong tapi sections ada → summary diturunkan dari section pertama', () => {
    const raw = JSON.stringify({
      title: 'Judul',
      sections: [{ heading: 'Pendahuluan', content: 'Konten pendahuluan yang informatif.' }],
    });

    const report = provider.parseSynthesisResponse(raw, QUERY, createSources());

    expect(report.summary).toBe('Konten pendahuluan yang informatif.');
    expect(report.summary).not.toBe('');
  });
});
