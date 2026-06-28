/**
 * LLM Integration Module — OpenAI Provider
 *
 * Provides summarization, multi-source synthesis, and Q&A
 * using OpenAI's GPT models with JSON mode, retry logic,
 * token management, and structured report parsing.
 */

import OpenAI from 'openai';
import type { LLMProvider, Source, ResearchQuery, ResearchReport, ReportSection } from '../types/index.js';

// ---------------------------------------------------------------------------
// Config & Types
// ---------------------------------------------------------------------------

export interface LLMConfig {
  /** OpenAI API key */
  apiKey: string;
  /** Model ID (default: 'gpt-4o-mini') */
  model?: string;
  /** Max output tokens per call (default: 4096) */
  maxTokens?: number;
  /** Sampling temperature 0-2 (default: 0.7) */
  temperature?: number;
  /** Request timeout in ms (default: 60000) */
  timeout?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_TIMEOUT = 60_000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1_000;
const CHARS_PER_TOKEN = 4;
const SAFE_CONTEXT_LIMIT = 100_000; // tokens — safety cap for 128K models
const CONTEXT_BUFFER = 2000; // tokens reserved for system prompt + instructions

// ---------------------------------------------------------------------------
// Prompt Templates
// ---------------------------------------------------------------------------

const SYSTEM_PROMPTS = {
  summarize: 'You are a research assistant. Summarize the following text concisely while preserving key information and facts.',
  synthesize: `You are an expert research analyst and report writer. Your task is to synthesize information from multiple sources into a comprehensive, well-structured research report.

You MUST respond with valid JSON only — no markdown fences, no extra text. The JSON must follow this exact structure:
{
  "title": "string — report title",
  "summary": "string — executive summary (2-3 paragraphs)",
  "keyFindings": ["string — bullet-point finding", ...],
  "sections": [{"heading": "string", "content": "string", "subsections": [{"heading": "string", "content": "string"}]}],
  "conclusions": ["string — conclusion item", ...],
  "references": ["string — source URL", ...]
}

Base everything solely on the provided sources. Do not fabricate information.`,
  answer: 'You are a knowledgeable research assistant. Answer the question based strictly on the provided context. If the answer cannot be found in the provided context, state clearly that the information is not available in the given materials.',
} as const;

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

/**
 * Build messages for summarization.
 */
function buildSummarizePrompt(text: string, maxLength?: number): ChatMessage[] {
  let instruction = 'Summarize the following text concisely while preserving key information and facts.';
  if (maxLength !== undefined) {
    instruction += `\nThe summary must not exceed ${maxLength} characters.`;
  }
  instruction += '\n\nText:\n' + text;

  return [
    { role: 'system', content: SYSTEM_PROMPTS.summarize },
    { role: 'user', content: instruction },
  ];
}

/**
 * Build messages for multi-source synthesis with JSON output instruction.
 */
function buildSynthesizePrompt(sources: Source[], query: ResearchQuery): ChatMessage[] {
  const sourceBlocks = sources.map(
    (s, i) =>
      `[Source ${i + 1}] ${s.title}
URL: ${s.url}
Content:
${s.content}
---`,
  );

  const userMessage = `Research Topic: ${query.topic}
${query.questions?.length ? `Questions:\n${query.questions.map((q) => `- ${q}`).join('\n')}\n` : ''}

Below are the collected sources. Synthesize them into a comprehensive research report. Respond with valid JSON only.

${sourceBlocks.join('\n\n')}`;

  return [
    { role: 'system', content: SYSTEM_PROMPTS.synthesize },
    { role: 'user', content: userMessage },
  ];
}

/**
 * Build messages for question answering.
 */
function buildAnswerPrompt(question: string, context: string): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPTS.answer },
    {
      role: 'user',
      content: `Context:\n${context}\n\nQuestion: ${question}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Token Management
// ---------------------------------------------------------------------------

/**
 * Estimate token count from text length (4 chars ≈ 1 token).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Truncate text to fit within a token limit, attempting to cut at sentence boundaries.
 */
export function truncateToLimit(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  const estimated = estimateTokens(text);
  if (estimated <= maxTokens) return text;

  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const truncated = text.slice(0, maxChars);

  // Try to cut at the last sentence boundary (., !, ?) within the limit
  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('! '),
    truncated.lastIndexOf('? '),
    truncated.lastIndexOf('.\n'),
    truncated.lastIndexOf('!\n'),
    truncated.lastIndexOf('?\n'),
  );

  if (lastSentenceEnd > maxChars * 0.5) {
    return truncated.slice(0, lastSentenceEnd + 1) + '\n\n[Content truncated due to length]';
  }

  return truncated + '\n\n[Content truncated due to length]';
}

/**
 * Sort sources by relevanceScore (ascending), so least-relevant get truncated first.
 * Mutates the array in-place.
 */
function sortByRelevance(sources: Source[]): Source[] {
  return sources.sort((a, b) => (a.relevanceScore ?? 0) - (b.relevanceScore ?? 0));
}

/**
 * Truncate source contents to fit within the safe context window.
 * Removes least-relevant sources first if still over limit.
 */
function trimSourcesToContext(sources: Source[], modelContextLimit: number): Source[] {
  const maxContentTokens = modelContextLimit - CONTEXT_BUFFER;
  if (maxContentTokens <= 0) return [];

  const sorted = sortByRelevance([...sources]);
  let totalTokens = 0;

  const result: Source[] = [];

  for (const source of sorted) {
    const tokens = estimateTokens(source.content);
    if (totalTokens + tokens <= maxContentTokens) {
      result.push(source);
      totalTokens += tokens;
    } else {
      // Try to include a truncated version
      const remainingTokens = maxContentTokens - totalTokens;
      if (remainingTokens > 50) {
        result.push({
          ...source,
          content: truncateToLimit(source.content, remainingTokens),
        });
      }
      // Skip remaining sources (least relevant already at front)
      break;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'status' in err) {
    return (err as { status: number }).status === 429;
  }
  return false;
}

// ---------------------------------------------------------------------------
// OpenAIProvider
// ---------------------------------------------------------------------------

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  private config: Required<LLMConfig>;

  constructor(config: LLMConfig) {
    if (!config.apiKey) {
      throw new Error('OpenAI API key not configured');
    }

    this.config = {
      apiKey: config.apiKey,
      model: config.model ?? DEFAULT_MODEL,
      maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: config.temperature ?? DEFAULT_TEMPERATURE,
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
    };

    this.client = new OpenAI({
      apiKey: this.config.apiKey,
      timeout: this.config.timeout,
      maxRetries: 0,
    });
  }

  // -----------------------------------------------------------------------
  // Public — LLMProvider interface
  // -----------------------------------------------------------------------

  /**
   * Summarize a text concisely while preserving key facts.
   *
   * @param text      — The text to summarize.
   * @param maxLength — Optional maximum character length for the summary.
   */
  async summarize(text: string, maxLength?: number): Promise<string> {
    if (!text.trim()) {
      return '';
    }
    const messages = buildSummarizePrompt(text, maxLength);
    return this.callOpenAI(messages, { maxTokens: this.config.maxTokens });
  }

  /**
   * Synthesize multiple sources into a structured research report.
   * Attempts JSON parsing from the LLM response; falls back to text-based parsing.
   *
   * @param sources — Collected sources.
   * @param query   — The original research query.
   */
  async synthesize(sources: Source[], query: ResearchQuery): Promise<ResearchReport> {
    if (sources.length === 0) {
      return {
        title: `Research: ${query.topic}`,
        summary: 'No sources were collected.',
        keyFindings: [],
        sections: [],
        conclusions: [],
        references: [],
        generatedAt: new Date(),
        model: this.config.model,
      };
    }

    // Determine model context limit (default 128K, capped at SAFE_CONTEXT_LIMIT)
    const modelContextLimit = Math.min(SAFE_CONTEXT_LIMIT, 128_000);

    // Trim sources to fit context window (trim lowest-relevance first)
    const trimmedSources = trimSourcesToContext(sources, modelContextLimit);

    const messages = buildSynthesizePrompt(trimmedSources, query);

    let response: string;
    try {
      response = await this.callOpenAI(messages, {
        maxTokens: this.config.maxTokens,
        jsonMode: true,
      });
    } catch {
      // If JSON mode fails, retry without JSON mode
      response = await this.callOpenAI(messages, {
        maxTokens: this.config.maxTokens,
        jsonMode: false,
      });
    }

    return this.parseSynthesisResponse(response, query, trimmedSources);
  }

  /**
   * Answer a question grounded in the provided context.
   *
   * @param question — The question to answer.
   * @param context  — Context to base the answer on.
   */
  async answer(question: string, context: string): Promise<string> {
    if (!context.trim()) {
      return 'No context was provided to answer the question.';
    }

    const safeContext = truncateToLimit(context, SAFE_CONTEXT_LIMIT - CONTEXT_BUFFER);
    const messages = buildAnswerPrompt(question, safeContext);
    return this.callOpenAI(messages, { maxTokens: this.config.maxTokens });
  }

  // -----------------------------------------------------------------------
  // Internal OpenAI caller with retry & timeout
  // -----------------------------------------------------------------------

  /**
   * Core method to call the OpenAI chat completion API.
   *
   * @param messages — Chat messages to send.
   * @param options  — Optional overrides for jsonMode and maxTokens.
   */
  private async callOpenAI(
    messages: ChatMessage[],
    options?: { jsonMode?: boolean; maxTokens?: number },
  ): Promise<string> {
    const { jsonMode = false, maxTokens } = options ?? {};
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.completion(messages, { jsonMode, maxTokens });
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (isRateLimitError(err)) {
          // Exponential backoff: 1s, 2s, 4s
          const delay = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
          await sleep(delay);
          continue;
        }

        // Non-rate-limit error: retry once, then throw
        if (attempt < MAX_RETRIES) {
          await sleep(BASE_BACKOFF_MS);
          continue;
        }
      }
    }

    throw lastError ?? new Error('[OpenAIProvider] Request failed after retries.');
  }

  /**
   * Single chat completion call.
   */
  private async completion(
    messages: ChatMessage[],
    options?: { jsonMode?: boolean; maxTokens?: number },
  ): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await this.client.chat.completions.create(
        {
          model: this.config.model,
          messages,
          max_tokens: options?.maxTokens ?? this.config.maxTokens,
          temperature: this.config.temperature,
          ...(options?.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
        },
        { signal: controller.signal },
      );

      const content = response.choices[0]?.message?.content;
      return content ?? '';
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // -----------------------------------------------------------------------
  // Response parsing
  // -----------------------------------------------------------------------

  /**
   * Parse the LLM synthesis response into a ResearchReport.
   * Tries JSON first; falls back to text-based heuristic parsing.
   */
  private parseSynthesisResponse(
    raw: string,
    query: ResearchQuery,
    sources: Source[],
  ): ResearchReport {
    // Attempt 1: JSON parsing
    try {
      const parsed = JSON.parse(raw) as {
        title?: string;
        summary?: string;
        keyFindings?: string[];
        sections?: Array<{
          heading?: string;
          content?: string;
          subsections?: Array<{ heading?: string; content?: string }>;
        }>;
        conclusions?: string[];
        references?: string[];
      };

      return {
        title: parsed.title ?? `Research Report: ${query.topic}`,
        summary: parsed.summary ?? '',
        keyFindings: parsed.keyFindings ?? [],
        sections: this.normalizeSections(parsed.sections),
        conclusions: parsed.conclusions ?? [],
        references: parsed.references ?? sources.map((s) => s.url),
        generatedAt: new Date(),
        model: this.config.model,
      };
    } catch {
      // Fallback: text-based parsing
      return this.fallbackParse(raw, query, sources);
    }
  }

  /**
   * Normalise parsed sections to conform to ReportSection[].
   */
  private normalizeSections(
    sections?: Array<{
      heading?: string;
      content?: string;
      subsections?: Array<{ heading?: string; content?: string }>;
    }>,
  ): ReportSection[] {
    if (!sections) return [];

    return sections.map((s) => ({
      heading: s.heading ?? '',
      content: s.content ?? '',
      subsections: s.subsections?.map((sub) => ({
        heading: sub.heading ?? '',
        content: sub.content ?? '',
      })),
    }));
  }

  /**
   * Fallback parser when JSON output is not available.
   * Extracts structure from plain-text markdown-like output.
   */
  private fallbackParse(raw: string, query: ResearchQuery, sources: Source[]): ResearchReport {
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    const title = lines[0]?.replace(/^#\s*/, '') ?? `Research Report: ${query.topic}`;

    // Extract sections by headings (lines starting with ## or similar)
    const sections: ReportSection[] = [];
    let currentSection: ReportSection | null = null;

    for (const line of lines) {
      const headingMatch = line.match(/^#{1,3}\s+(.+)/);
      if (headingMatch) {
        currentSection = { heading: headingMatch[1]!, content: '' };
        sections.push(currentSection);
      } else if (currentSection) {
        currentSection.content += line + '\n';
      }
    }

    return {
      title,
      summary: sections.find((s) => /summary|overview/i.test(s.heading))?.content ?? raw.slice(0, 500),
      keyFindings: sections
        .find((s) => /key findings|findings/i.test(s.heading))
        ?.content.split('\n')
        .filter((l) => /^[-*]\s/.test(l))
        .map((l) => l.replace(/^[-*]\s/, '')) ?? [],
      sections,
      conclusions: sections
        .find((s) => /conclusion/i.test(s.heading))
        ?.content.split('\n')
        .filter((l) => /^[-*\d]/.test(l))
        .map((l) => l.replace(/^[-*\d]\s*\.?\s*/, '')) ?? [],
      references: sources.map((s) => s.url),
      generatedAt: new Date(),
      model: this.config.model,
    };
  }
}
