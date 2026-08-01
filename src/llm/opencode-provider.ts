/**
 * OpenCode Provider — LLM Provider menggunakan OpenCode SDK
 *
 * Menggunakan @opencode-ai/sdk untuk mengakses LLM via opencode server.
 * Connect ke server opencode yang sudah running, atau auto-start.
 *
 * @module llm/opencode-provider
 */

import type { LLMProvider, ResearchReport, ReportSection, Source, ResearchQuery } from '../types/index.js';

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Instruksi bahasa untuk prompt — LLM akan otomatis menyesuaikan
 * dengan bahasa yang digunakan pada input user.
 */
const LANG_INSTRUCTION = 'Gunakan bahasa yang SAMA dengan bahasa yang digunakan pada input/user.';

// ─── JSON Report Parsing (module-level, testable) ──────────────────

/**
 * Ekstrak JSON object dari teks LLM response.
 * Handle markdown code blocks, teks sebelum/sesudah, nested braces.
 */
function extractJSON(text: string): Record<string, unknown> | null {
  if (!text) return null;

  // Strategy 1: Coba parse langsung
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // lanjut
  }

  // Strategy 2: Hapus markdown code blocks, lalu coba parse
  const noCodeBlock = text
    .replace(/```(?:json|javascript)?\s*/gi, '')
    .replace(/\s*```/g, '')
    .trim();
  if (noCodeBlock !== text) {
    try {
      return JSON.parse(noCodeBlock) as Record<string, unknown>;
    } catch {
      // lanjut
    }
  }

  // Strategy 3: Cari JSON object ({...}) dengan brace counting
  for (let startIdx = 0; startIdx < text.length; startIdx++) {
    if (text[startIdx] === '{') {
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let i = startIdx; i < text.length; i++) {
        const ch = text[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"' && !escape) { inString = !inString; continue; }
        if (!inString) {
          if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            if (depth === 0) {
              const candidate = text.substring(startIdx, i + 1);
              try {
                const parsed = JSON.parse(candidate) as Record<string, unknown>;
                if (parsed && typeof parsed === 'object') return parsed;
              } catch {
                // continue searching
              }
              break;
            }
          }
        }
      }
    }
  }

  // Strategy 4: Cari array JSON ([...]) — kadang LLM return array of objects
  for (let startIdx = 0; startIdx < text.length; startIdx++) {
    if (text[startIdx] === '[') {
      let depth = 0;
      let inString = false;
      let escape = false;
      let inBracket = false;
      for (let i = startIdx; i < text.length; i++) {
        const ch = text[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"' && !escape) { inString = !inString; continue; }
        if (!inString) {
          if (ch === '[') { depth++; inBracket = true; }
          else if (ch === ']') {
            depth--;
            if (inBracket && depth === 0) {
              const candidate = text.substring(startIdx, i + 1);
              try {
                const parsed = JSON.parse(candidate);
                if (Array.isArray(parsed)) return { items: parsed };
              } catch {
                // continue
              }
              break;
            }
          }
        }
      }
    }
  }

  return null;
}

/**
 * Validasi bahwa objek hasil parse benar-benar punya struktur report riset.
 * Tanpa validasi ini, LLM yang merespon JSON valid-tapi-salah-struktur
 * (misal {"message": "..."} atau output terpotong) menghasilkan report kosong.
 */
function isValidReportShape(parsed: Record<string, unknown>): boolean {
  const hasTitle = typeof parsed.title === 'string' && parsed.title.trim().length > 0;
  const hasSummary = typeof parsed.summary === 'string' && parsed.summary.trim().length > 0;
  const hasFindings = Array.isArray(parsed.keyFindings) && parsed.keyFindings.length > 0;
  const hasSections = Array.isArray(parsed.sections) && parsed.sections.length > 0;
  return hasTitle || hasSummary || hasFindings || hasSections;
}

/**
 * Fallback: bangun report yang BERGUNA dari raw LLM output dan/atau sources.
 * Prioritas sections: (1) markdown headings di raw output, (2) per-source.
 * Tidak pernah menghasilkan placeholder kosong seperti "Ringkasan tidak tersedia."
 */
