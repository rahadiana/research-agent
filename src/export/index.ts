/**
 * Research Agent — Export Module
 *
 * Menghasilkan report dalam berbagai format (markdown, json, html).
 */

import fs from 'fs/promises';
import path from 'path';
import { marked } from 'marked';
import type { ResearchResult, ReportSection } from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────
// 1. Types
// ─────────────────────────────────────────────────────────────────────

export type ExportFormat = 'markdown' | 'json' | 'html';

export interface ExportOptions {
  format: ExportFormat;
  includeSources?: boolean;
  includeMetadata?: boolean;
  maxSections?: number;
}

export interface ExportResult {
  filename: string;
  content: string;
  mimeType: string;
  format: ExportFormat;
}

// ─────────────────────────────────────────────────────────────────────
// 2. MIME Types
// ─────────────────────────────────────────────────────────────────────

const MIME_TYPES: Record<ExportFormat, string> = {
  markdown: 'text/markdown',
  json: 'application/json',
  html: 'text/html',
};

// ─────────────────────────────────────────────────────────────────────
// 3. Helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Mengubah teks menjadi URL-friendly slug.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

/**
 * Menghasilkan short ID acak (4 karakter hex).
 */
function shortId(): string {
  return Math.random().toString(16).slice(2, 6);
}

/**
 * Memformat tanggal ke YYYYMMDD.
 */
function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/**
 * Menghasilkan nama file sesuai konvensi:
 *   research-{topic-slug}-{date}-{short-id}.{format}
 */
function buildFilename(topic: string, format: ExportFormat, date: Date = new Date()): string {
  const slug = slugify(topic);
  const dateStr = formatDate(date);
  const id = shortId();
  return `research-${slug}-${dateStr}-${id}.${format}`;
}

/**
 * Mengambil default options dengan nilai bawaan.
 */
function resolveOptions(options: ExportOptions): Required<ExportOptions> {
  return {
    format: options.format,
    includeSources: options.includeSources ?? true,
    includeMetadata: options.includeMetadata ?? true,
    maxSections: options.maxSections ?? 0,
  };
}

// ─────────────────────────────────────────────────────────────────────
// 4. Format Generators
// ─────────────────────────────────────────────────────────────────────

/**
 * Menghasilkan representasi markdown dari report riset.
 */
