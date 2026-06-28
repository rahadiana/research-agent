/**
 * Web Scraper — Search engine & web content collector untuk Research Agent
 *
 * Modul ini menyediakan:
 * - SearchEngine: pencarian web via SerpAPI (dengan fallback simulated search)
 * - ContentExtractor: ekstraksi artikel dari HTML (Readability + cheerio fallback)
 * - WebCollector: collector yang mengimplementasikan SourceCollector
 *
 * @packageDocumentation
 */

import axios, { type AxiosInstance, AxiosError } from 'axios';
import * as cheerio from 'cheerio';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { v4 as uuid } from 'uuid';
import type {
  ResearchQuery,
  Source,
  SourceCollector,
  SourceMetadata,
  ResearchDepth,
} from '../types/index.js';

// ── Public Types ───────────────────────────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface ArticleContent {
  title: string;
  content: string;
  textContent: string;
  excerpt: string;
}

// ── Constants ──────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1_000;

const USER_AGENTS: string[] = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7; rv:127.0) Gecko/20100101 Firefox/127.0',
];

// ── Private Helpers ────────────────────────────────────────────

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof AxiosError) {
    if (error.response) {
      const status = error.response.status;
      return status === 429 || status >= 500;
    }
    return (
      error.code === 'ECONNABORTED' ||
      error.code === 'ECONNRESET' ||
      error.code === 'ETIMEDOUT'
    );
  }
  return false;
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// ── SearchEngine ───────────────────────────────────────────────

export class SearchEngine {
  private readonly client: AxiosInstance;

  /**
   * @param serpapiKey - API key untuk SerpAPI (opsional).
   *                     Jika tidak disediakan, fallback ke simulated search.
   */
  constructor(private readonly serpapiKey?: string) {
    this.client = axios.create({
      timeout: REQUEST_TIMEOUT_MS,
      headers: { 'User-Agent': randomUA() },
    });
  }

  /**
   * Melakukan pencarian web berdasarkan query.
   *
   * @param query  - Kata kunci pencarian
   * @param count  - Jumlah hasil yang diinginkan (default: 10)
   * @returns Array of SearchResult
   *
   * @throws Jika SerpAPI request gagal (tidak dilempar untuk simulated search)
   */
  async search(query: string, count?: number): Promise<SearchResult[]> {
    const numResults = count ?? 10;

    if (this.serpapiKey) {
      return this.serpapiSearch(query, numResults);
    }

    return this.simulateSearch(query, numResults);
  }

  /**
   * Pencarian via SerpAPI.
   */
  private async serpapiSearch(query: string, count: number): Promise<SearchResult[]> {
    try {
      const response = await this.client.get('https://serpapi.com/search', {
        params: {
          q: query,
          api_key: this.serpapiKey,
          engine: 'google',
          num: Math.min(count, 100),
        },
      });

      const data = response.data as Record<string, unknown>;
      const organic = data.organic_results as
        | Array<Record<string, unknown>>
        | undefined;

      if (!organic || !Array.isArray(organic)) {
        console.warn('[SearchEngine] SerpAPI returned no organic results');
        return [];
      }

      return organic.slice(0, count).map(
        (result): SearchResult => ({
          title: String(result.title ?? ''),
          url: String(result.link ?? ''),
          snippet: String(result.snippet ?? ''),
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[SearchEngine] SerpAPI search failed: ${message}`);
      throw error;
    }
  }

  /**
   * Simulated search — menghasilkan dummy results untuk development/testing
   * ketika SerpAPI key tidak tersedia.
   */
  private simulateSearch(query: string, count: number): SearchResult[] {
    const results: SearchResult[] = [];
    for (let i = 0; i < count; i++) {
      results.push({
        title: `${query} — Result ${i + 1}`,
        url: `https://example.com/result-${i + 1}?q=${encodeURIComponent(query)}`,
        snippet: `Simulated search result for "${query}" — page ${i + 1} of ${count}.`,
      });
    }
    return results;
  }
}

// ── ContentExtractor ──────────────────────────────────────────

export class ContentExtractor {
  /**
   * Extract artikel dari HTML string.
   *
   * Priority:
   * 1. @mozilla/readability untuk article extraction
   * 2. Fallback: cheerio + meta tag parsing
   *
   * @param html - Raw HTML string
   * @param url  - URL sumber (untuk resolusi relative path di Readability)
   * @returns ArticleContent berisi title, content (HTML), textContent (plain), excerpt
   */
  async extractArticle(html: string, url: string): Promise<ArticleContent> {
    const readabilityResult = this.tryReadability(html, url);

    if (readabilityResult) {
      return readabilityResult;
    }

    return this.fallbackExtraction(html);
  }