function buildFallbackReport(raw: string, query: ResearchQuery, sources: Source[]): ResearchReport {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const sections: ReportSection[] = [];

  // 1) Coba parse markdown headings dari raw LLM output
  let current: ReportSection | null = null;
  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headingMatch) {
      current = { heading: headingMatch[1]!, content: '' };
      sections.push(current);
    } else if (current) {
      current.content += line + '\n';
    }
  }

  // 2) Raw tidak punya struktur — bangun sections dari sources yang terkumpul
  if (sections.length === 0) {
    for (const source of sources.slice(0, 10)) {
      const content = (source.content || source.summary || '').replace(/\s+/g, ' ').trim();
      if (content.length > 40) {
        sections.push({ heading: source.title || source.url, content: content.slice(0, 4000) });
      }
    }
  }

  const rawSummary = lines.slice(0, 5).join(' ');

  // JANGAN jadikan teks JSON mentah sebagai summary (output LLM terpotong/tidak valid).
  // Urutan prioritas:
  //   1. Raw text biasa (bukan JSON)
  //   2. Salvage field "summary" dari JSON terpotong
  //   3. Ringkasan dari source
  //   4. Kalimat generik
  const trimmedRaw = rawSummary.trim();
  const looksLikeJson = trimmedRaw.startsWith('{') || trimmedRaw.startsWith('[');

  let summary = '';
  if (!looksLikeJson) {
    summary = rawSummary;
  } else {
    // Coba ambil "summary":"..." dari JSON (mungkin terpotong setelahnya)
    const salvageMatch = trimmedRaw.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
    if (salvageMatch?.[1]) {
      try {
        summary = JSON.parse(`"${salvageMatch[1]}"`) as string;
      } catch {
        // escapes rusak — abaikan, lanjut ke source summary
      }
    }
  }

  if (!summary.trim()) {
    summary =
      sources.find((s) => s.summary)?.summary ||
      `Laporan untuk topik "${query.topic}" disusun dari ${sources.length} sumber yang berhasil dikumpulkan.`;
  }

  return {
    title: `Laporan: ${query.topic}`,
    summary: summary.slice(0, 2000),
    keyFindings: [],
    sections,
    conclusions: [],
    references: sources.map((s) => s.url),
    generatedAt: new Date(),
  };
}

/**
 * Parse response LLM menjadi ResearchReport.
 * - JSON valid + struktur report lengkap → gunakan langsung
 * - JSON valid tapi salah struktur → fallback (bangun dari sources)
 * - Bukan JSON sama sekali → fallback (markdown headings / sources)
 */
export function parseReportResponse(raw: string, query: ResearchQuery, sources: Source[]): ResearchReport {
  const parsed = extractJSON(raw);

  if (parsed && isValidReportShape(parsed)) {
    const sections: ReportSection[] = ((parsed.sections as Array<{
      heading?: string;
      content?: string;
      subsections?: Array<{ heading?: string; content?: string }>;
    }>) ?? [])
      .filter((s) => s && typeof s === 'object')
      .map((s) => ({
        heading: s.heading ?? '',
        content: s.content ?? '',
        subsections: s.subsections?.map((sub) => ({
          heading: sub.heading ?? '',
          content: sub.content ?? '',
        })),
      }));

    const summary = ((parsed.summary as string) ?? '').trim();
    return {
      title: (parsed.title as string) || `Laporan: ${query.topic}`,
      // Jangan biarkan summary kosong — turunkan dari section pertama jika perlu
      summary: summary || sections[0]?.content?.slice(0, 500) || '',
      keyFindings: (parsed.keyFindings as string[]) || [],
      sections,
      conclusions: (parsed.conclusions as string[]) || [],
      references: (parsed.references as string[]) || sources.map((s) => s.url),
      generatedAt: new Date(),
    };
  }

  return buildFallbackReport(raw, query, sources);
}

// ─── Types ─────────────────────────────────────────────────────

export interface OpenCodeConfig {
  /** Base URL server opencode (default: http://localhost:4096) */
  baseUrl?: string;
  /** Timeout untuk prompt (ms, default: 120000) */
  timeout?: number;
  /** Auto-start server sendiri jika tidak ada yang running */
  autoStart?: boolean;
  /** Model ID untuk prompt (format: "providerID/modelID", default: auto) */
  model?: string;
}

// ─── OpenCode Provider ────────────────────────────────────────

export class OpenCodeProvider implements LLMProvider {
  private client: Awaited<ReturnType<typeof import('@opencode-ai/sdk')['createOpencodeClient']>> | null = null;
  private server: Awaited<ReturnType<typeof import('@opencode-ai/sdk')['createOpencode']>> | null = null;
  private config: Required<OpenCodeConfig>;
  private currentSessionId: string | null = null;

