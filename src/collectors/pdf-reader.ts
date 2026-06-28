/**
 * Research Agent — PDF Reader & Collector Module
 *
 * Menangani parsing PDF dari URL, file local, atau buffer,
 * chunking teks dengan overlap, serta implements SourceCollector.
 */

import { v4 as uuid } from 'uuid';
import axios from 'axios';
import * as fs from 'node:fs/promises';
import pdfParse from 'pdf-parse';
import type { ResearchQuery, Source, SourceCollector } from '../types/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PdfContent {
  text: string;
  chunks: string[];
  metadata: {
    title?: string;
    author?: string;
    pages: number;
    creationDate?: Date;
    fileSize?: number;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FILE_SIZE_LIMIT = 50 * 1024 * 1024; // 50 MB
const DOWNLOAD_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// PDFParser
// ---------------------------------------------------------------------------

export class PDFParser {
  /**
   * Parse PDF dari remote URL.
   * Download via axios dengan timeout 30 detik, lalu parse.
   */
  async parseFromUrl(url: string): Promise<PdfContent> {
    const response = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: DOWNLOAD_TIMEOUT_MS,
    });

    const buffer = Buffer.from(response.data);
    const fileSize = buffer.length;

    if (fileSize > FILE_SIZE_LIMIT) {
      throw new Error(
        `File size ${fileSize} bytes exceeds limit of ${FILE_SIZE_LIMIT} bytes`,
      );
    }

    return this._parseBuffer(buffer, fileSize);
  }

  /**
   * Parse PDF dari file path lokal.
   */
  async parseFromFile(filePath: string): Promise<PdfContent> {
    const stat = await fs.stat(filePath);

    if (stat.size > FILE_SIZE_LIMIT) {
      throw new Error(
        `File size ${stat.size} bytes exceeds limit of ${FILE_SIZE_LIMIT} bytes`,
      );
    }

    const buffer = await fs.readFile(filePath);
    return this._parseBuffer(buffer, stat.size);
  }

  /**
   * Parse PDF dari Buffer yang sudah ada di memory.
   */
  async parseFromBuffer(buffer: Buffer): Promise<PdfContent> {
    if (buffer.length > FILE_SIZE_LIMIT) {
      throw new Error(
        `Buffer size ${buffer.length} bytes exceeds limit of ${FILE_SIZE_LIMIT} bytes`,
      );
    }

    return this._parseBuffer(buffer, buffer.length);
  }

  private _chunker = new TextChunker();

  /**
   * Internal: parse buffer dengan pdf-parse, ekstrak metadata & text.
   */
  private async _parseBuffer(
    buffer: Buffer,
    fileSize: number,
  ): Promise<PdfContent> {
    if (buffer.length === 0) {
      throw new Error('Cannot parse empty PDF buffer');
    }

    let data: { text: string; numpages: number; info: Record<string, unknown> };

    try {
      data = await pdfParse(buffer);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Unknown PDF parse error';
      throw new Error(`Corrupt or invalid PDF: ${message}`);
    }

    const text = data.text ?? '';
    const pageCount = data.numpages ?? 0;

    if (pageCount === 0) {
      throw new Error('PDF appears to be empty (0 pages)');
    }

    const info = data.info ?? {};
    const creationDate = this._parseCreationDate(
      info.CreationDate as string | undefined,
    );

    const metadata: PdfContent['metadata'] = {
      title: (info.Title as string | undefined) || undefined,
      author: (info.Author as string | undefined) || undefined,
      pages: pageCount,
      creationDate,
      fileSize,
    };

    const chunks = this._chunker.chunk(text);

    return { text, chunks, metadata };
  }

  /**
   * Convert PDF date string (e.g. "D:20240315120000Z") ke Date.
   */
  private _parseCreationDate(raw: string | undefined): Date | undefined {
    if (!raw) return undefined;

    // Format: D:YYYYMMDDHHmmSS[+|-]ZZ'
    const match = raw.match(
      /^D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/,
    );
    if (!match) return undefined;

    const [, year, month, day, hour, min, sec] = match;
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(min),
      Number(sec),
    );
  }
}

// ---------------------------------------------------------------------------
// TextChunker
// ---------------------------------------------------------------------------