  /**
   * Mengekstrak metadata dari HTML (author, publish date, keywords).
   *
   * @param html - Raw HTML string
   * @returns Object dengan author, publishDate, keywords (optional)
   */
  extractMetadata(
    html: string,
  ): { author?: string; publishDate?: string; keywords?: string[] } {
    const $ = cheerio.load(html);

    const author =
      $('meta[name="author"]').attr('content') ??
      $('meta[property="article:author"]').attr('content') ??
      undefined;

    const publishDate =
      $('meta[property="article:published_time"]').attr('content') ??
      $('meta[name="date"]').attr('content') ??
      $('meta[property="og:pubdate"]').attr('content') ??
      undefined;

    const keywordsStr =
      $('meta[name="keywords"]').attr('content') ??
      $('meta[property="article:tag"]').attr('content') ??
      undefined;

    const keywords = keywordsStr
      ? keywordsStr
          .split(',')
          .map(k => k.trim())
          .filter(Boolean)
      : undefined;

    return { author, publishDate, keywords };
  }

  /**
   * Mencoba ekstraksi dengan @mozilla/readability.
   * Returns null jika gagal atau konten kosong.
   */
  private tryReadability(html: string, url: string): ArticleContent | null {
    try {
      const dom = new JSDOM(html, { url });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();

      if (!article || !article.content) {
        return null;
      }

      const textContent = this.stripHtml(article.content);

      return {
        title: article.title ?? '',
        content: article.content,
        textContent,
        excerpt: article.excerpt ?? textContent.slice(0, 300),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ContentExtractor] Readability failed: ${message}`);
      return null;
    }
  }

  /**
   * Fallback extraction via cheerio — membaca meta tags dan body text.
   */
  private fallbackExtraction(html: string): ArticleContent {
    const $ = cheerio.load(html);

    const title =
      $('meta[property="og:title"]').attr('content') ??
      $('meta[name="title"]').attr('content') ??
      $('title').text() ??
      '';

    const description =
      $('meta[property="og:description"]').attr('content') ??
      $('meta[name="description"]').attr('content') ??
      '';

    const articleSelectors = [
      'article',
      '[role="main"]',
      'main',
      '.post-content',
      '.article-content',
      '.entry-content',
      '#content',
      'body',
    ];

    let mainText = '';
    for (const selector of articleSelectors) {
      const el = $(selector);
      if (el.length > 0) {
        mainText = el.text();
        break;
      }
    }

    mainText = mainText.replace(/\s+/g, ' ').trim();
    const content = `<html><body>${this.escapeHtml(mainText)}</body></html>`;
    const excerpt = description || mainText.slice(0, 300);

    return {
      title,
      content,
      textContent: mainText,
      excerpt,
    };
  }

  /**
   * Strip HTML tags, return plain text bersih.
   */
  private stripHtml(html: string): string {
    const $ = cheerio.load(html);
    return $.text().replace(/\s+/g, ' ').trim();
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

// ── WebCollector ──────────────────────────────────────────────

export class WebCollector implements SourceCollector {
  readonly name = 'web-collector';
  private readonly searchEngine: SearchEngine;
  private readonly contentExtractor: ContentExtractor;

  /**
   * @param serpapiKey - API key untuk SerpAPI (opsional).
   *                     Dioper ke SearchEngine untuk pencarian web.
   */
  constructor(serpapiKey?: string) {
    this.searchEngine = new SearchEngine(serpapiKey);
    this.contentExtractor = new ContentExtractor();
  }

  /**
   * Kumpulkan sumber dari web berdasarkan ResearchQuery.
   *
   * Flow:
   * 1. Search via SearchEngine berdasarkan query.topic
   * 2. Fetch setiap halaman dengan retry logic + timeout
   * 3. Extract konten menggunakan ContentExtractor
   * 4. Kumpulkan metadata (domain, wordCount, author, dll)
   * 5. Return array of Source
   *
   * @param query - ResearchQuery dari user
   * @returns Array of Source yang berhasil dikumpulkan
   */
  async collect(query: ResearchQuery): Promise<Source[]> {
    const maxSources = query.maxSources ?? 10;
    const depth = query.depth ?? 'medium';

    const resultCount = this.getResultCount(depth, maxSources);
    const searchResults = await this.searchEngine.search(query.topic, resultCount);

    const sources: Source[] = [];

    for (const sr of searchResults) {
      if (sources.length >= maxSources) break;

      try {
        const source = await this.fetchAndExtract(sr);
        sources.push(source);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[WebCollector] Failed to fetch ${sr.url}: ${message}`);
      }
    }