  private parsedModel: { providerID: string; modelID: string } | null = null;

  constructor(config: OpenCodeConfig = {}) {
    this.config = {
      baseUrl: config.baseUrl ?? 'http://localhost:4096',
      timeout: config.timeout ?? 120000,
      autoStart: config.autoStart ?? false,
      model: config.model ?? '',
    };
    if (this.config.model) {
      const parts = this.config.model.split('/');
      if (parts.length === 2) {
        this.parsedModel = { providerID: parts[0], modelID: parts[1] };
      } else {
        this.parsedModel = { providerID: '', modelID: this.config.model };
      }
    }
  }

  /**
   * Inisialisasi koneksi ke opencode server
   */
  async initialize(): Promise<void> {
    if (this.client) return;

    try {
      // Coba connect ke server yang sudah running
      const { createOpencodeClient } = await import('@opencode-ai/sdk');
      this.client = createOpencodeClient({
        baseUrl: this.config.baseUrl,
        throwOnError: true,
      });

      // Test koneksi dengan list sessions (paling ringan)
      await this.client.session.list();
      console.log(`[OpenCode] Terkoneksi ke server ${this.config.baseUrl}`);
    } catch {
      if (this.config.autoStart) {
        console.log('[OpenCode] Mencoba start server sendiri...');
        await this.startOwnServer();
      } else {
        throw new Error(
          `Tidak bisa connect ke opencode server di ${this.config.baseUrl}. ` +
          'Pastikan opencode sedang berjalan (jalankan "opencode" di terminal lain), ' +
          'atau set autoStart: true. ' +
          'Lihat docs: https://opencode.ai/docs/sdk/',
        );
      }
    }

    // Buat session untuk prompt
    await this.createSession();
  }

