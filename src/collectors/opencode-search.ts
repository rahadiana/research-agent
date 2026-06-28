/**
 * OpenCode Search Collector — web search via OpenCode SDK (no API key needed)
 *
 * Menggunakan @opencode-ai/sdk untuk search web via LLM + MCP tools.
 * Gak perlu SerpAPI, gak perlu API key — cukup opencode server running.
 *
 * @module collectors/opencode-search
 */

import { v4 as uuid } from 'uuid';
import * as cheerio from 'cheerio';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import axios from 'axios';
import type {
  ResearchQuery,
  Source,
  SourceCollector,
  SourceMetadata,
} from '../types/index.js';

// ── Constants ──────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 15_000;
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
];

const MAX_SNIPPET_LENGTH = 2000;
const MAX_CONTENT_LENGTH = 50_000;
const MAX_SEARCH_ROUNDS = 5;
const URLS_PER_ROUND = 8;
const URL_VALID_REGEX = /^https?:\/\/[a-zA-Z0-9][-a-zA-Z0-9.]*\.[a-zA-Z]{2,}/;

// ── Types ──────────────────────────────────────────────────────

export interface OpencodeSearchConfig {
  /** Base URL server opencode (default: http://localhost:4096) */
  baseUrl?: string;
  /** Timeout prompt (ms, default: 120000) */
  timeout?: number;
  /** Auto-start server sendiri jika tidak ada yang running */
  autoStart?: boolean;
}

interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

// ── Collector ──────────────────────────────────────────────────

export class OpencodeSearchCollector implements SourceCollector {
  name = 'opencode-search';
  private client: Awaited<ReturnType<typeof import('@opencode-ai/sdk')['createOpencodeClient']>> | null = null;
  private server: Awaited<ReturnType<typeof import('@opencode-ai/sdk')['createOpencode']>> | null = null;
  private config: Required<Pick<OpencodeSearchConfig, 'baseUrl' | 'timeout' | 'autoStart'>>;
  private sessionId: string | null = null;

  constructor(config?: OpencodeSearchConfig) {
    this.config = {
      baseUrl: config?.baseUrl ?? 'http://localhost:4096',
      timeout: config?.timeout ?? 120_000,
      autoStart: config?.autoStart ?? true,
    };
  }

  async initialize(): Promise<void> {
    if (this.client) return;

    try {
      const { createOpencodeClient } = await import('@opencode-ai/sdk');
      this.client = createOpencodeClient({
        baseUrl: this.config.baseUrl,
        throwOnError: true,
      });

      // Test koneksi
      await this.client.session.list();
    } catch {
      if (this.config.autoStart) {
        await this.startOwnServer();
      } else {
        throw new Error(
          `Tidak bisa connect ke opencode server di ${this.config.baseUrl}. ` +
          'Pastikan opencode sedang berjalan, atau set autoStart: true.',
        );
      }
    }

    await this.createSession();
  }

  private async startOwnServer(): Promise<void> {
    const sdk = await import('@opencode-ai/sdk');
    this.server = await sdk.createOpencode({
      hostname: '127.0.0.1',
      port: 0,
      timeout: 30_000,
    });
    this.client = this.server.client;
  }

  private async createSession(): Promise<void> {
    if (!this.client) throw new Error('OpenCode client not initialized');

    if (this.sessionId) {
      try { await this.client.session.delete({ path: { id: this.sessionId } }); } catch { /* ignore */ }
    }

    const res = await this.client.session.create({
      body: { title: 'Research Agent - Search' },
    });
    if (!res.data) throw new Error('Gagal membuat session: response.data undefined');
    this.sessionId = res.data.id;
  }

  private async prompt(text: string): Promise<string> {
    if (!this.client || !this.sessionId) throw new Error('Belum diinisialisasi');

    const controller = new AbortController();
    const timeoutMs = this.config.timeout;
    const timeoutId = setTimeout(() => {
      console.warn(`[OpencodeSearch] LLM prompt timeout after ${timeoutMs}ms, membatalkan...`);
      controller.abort(new DOMException(`Prompt timeout after ${timeoutMs}ms`, 'TimeoutError'));
    }, timeoutMs);

    let response;
    try {
      response = await this.client.session.prompt({
        path: { id: this.sessionId },
        body: {
          parts: [{ type: 'text' as const, text }],
          system: 'Kamu adalah search engine. Cari informasi di web — prioritaskan sumber resmi, artikel orisinil, publikasi terpercaya, dan jurnal akademik yang relevan dengan topik.',
        },
        signal: controller.signal,
      });
    } catch (err) {
      console.warn(`[OpencodeSearch] Prompt gagal: ${err instanceof Error ? err.message : err}`);
      return '';
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.data?.parts) return '';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const textParts = (response.data.parts as any[]).filter(
      (p) => p.type === 'text' && typeof p.text === 'string',
    );

    return textParts.map((p: { text: string }) => p.text).join('\n').trim();
  }

