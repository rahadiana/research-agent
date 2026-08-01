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
import { splitIntoParagraphs, sanitizeReportMarkdown } from '../src/dashboard/server.js';
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

  it('JSON terpotong (unbalanced braces) → summary TIDAK berupa JSON mentah', () => {
    // Bug: LLM output terpotong di tengah — fallback lama menyalin JSON mentah sebagai summary
    const raw = '{"title":"Profil X","summary":"Ringkasan nyata yang bagus sekali untuk topik ini","keyFindings":["F1","F2"],"sections":[';

    const report = parseReportResponse(raw, QUERY, createSources());

    // Summary harus berisi teks yang diselamatkan dari field summary JSON
    expect(report.summary).toContain('Ringkasan nyata yang bagus');
    // ...BUKAN JSON mentah
    expect(report.summary.startsWith('{"')).toBe(false);
    expect(report.summary).not.toContain('"title"');
    assertNoEmptyPlaceholder(report);
  });

  it('JSON terpotong tanpa field summary → fallback ke ringkasan source', () => {
    const raw = '{"title":"Profil X","keyFindings":["F1","F2"],"sections":[{"heading":"A","content":"';

    const report = parseReportResponse(raw, QUERY, createSources());

    assertNoEmptyPlaceholder(report);
    expect(report.summary.startsWith('{"')).toBe(false);
    expect(report.summary).not.toContain('"keyFindings"');
  });
});

// ---------------------------------------------------------------------------
// splitIntoParagraphs (dashboard rendering — Summary & Report sections)
// ---------------------------------------------------------------------------

describe('splitIntoParagraphs', () => {
  it('tidak membuang teks di depan titik internal domain (bug "nusantaracode.com")', () => {
    const text =
      'Laporan ini memetakan profil digital Rahadiana Nugraha yang tersebar di GitHub, LinkedIn, blog pribadi, serta platform nusantaracode.com. Berdasarkan analisis 15 sumber, Rahadiana tampil sebagai individu yang sangat mengandalkan shell scripting.';

    const parts = splitIntoParagraphs(text);

    // Teks awal KALIMAT PERTAMA tidak boleh hilang
    const joined = parts.join(' ');
    expect(joined).toContain('Laporan ini memetakan profil digital');
    expect(joined).toContain('nusantaracode.com. Berdasarkan');
    expect(joined).toContain('Berdasarkan analisis 15 sumber');
  });

  it('singkatan dengan titik internal (e.g., U.S.A.) tidak memecah kalimat', () => {
    const text = 'Beberapa negara seperti U.S.A. dan U.K. memiliki aturan berbeda. Ini kalimat kedua yang panjang sekali.';

    const parts = splitIntoParagraphs(text);

    const joined = parts.join(' ');
    expect(joined).toContain('U.S.A. dan U.K. memiliki aturan berbeda.');
    expect(joined).toContain('Ini kalimat kedua');
  });

  it('kalimat normal tidak ada yang hilang (gabungan tetap utuh)', () => {
    const text = 'Kalimat pertama berakhir di sini. Kalimat kedua dimulai dengan huruf kapital. Kalimat ketiga juga!';

    const parts = splitIntoParagraphs(text);
    const joined = parts.join(' ');

    expect(joined).toContain('Kalimat pertama berakhir di sini.');
    expect(joined).toContain('Kalimat kedua dimulai');
    expect(joined).toContain('Kalimat ketiga juga!');
  });

  it('banyak kalimat (>6) → dipecah jadi beberapa paragraf', () => {
    const text = Array.from(
      { length: 8 },
      (_, i) => `Kalimat nomor ${i + 1} dengan isi yang cukup panjang dan jelas.`,
    ).join(' ');

    const parts = splitIntoParagraphs(text);

    expect(parts.length).toBeGreaterThan(1);
    // Semua kalimat tetap ada
    for (let i = 1; i <= 8; i++) {
      expect(parts.join(' ')).toContain(`Kalimat nomor ${i}`);
    }
  });

  it('prioritas double newline', () => {
    const text = 'Paragraf satu dengan titik di tengah example.com domain.\n\nParagraf dua.';

    const parts = splitIntoParagraphs(text);

    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('example.com');
  });

  it('teks kosong → []', () => {
    expect(splitIntoParagraphs('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// sanitizeReportMarkdown (link relatif artifact Google cache)
// ---------------------------------------------------------------------------

describe('sanitizeReportMarkdown', () => {
  it('menetralkan <a href="/path">teks</a> relatif → teks (bug /httpservice)', () => {
    const md =
      'Klik <a href="/httpservice/retry/enablejs?sei=abc123">di sini</a> jika Anda tak dialihkan.';

    const cleaned = sanitizeReportMarkdown(md);

    expect(cleaned).not.toContain('href="/httpservice');
    expect(cleaned).toContain('di sini');
    expect(cleaned).toContain('jika Anda tak dialihkan');
  });

  it('menetralkan link markdown relatif [teks](/path)', () => {
    const md = 'Lihat [panduan](/httpservice/retry/enablejs) untuk detail.';

    const cleaned = sanitizeReportMarkdown(md);

    expect(cleaned).not.toContain('](/');
    expect(cleaned).toContain('panduan');
  });

  it('menghapus <meta ... url=...> refresh', () => {
    const md = '<meta content="0;url=/httpservice/retry/enablejs?sei=1" http-equiv="refresh">';

    const cleaned = sanitizeReportMarkdown(md);

    expect(cleaned).not.toContain('/httpservice');
  });

  it('TIDAK menyentuh link absolut (http/https)', () => {
    const md = 'Sumber: <a href="https://github.com/rahadiana">GitHub</a> dan [blog](https://rahadiana.blogspot.com/).';

    const cleaned = sanitizeReportMarkdown(md);

    expect(cleaned).toContain('href="https://github.com/rahadiana"');
    expect(cleaned).toContain('](https://rahadiana.blogspot.com/)');
  });
});

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