  /**
   * Start opencode server sendiri
   */
  private async startOwnServer(): Promise<void> {
    try {
      const sdk = await import('@opencode-ai/sdk');
      this.server = await sdk.createOpencode({
        hostname: '127.0.0.1',
        port: 0, // random port
        timeout: 30000,
      });
      this.server.server.url;
      this.client = this.server.client;
      console.log(`[OpenCode] Server started`);
    } catch (err) {
      throw new Error(
        `Gagal start opencode server: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Buat session baru untuk prompt
   */
  private async createSession(): Promise<void> {
    if (!this.client) throw new Error('OpenCode client belum diinisialisasi');

    // Cleanup session lama
    if (this.currentSessionId) {
      try {
        await this.client.session.delete({ path: { id: this.currentSessionId } });
      } catch {
        // ignore
      }
    }

    const response = await this.client.session.create({
      body: { title: 'Research Agent - Provider' },
    });
    if (!response.data) {
      throw new Error('Gagal membuat session: response.data undefined');
    }
    this.currentSessionId = response.data.id;
  }

  /**
   * Kirim prompt ke opencode dan dapatkan response text
   */
  private async prompt(
    text: string,
    options?: { system?: string },
  ): Promise<string> {
    if (!this.client || !this.currentSessionId) {
      throw new Error('OpenCodeProvider belum diinisialisasi. Panggil initialize() dulu.');
    }

    const parts: Array<{ type: 'text'; text: string }> = [];
    parts.push({ type: 'text', text });

    const body: {
      parts: Array<{ type: 'text'; text: string }>;
      system?: string;
      model?: { providerID: string; modelID: string };
    } = { parts };

    if (this.parsedModel) {
      body.model = this.parsedModel;
    }

    if (options?.system) {
      body.system = options.system;
    }

    const response = await this.client.session.prompt({
      path: { id: this.currentSessionId },
      body,
    });

    if (!response.data || !response.data.parts) {
      return '';
    }

    // Cari text dari parts response
    const textParts = response.data.parts.filter(
      (p): p is { type: 'text'; text: string } & typeof p =>
        p.type === 'text' && 'text' in p,
    );

    if (textParts.length > 0) {
      return textParts.map((p) => p.text).join('\n').trim();
    }

    return '';
  }

  // ─── LLMProvider Interface ─────────────────────────────────

  async summarize(text: string, maxLength?: number): Promise<string> {
    if (!text.trim()) return '';

    const lengthInstruction = maxLength
      ? `\nBuat ringkasan maksimal ${maxLength} karakter.`
      : '';

    const result = await this.prompt(
      `Ringkas teks berikut:\n\n${text.slice(0, 50000)}${lengthInstruction}`,
      {
        system:
          'Anda adalah asisten riset yang ahli. Ringkas teks dengan presisi tinggi, ' +
          `pertahankan fakta kunci, data penting, dan temuan utama. ${LANG_INSTRUCTION}`,
      },
    );

    return result || 'Ringkasan tidak tersedia.';
  }

  async synthesize(sources: Source[], query: ResearchQuery): Promise<ResearchReport> {
    const sourcesText = sources
      .map(
        (s, i) =>
          `[Sumber ${i + 1}]
Judul: ${s.title}
URL: ${s.url}
Konten: ${(s.content || s.summary || '').slice(0, 8000)}
---`,
      )
      .join('\n\n');

    const questionsText =
      query.questions && query.questions.length > 0
        ? `\nPertanyaan Spesifik:\n${query.questions.map((q) => `- ${q}`).join('\n')}`
        : '';

    const prompt = `Topik: ${query.topic}
Kedalaman: ${query.depth ?? 'medium'}
Jumlah Sumber: ${sources.length}${questionsText}

Sumber-sumber:
${sourcesText.slice(0, 100000)}

INSTRUKSI: Buat laporan riset komprehensif berdasarkan sumber di atas.
Kembalikan HANYA SATU OBJEK JSON valid — tanpa kata pengantar, tanpa markdown, tanpa \`\`\`,
tanpa teks tambahan, tanpa file. AWALI dengan { dan AKHIRI dengan }.
JSON harus bisa di-parse dengan JSON.parse().

Struktur JSON:
{
  "title": "Judul laporan",
  "summary": "Ringkasan eksekutif 2-3 paragraf (konten LENGKAP, bukan meta-deskripsi)",
  "keyFindings": ["Temuan kunci 1", "Temuan kunci 2", ...],
  "sections": [
    {
      "heading": "Judul section",
      "content": "Konten section lengkap dan detail (minimal 3-5 paragraf per section)",
      "subsections": [
        { "heading": "Sub judul", "content": "Konten sub" }
      ]
    }
  ],
  "conclusions": ["Kesimpulan 1", "Kesimpulan 2", ...],
  "references": ["URL sumber 1", "URL sumber 2", ...]
}

REQUIRED: title, summary, keyFindings (min 3), sections (min 2), conclusions (min 2), references.
Jika tidak yakin, tetap return JSON VALID dengan field-field tersebut.`;

    const result = await this.prompt(prompt, {
      system:
        'Anda adalah analis riset senior yang ahli membuat laporan terstruktur. ' +
        'Anda HANYA boleh merespon dengan SATU OBJEK JSON VALID. ' +
        'Tidak ada teks lain, tidak ada markdown, tidak ada \`\`\`. ' +
        'Tidak menggunakan tool/file — cukup return JSON langsung. ' +
        `JSON WAJIB memiliki field: title, summary, keyFindings, sections, conclusions, references. ` +
        `${LANG_INSTRUCTION}`,
    });

    // Parse JSON response dengan multiple strategies + validasi struktur.
    // Jika LLM return JSON valid-tapi-salah-struktur, parseReportResponse
    // akan fallback ke report berbasis sources (tidak pernah kosong).
    return parseReportResponse(result, query, sources);
  }

  async answer(question: string, context: string): Promise<string> {
    if (!context.trim()) return 'Tidak ada konteks yang diberikan untuk menjawab pertanyaan.';

    const result = await this.prompt(
      `Konteks:\n${context.slice(0, 60000)}\n\nPertanyaan: ${question}`,
      {
        system:
          'Anda adalah asisten riset yang knowledgeable. Jawab pertanyaan berdasarkan konteks yang diberikan. ' +
          `Jika jawaban tidak ditemukan di konteks, katakan dengan jujur. ${LANG_INSTRUCTION}`,
      },
    );

    return result || 'Tidak bisa menghasilkan jawaban.';
  }

  /**
   * Cleanup session
   */
  async cleanup(): Promise<void> {
    if (this.currentSessionId && this.client) {
      try {
        await this.client.session.delete({ path: { id: this.currentSessionId } });
      } catch {
        // ignore
      }
      this.currentSessionId = null;
    }
  }
}