export class TextChunker {
  /**
   * Potong teks menjadi chunk-chunk dengan ukuran maksimal `maxChunkSize`
   * dan overlap `overlap` characters. Tidak memotong di tengah kata.
   */
  chunk(
    text: string,
    maxChunkSize = 2000,
    overlap = 200,
  ): string[] {
    if (!text) return [];

    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      let end = start + maxChunkSize;

      if (end >= text.length) {
        // Sisa teks
        const lastChunk = text.slice(start).trim();
        if (lastChunk) chunks.push(lastChunk);
        break;
      }

      // Cari word boundary sebelumnya (spasi / newline)
      end = this._findWordBoundary(text, end);

      const chunk = text.slice(start, end).trim();
      if (chunk) chunks.push(chunk);

      // Geser start dengan overlap, cari awal kata
      const nextStart = end - overlap;
      start = this._findWordStart(text, Math.max(0, nextStart));

      // Safety: pastikan progress
      if (start >= end) {
        start = end;
      }
    }

    return chunks;
  }

  /**
   * Cari posisi spasi / newline sebelum `pos`. Jika tidak ada, gunakan `pos`.
   */
  private _findWordBoundary(text: string, pos: number): number {
    // Cari mundur sampai ketemu whitespace
    for (let i = pos; i > Math.max(0, pos - 100); i--) {
      const ch = text[i];
      if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') {
        return i + 1; // potong SETELAH whitespace
      }
    }
    return pos;
  }

  /**
   * Cari awal kata setelah overlap: skip whitespace.
   */
  private _findWordStart(text: string, pos: number): number {
    for (let i = pos; i < text.length; i++) {
      const ch = text[i];
      if (ch !== ' ' && ch !== '\n' && ch !== '\t' && ch !== '\r') {
        return i;
      }
    }
    return pos;
  }
}

// ---------------------------------------------------------------------------
// PDFCollector (implements SourceCollector)
// ---------------------------------------------------------------------------

export class PDFCollector implements SourceCollector {
  name = 'pdf-collector';
  private _parser = new PDFParser();

  /**
   * Collect sources dari ResearchQuery.
   *
   * Implementasi dasar: parse PDF dari URL yang ada di query.filters?.domains.
   * Jika tidak ada, return empty array — user bisa add PDF via CLI nanti.
   */
  async collect(query: ResearchQuery): Promise<Source[]> {
    const urls = query.filters?.domains ?? [];

    if (urls.length === 0) return [];

    const results: Source[] = [];

    for (const url of urls) {
      if (!this._isPdfUrl(url)) continue;

      try {
        const source = await this.collectFromUrl(url);
        results.push(source);
      } catch (err: unknown) {
        // Skip source yang gagal, jangan throw
        const message =
          err instanceof Error ? err.message : 'Unknown error';
        console.warn(`[${this.name}] Skipping ${url}: ${message}`);
      }
    }

    return results;
  }

  /**
   * Parse satu PDF dari URL dan return sebagai Source.
   */
  async collectFromUrl(url: string): Promise<Source> {
    const content = await this._parser.parseFromUrl(url);

    return this._toSource(url, content);
  }

  /**
   * Parse satu PDF dari file path dan return sebagai Source.
   */
  async collectFromFile(filePath: string): Promise<Source> {
    const content = await this._parser.parseFromFile(filePath);

    return this._toSource(filePath, content);
  }

  /**
   * Cek apakah URL mengarah ke file PDF.
   */
  private _isPdfUrl(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.endsWith('.pdf') || lower.includes('pdf');
  }

  /**
   * Convert PdfContent ke Source.
   */
  private _toSource(identifier: string, content: PdfContent): Source {
    const title =
      content.metadata.title ??
      this._deriveTitle(identifier);

    return {
      id: uuid(),
      title,
      url: identifier,
      content: content.text,
      sourceType: 'pdf',
      metadata: {
        author: content.metadata.author,
        wordCount: content.text.split(/\s+/).filter(Boolean).length,
        fileSize: content.metadata.fileSize,
      },
      collectedAt: new Date(),
    };
  }

  /**
   * Derive title dari identifier (URL / file path) jika tidak ada metadata.
   */
  private _deriveTitle(identifier: string): string {
    const segments = identifier.replace(/\\/g, '/').split('/');
    const last = segments[segments.length - 1] ?? identifier;
    return last.replace(/\.pdf$/i, '');
  }
}