    return sources;
  }

  /**
   * Tentukan jumlah hasil pencarian berdasarkan depth.
   */
  private getResultCount(depth: ResearchDepth, maxSources: number): number {
    const multiplier: Record<ResearchDepth, number> = {
      quick: 5,
      medium: 10,
      deep: 20,
    };
    return Math.min(multiplier[depth] ?? 10, maxSources * 2);
  }

  /**
   * Fetch URL, extract konten, return Source object.
   */
  private async fetchAndExtract(searchResult: SearchResult): Promise<Source> {
    const html = await this.fetchWithRetry(searchResult.url);
    const article = await this.contentExtractor.extractArticle(html, searchResult.url);
    const meta = this.contentExtractor.extractMetadata(html);

    const wordCount = article.textContent
      .split(/\s+/)
      .filter(Boolean).length;

    const metadata: SourceMetadata = {
      author: meta.author,
      publishDate: meta.publishDate
        ? new Date(meta.publishDate)
        : undefined,
      domain: extractDomain(searchResult.url),
      wordCount,
      language: this.detectLanguage(html),
    };

    return {
      id: uuid(),
      title: article.title || searchResult.title,
      url: searchResult.url,
      content: article.textContent,
      summary: article.excerpt,
      sourceType: 'web',
      metadata,
      collectedAt: new Date(),
    };
  }

  /**
   * Fetch URL dengan retry logic.
   *
   * Strategy:
   * - Max 3 retries
   * - Exponential backoff: 1s, 2s, 4s
   * - Hanya retry untuk error yang retryable (429, 5xx, timeout, reset)
   */
  private async fetchWithRetry(url: string): Promise<string> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.fetchUrl(url);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < MAX_RETRIES && isRetryableError(error)) {
          const delayMs = BASE_RETRY_DELAY_MS * 2 ** attempt;
          console.warn(
            `[WebCollector] Retry ${attempt + 1}/${MAX_RETRIES} for ${url} in ${delayMs}ms`,
          );
          await delay(delayMs);
          continue;
        }

        console.error(`[WebCollector] Fetch failed for ${url}: ${lastError.message}`);
        throw lastError;
      }
    }

    throw lastError ?? new Error(`Failed to fetch ${url}`);
  }

  /**
   * Single HTTP GET dengan AbortController timeout & User-Agent rotation.
   */
  private async fetchUrl(url: string): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await axios.get<string>(url, {
        signal: controller.signal,
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          'User-Agent': randomUA(),
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
        },
        responseType: 'text',
        maxRedirects: 5,
        validateStatus: (status) => status < 400,
      });

      return response.data;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Deteksi bahasa dari HTML <html lang="..."> attribute.
   */
  private detectLanguage(html: string): string | undefined {
    const $ = cheerio.load(html);
    const lang = $('html').attr('lang');

    if (lang) {
      const primary = lang.split('-')[0];
      if (primary) return primary;
    }

    return undefined;
  }
}