function generateMarkdown(result: ResearchResult, options: Required<ExportOptions>): string {
  const report = result.report;
  if (!report) {
    throw new Error('Cannot generate markdown: report is empty');
  }

  const lines: string[] = [];

  // ── Header ──
  lines.push(`# ${report.title}`, '');

  if (options.includeMetadata) {
    const status = result.status;
    const sourceCount = result.sources.length;
    const date = result.completedAt
      ? result.completedAt.toISOString().slice(0, 10)
      : result.createdAt.toISOString().slice(0, 10);
    lines.push(`**Status:** ${status} | **Sumber:** ${sourceCount} | **Tanggal:** ${date}`, '');
  }

  // ── Ringkasan ──
  lines.push('## Ringkasan', '');
  lines.push(report.summary, '');

  // ── Temuan Kunci ──
  if (report.keyFindings.length > 0) {
    lines.push('## Temuan Kunci', '');
    for (const finding of report.keyFindings) {
      lines.push(`- ${finding}`);
    }
    lines.push('');
  }

  // ── Sections ──
  const sections =
    options.maxSections > 0
      ? report.sections.slice(0, options.maxSections)
      : report.sections;

  for (const section of sections) {
    appendSection(lines, section, 2);
  }

  // ── Kesimpulan ──
  if (report.conclusions.length > 0) {
    lines.push('## Kesimpulan', '');
    for (const conclusion of report.conclusions) {
      lines.push(`- ${conclusion}`);
    }
    lines.push('');
  }

  // ── Referensi ──
  if (options.includeSources && result.sources.length > 0) {
    lines.push('## Referensi', '');
    for (let i = 0; i < result.sources.length; i++) {
      const src = result.sources[i];
      lines.push(`${i + 1}. [${src.title}](${src.url})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Append section & subsections secara rekursif ke array lines.
 */
function appendSection(lines: string[], section: ReportSection, depth: number): void {
  const heading = '#'.repeat(depth);
  lines.push(`${heading} ${section.heading}`, '');
  lines.push(section.content, '');

  if (section.subsections) {
    for (const sub of section.subsections) {
      appendSection(lines, sub, depth + 1);
    }
  }
}

/**
 * Menghasilkan representasi JSON dari report riset.
 */
function generateJSON(result: ResearchResult, options: Required<ExportOptions>): string {
  const payload: Record<string, unknown> = {
    id: result.id,
    query: result.query,
    status: result.status,
    progress: result.progress,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    createdAt: result.createdAt,
  };

  if (result.report) {
    const reportObj: Record<string, unknown> = { ...result.report };

    if (options.maxSections > 0 && reportObj.sections) {
      reportObj.sections = (reportObj.sections as unknown[]).slice(0, options.maxSections);
    }

    payload.report = reportObj;
  }

  if (options.includeSources) {
    payload.sources = result.sources;
  }

  if (result.error) {
    payload.error = result.error;
  }

  return JSON.stringify(payload, null, 2);
}

/**
 * Menghasilkan HTML dark-theme dari report riset.
 */
function generateHTML(result: ResearchResult, options: Required<ExportOptions>): string {
  const report = result.report;
  if (!report) {
    throw new Error('Cannot generate HTML: report is empty');
  }

  const mdContent = generateMarkdown(result, options);
  const bodyHtml = marked.parse(mdContent) as string;

  // Build metadata bar
  let metaHtml = '';
  if (options.includeMetadata) {
    const status = result.status;
    const sourceCount = result.sources.length;
    const date = result.completedAt
      ? result.completedAt.toISOString().slice(0, 10)
      : result.createdAt.toISOString().slice(0, 10);
    metaHtml = `<div class="meta">Status: <strong>${status}</strong> &mdash; Sumber: <strong>${sourceCount}</strong> &mdash; Tanggal: <strong>${date}</strong></div>`;
  }

  const title = report.title;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      line-height: 1.7;
      padding: 2rem 1rem;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
      background: #161b22;
      border-radius: 12px;
      padding: 2.5rem 2rem;
      box-shadow: 0 4px 24px rgba(0,0,0,.4);
    }
    h1 { color: #f0f6fc; font-size: 2rem; border-bottom: 2px solid #30363d; padding-bottom: .5rem; margin-bottom: 1.5rem; }
    h2 { color: #58a6ff; margin-top: 2rem; margin-bottom: .75rem; }
    h3 { color: #79c0ff; margin-top: 1.5rem; margin-bottom: .5rem; }
    h4 { color: #a5d6ff; margin-top: 1rem; }
    .meta {
      background: #21262d;
      padding: .75rem 1rem;
      border-radius: 8px;
      font-size: .9rem;
      margin-bottom: 2rem;
      color: #8b949e;
    }
    .meta strong { color: #c9d1d9; }
    p { margin-bottom: 1rem; }
    ul, ol { margin: .5rem 0 1rem 1.5rem; }
    li { margin-bottom: .25rem; }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    blockquote {
      border-left: 4px solid #30363d;
      padding-left: 1rem;
      color: #8b949e;
      margin: 1rem 0;
    }
    code {
      background: #21262d;
      padding: .15rem .4rem;
      border-radius: 4px;
      font-size: .875rem;
    }
    pre {
      background: #21262d;
      padding: 1rem;
      border-radius: 8px;
      overflow-x: auto;
      margin: 1rem 0;
    }
    pre code { background: none; padding: 0; }
    hr { border: none; border-top: 1px solid #30363d; margin: 2rem 0; }
    .footer {
      text-align: center;
      color: #484f58;
      font-size: .8rem;
      margin-top: 2rem;
    }
  </style>
</head>
<body>
  <div class="container">
    ${metaHtml}
    ${bodyHtml}
    <div class="footer">Generated by Research Agent</div>
  </div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────
// 5. ReportExporter
// ─────────────────────────────────────────────────────────────────────

export class ReportExporter {
  /**
   * @param outputDir - Direktori output untuk menyimpan file hasil export.
   */
  constructor(private outputDir: string) {}

  /**
   * Mengekspor hasil riset ke string dengan format yang ditentukan.
   *
   * @param result  - Hasil riset yang akan diexport.
   * @param options - Opsi export (format, metadata, sources, dll).
   * @returns Promise<ExportResult> berisi filename, content, mimeType, dan format.
   */
  async export(result: ResearchResult, options: ExportOptions): Promise<ExportResult> {
    validateResult(result);

    const opts = resolveOptions(options);
    const topic = result.query.topic;
    const date = result.completedAt ?? result.createdAt;
    const filename = buildFilename(topic, opts.format, date);
    const mimeType = MIME_TYPES[opts.format];
    let content: string;

    switch (opts.format) {
      case 'markdown':
        content = generateMarkdown(result, opts);
        break;
      case 'json':
        content = generateJSON(result, opts);
        break;
      case 'html':
        content = generateHTML(result, opts);
        break;
      default:
        throw new Error(`Unsupported export format: ${opts.format}`);
    }

    return { filename, content, mimeType, format: opts.format };
  }

  /**
   * Mengekspor hasil riset langsung ke file di outputDir.
   *
   * @param result  - Hasil riset yang akan diexport.
   * @param options - Opsi export.
   * @returns Full path dari file yang telah dibuat.
   */
  async exportToFile(result: ResearchResult, options: ExportOptions): Promise<string> {
    const exportResult = await this.export(result, options);
    const filePath = path.join(this.outputDir, exportResult.filename);

    try {
      await fs.mkdir(this.outputDir, { recursive: true });
      await fs.writeFile(filePath, exportResult.content, 'utf-8');
    } catch (err) {
      throw new Error(
        `Failed to write export file: ${filePath} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return filePath;
  }

  /**
   * Mengekspor banyak hasil riset sekaligus.
   *
   * @param results - Array hasil riset yang akan diexport.
   * @param options - Opsi export (sama untuk semua result).
   * @returns Array ExportResult.
   */
  async exportBatch(results: ResearchResult[], options: ExportOptions): Promise<ExportResult[]> {
    return Promise.all(results.map((r) => this.export(r, options)));
  }
}

// ─────────────────────────────────────────────────────────────────────
// 6. Validation
// ─────────────────────────────────────────────────────────────────────

/**
 * Memvalidasi ResearchResult sebelum di-export.
 *
 * @throws Error jika result atau report-nya kosong / invalid.
 */
function validateResult(result: ResearchResult): void {
  if (!result) {
    throw new Error('ResearchResult is null or undefined');
  }

  if (!result.query || !result.query.topic) {
    throw new Error('ResearchResult.query.topic is required');
  }

  if (!result.report) {
    throw new Error('Cannot export: report is empty. Research has not been completed yet.');
  }

  if (!result.report.title) {
    throw new Error('ResearchResult.report.title is required');
  }
}