  /**
   * Cari web via opencode LLM (multi-round), lalu scrape konten tiap URL.
   *
   * Multi-round: LLM per round cuma minta 8 URL biar lebih realistis,
   * diulang dengan angle pencarian berbeda sampai target maxSources terpenuhi.
   */
  async collect(query: ResearchQuery): Promise<Source[]> {
    await this.ensureReady();

    const maxSources = query.maxSources ?? 10;
    const depth = query.depth ?? 'medium';
    const rounds = depth === 'deep' ? MAX_SEARCH_ROUNDS : Math.min(MAX_SEARCH_ROUNDS, Math.ceil(maxSources / URLS_PER_ROUND));

    // ── Multi-round search via opencode LLM ──────────────────
    const allSearchResults: SearchResultItem[] = [];
    const seenUrls = new Set<string>();
    const questionsText = query.questions?.length
      ? `\nPertanyaan spesifik:\n${query.questions.map((q) => `- ${q}`).join('\n')}`
      : '';

    for (let round = 0; round < rounds; round++) {
      const remaining = maxSources - allSearchResults.length;
      if (remaining <= 0) break;

      // Minta lebih sedikit per round — LLM lebih akurat dengan 5-8 URL
      const askCount = Math.min(URLS_PER_ROUND, remaining + 2); // +2 buffer buat yang mungkin invalid
      const roundContext = this.buildRoundContext(round, query.topic, allSearchResults);

      const academicHint = round >= 1 ? `\n\nJika hasil sebelumnya masih kurang, cari juga dari sumber AKADEMIS/JURNAL seperti Google Scholar, ResearchGate, Springer, IEEE, portal jurnal universitas, atau repositori institusi. Kalau topiknya sains/teknologi, arXiv juga bisa jadi sumber.` : '';

      const searchPrompt = `Cari informasi di web tentang: "${query.topic}"
${questionsText}
${roundContext}
${academicHint}

Kembalikan hasil pencarian sebagai JSON array dengan format:
[
  {
    "title": "Judul halaman atau paper",
    "url": "URL lengkap",
    "snippet": "Cuplikan deskripsi atau abstrak"
  }
]
Cari ${askCount} hasil yang relevan — prioritaskan artikel orisinil, publikasi resmi, berita terpercaya, dan sumber akademik yang relevan dengan topik. Pastikan semua URL valid (bisa diakses).`;

      const response = await this.prompt(searchPrompt);
      const parsed = this.parseSearchResults(response);

      // Filter: cuma URL valid + belum pernah muncul
      for (const item of parsed) {
        if (!this.isValidUrl(item.url)) continue;
        const normalized = item.url.replace(/\/$/, '').toLowerCase();
        if (seenUrls.has(normalized)) continue;
        seenUrls.add(normalized);
        allSearchResults.push(item);
      }
    }

    if (allSearchResults.length === 0) {
      // Fallback: coba scrape Google/Bing langsung
      return this.fallbackSearch(query, maxSources);
    }

    // Ambil sesuai jumlah yang diminta
    const results = allSearchResults.slice(0, maxSources);

    // ── Step 2: scrape konten tiap URL ──────────────────────
    const sources: Source[] = [];
    const httpClient = axios.create({
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'id,en;q=0.9',
      },
      maxRedirects: 5,
      validateStatus: (s) => s < 400,
    });

    for (const result of results) {
      let source: Source | null = null;

      // Coba scrape original URL
      try {
        source = await this.scrapeUrl(httpClient, result);
      } catch (err) {
        console.warn(`[OpencodeSearch] Scrape gagal: ${result.url} — ${err instanceof Error ? err.message : err}`);
      }

      // Fallback 1: Wayback Machine
      if (!source) {
        source = await this.tryArchiveFetch(httpClient, result);
      }

      // Fallback 2: Google Cache
      if (!source) {
        source = await this.tryGoogleCache(httpClient, result);
      }

      // Final fallback: snippet-only
      if (!source) {
        source = this.createSnippetSource(result);
      }

      sources.push(source);
    }

    return sources;
  }

  /**
   * Bangun konteks untuk round berikutnya — kasih tau URL yang sudah dikumpulkan
   * dan minta angle yang berbeda + sumber jurnal/jika belum cukup.
   */
  private buildRoundContext(round: number, topic: string, existing: SearchResultItem[]): string {
    if (round === 0) return '';
    const urls = existing.map((r) => `- ${r.title}: ${r.url}`).join('\n');
    const hasJournal = existing.some((r) =>
      /arxiv|scholar\.google|springer|ieee|xplore|acm\.org|pubmed|ncbi|researchgate|sciencedirect|wiley|nature\.com|science\.org|jstor|frontiersin|mdpi|tailor|tandfonline/i.test(r.url),
    );
    const journalHint = !hasJournal
      ? `\n\nSejauh ini belum ada sumber dari JURNAL AKADEMIS. Coba cari di Google Scholar, arXiv, Springer, IEEE Xplore, atau portal jurnal lain.`
      : '';
    return `\nURL yang sudah dikumpulkan:\n${urls}${journalHint}\n\nCari angle LAIN atau subtopik lain dari "${topic}" — termasuk jurnal akademik. Jangan duplikasi URL di atas.`;
  }

  /**
   * Validasi URL sederhana — cek format, hostname, dan hindari pola fake.
   */
  private isValidUrl(url: string): boolean {
    if (!URL_VALID_REGEX.test(url)) return false;
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();
      // Skip domain placeholder / fake patterns
      if (
        hostname === 'example.com' ||
        hostname.endsWith('.example.com') ||
        hostname.includes('example.org') ||
        hostname.includes('test.com') ||
        hostname.includes('domain.com') ||
        hostname.includes('your-domain') ||
        hostname.includes('website.com') ||
        hostname.includes('sample.com') ||
        hostname.includes('yoursite.com') ||
        hostname.includes('yourwebsite.com') ||
        hostname.includes('yoururl.com') ||
        hostname.includes('yourdomain.com') ||
        hostname.includes('mysite.com') ||
        hostname.includes('mywebsite.com') ||
        hostname.includes('somesite.com') ||
        hostname.includes('somedomain.com') ||
        hostname.includes('placeholder.com') ||
        hostname === 'localhost' ||
        parsed.protocol === 'ftp:'
      )
        return false;
      // Minimal harus ada dot di TLD (gak valid kalo cuma 'http://somesite')
      const parts = hostname.split('.');
      if (parts.length < 2) return false;
      const tld = parts[parts.length - 1];
      if (tld.length < 2 || tld.length > 6) return false;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Parse JSON array dari response LLM
   */
  private parseSearchResults(response: string): SearchResultItem[] {
    // Cari JSON array dalam response
    const arrayMatch = response.match(/\[[\s\S]*\]/);
    if (!arrayMatch) return [];

    try {
      const parsed = JSON.parse(arrayMatch[0]) as unknown[];
      if (!Array.isArray(parsed)) return [];

      return parsed
        .filter((item): item is SearchResultItem =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as SearchResultItem).title === 'string' &&
          typeof (item as SearchResultItem).url === 'string',
        )
        .map((item) => ({
          title: item.title.trim().slice(0, 500),
          url: item.url.trim(),
          snippet: (item.snippet || '').trim().slice(0, MAX_SNIPPET_LENGTH),
        }));
    } catch (err) {
      console.warn('[OpencodeSearch] Gagal parse JSON dari LLM:', err instanceof Error ? err.message : err);
      return [];
    }
  }

  /**
   * Scrape content dari URL
   */
  private async scrapeUrl(
    httpClient: ReturnType<typeof axios.create>,
    result: SearchResultItem,
  ): Promise<Source> {
    const response = await httpClient.get(result.url, {
      responseType: 'text',
      transformResponse: [(data) => data],
    });

    const html = response.data as string;
    const dom = new JSDOM(html, { url: result.url });
    const document = dom.window.document;

    // Ekstrak konten dengan Readability
    let title = result.title;
    let content = '';
    let textContent = '';

    const reader = new Readability(document);
    const article = reader.parse();

    if (article) {
      title = article.title || title;
      content = article.content || '';
      textContent = article.textContent || '';

      // Fallback cheerio kalo Readability hasilnya kosong
      if (!textContent || textContent.length < 100) {
        const $ = cheerio.load(html);
        $('script, style, nav, header, footer, aside').remove();
        textContent = $('article, main, [role="main"], .content, .post-content, body')
          .text()
          .replace(/\s+/g, ' ')
          .trim();
      }
    } else {
      // Fallback cheerio
      const $ = cheerio.load(html);
      $('script, style, nav, header, footer, aside, iframe').remove();
      textContent = $('article, main, [role="main"], body')
        .text()
        .replace(/\s+/g, ' ')
        .trim();
    }

    if (!textContent && result.snippet) {
      textContent = result.snippet;
    }

    // Parse metadata
    const metadata: SourceMetadata = {
      domain: new URL(result.url).hostname,
      wordCount: textContent.split(/\s+/).filter(Boolean).length,
      publishDate: this.extractDate(html),
      author: this.extractAuthor(html),
      language: document.documentElement.lang || undefined,
    };

    content = textContent.slice(0, MAX_CONTENT_LENGTH);

    return {
      id: uuid(),
      title: title.slice(0, 500),
      url: result.url,
      content,
      summary: result.snippet || textContent.slice(0, 300),
      sourceType: 'web',
      metadata,
      collectedAt: new Date(),
    };
  }

  private createSnippetSource(result: SearchResultItem): Source {
    return {
      id: uuid(),
      title: result.title,
      url: result.url,
      content: result.snippet,
      summary: result.snippet,
      sourceType: 'web',
      metadata: {
        domain: this.extractDomain(result.url),
        wordCount: (result.snippet || '').split(/\s+/).filter(Boolean).length,
      },
      collectedAt: new Date(),
    };
  }

  /**
   * Coba fetch dari Wayback Machine (archive.org)
   * 1. Cek availability via /wayback/available API
   * 2. Kalau ada snapshot, fetch dari web.archive.org
   * 3. Parse dengan Readability via scrapeUrl
   */
  private async tryArchiveFetch(
    httpClient: ReturnType<typeof axios.create>,
    result: SearchResultItem,
  ): Promise<Source | null> {
    try {
      const checkUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(result.url)}`;
      const checkResponse = await axios.get(checkUrl, {
        timeout: REQUEST_TIMEOUT_MS,
        headers: { 'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)] },
      });

      const data = checkResponse.data;
      if (!data?.archived_snapshots?.closest?.available) {
        return null;
      }

      const archiveUrl = data.archived_snapshots.closest.url as string;
      console.log(`[OpencodeSearch] Wayback: ${result.url} → ${archiveUrl}`);

      // Fetch dari Wayback — parse seperti URL biasa
      const source = await this.scrapeUrl(httpClient, {
        ...result,
        url: archiveUrl,
      });
      // Kembalikan URL asli, bukan URL archive
      source.url = result.url;
      return source;
    } catch (err) {
      console.warn(`[OpencodeSearch] Wayback gagal: ${result.url} — ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /**
   * Coba fetch dari Google Cache
   * Format: https://webcache.googleusercontent.com/search?q=cache:<URL>
   */
  private async tryGoogleCache(
    httpClient: ReturnType<typeof axios.create>,
    result: SearchResultItem,
  ): Promise<Source | null> {
    try {
      const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(result.url)}`;
      console.log(`[OpencodeSearch] Google Cache: ${result.url}`);

      // Coba scrape langsung via Readability
      try {
        const source = await this.scrapeUrl(httpClient, {
          ...result,
          url: cacheUrl,
        });
        source.url = result.url;
        return source;
      } catch {
        // Readability gagal — fallback manual parse Google Cache page
        const response = await httpClient.get(cacheUrl, {
          responseType: 'text',
          transformResponse: [(data) => data],
        });

        const html = response.data as string;
        const $ = cheerio.load(html);

        // Google Cache wraps konten asli dalam <pre> atau <div>
        $('script, style, nav, header, footer, iframe, noscript').remove();

        // Hapus header Google Cache (div dengan font-size:14px)
        $('div[style*="font-size"], div[style*="font"]').remove();

        let textContent = '';
        // Priority: <pre> → langsung ambil body text
        const preEl = $('pre');
        if (preEl.length > 0) {
          textContent = preEl.text().replace(/\s+/g, ' ').trim();
        } else {
          textContent = $('body').text().replace(/\s+/g, ' ').trim();
        }

        if (!textContent || textContent.length < 50) return null;

        return {
          id: uuid(),
          title: result.title,
          url: result.url, // URL asli, bukan cache
          content: textContent.slice(0, MAX_CONTENT_LENGTH),
          summary: result.snippet || textContent.slice(0, 300),
          sourceType: 'web',
          metadata: {
            domain: this.extractDomain(result.url),
            wordCount: textContent.split(/\s+/).filter(Boolean).length,
          },
          collectedAt: new Date(),
        };
      }
    } catch (err) {
      console.warn(`[OpencodeSearch] Google Cache gagal: ${result.url} — ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  // ── Fallback: scrape Google search langsung ────────────────

  private async fallbackSearch(query: ResearchQuery, maxSources: number): Promise<Source[]> {
    const sources: Source[] = [];
    const httpClient = axios.create({
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
      },
      validateStatus: (s) => s < 400,
    });

    const seenFallbackUrls = new Set<string>();

    const queries = [
      query.topic,
      `${query.topic} research paper`,
      `${query.topic} journal article`,
    ];

    for (const searchTerm of queries) {
      if (sources.length >= maxSources) break;
      try {
        const url = `https://www.google.com/search?q=${encodeURIComponent(searchTerm)}&num=${maxSources}`;
        const response = await httpClient.get(url, {
          responseType: 'text',
          transformResponse: [(data) => data],
        });

        const html = response.data as string;
        const $ = cheerio.load(html);

        const searchResults: SearchResultItem[] = [];
        // Google result selector — multiple fallback patterns
        $('div.g').each((_, el) => {
          const titleEl = $(el).find('h3').first();
          const linkEl = $(el).find('a').first();
          const snippetEl = $(el).find('span.aCOpRe, div.VwiC3b, span.st');

          const title = titleEl.text().trim();
          const url = linkEl.attr('href') || '';
          const snippet = snippetEl.first().text().trim();

          if (title && url.startsWith('http')) {
            const normalized = url.replace(/\/$/, '').toLowerCase();
            if (!seenFallbackUrls.has(normalized)) {
              seenFallbackUrls.add(normalized);
              searchResults.push({ title, url, snippet });
            }
          }
        });

        const remaining = maxSources - sources.length;
        for (const result of searchResults.slice(0, remaining)) {
          try {
            const source = await this.scrapeUrl(httpClient, result);
            sources.push(source);
          } catch (err) {
            console.warn(`[OpencodeSearch] Fallback scrape gagal: ${result.url} — ${err instanceof Error ? err.message : err}`);
            sources.push(this.createSnippetSource(result));
          }
        }
      } catch (err) {
        console.warn(`[OpencodeSearch] Google fallback search gagal untuk "${searchTerm}":`, err instanceof Error ? err.message : err);
      }
    }

    return sources;
  }

  // ── Helpers ─────────────────────────────────────────────────

  private async ensureReady(): Promise<void> {
    if (!this.client) await this.initialize();
  }

  private extractDomain(url: string): string {
    try { return new URL(url).hostname; } catch { return ''; }
  }

  private extractDate(html: string): Date | undefined {
    const dateMatch = html.match(
      /(?:datetime|date|pubdate|article:published_time)\s*[=:]\s*["']?(\d{4}-\d{2}-\d{2})/i,
    );
    if (dateMatch) {
      const d = new Date(dateMatch[1]);
      if (!isNaN(d.getTime())) return d;
    }
    return undefined;
  }

  private extractAuthor(html: string): string | undefined {
    const authorMatch = html.match(
      /(?:author|byline|creator)\s*[=:]\s*["']([^"']+)["']/i,
    );
    return authorMatch?.[1]?.trim();
  }

  async cleanup(): Promise<void> {
    if (this.sessionId && this.client) {
      try { await this.client.session.delete({ path: { id: this.sessionId } }); } catch (err) {
        console.warn('[OpencodeSearch] Gagal cleanup session:', err instanceof Error ? err.message : err);
      }
      this.sessionId = null;
    }
  }
}
