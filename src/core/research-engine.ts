/**
 * Research Engine — Orchestrator untuk pipeline riset multi-tahap
 *
 * Mengkoordinasikan: SourceCollectors → Processing → LLM Synthesis → Storage
 * Events: 'progress', 'complete', 'error' untuk real-time monitoring
 */

import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';
import type {
  ResearchQuery,
  ResearchResult,
  ResearchReport,
  ResearchConfig,
  ResearchStorage,
  LLMProvider,
  SourceCollector,
  Source,
  ResearchProgress,
  ResearchGraph,
} from '../types/index.js';

/**
 * Metadata tambahan saat mengeksekusi research.
 * Dipakai untuk sub-research (parentId) dan versioning.
 */
export interface ResearchMeta {
  /** ID custom (default: auto-generate) */
  id?: string;
  /** ID parent — untuk sub-research (child → parent) */
  parentId?: string;
  /** Versi — naik tiap kali di-rerun */
  version?: number;
  /** Tag untuk grouping */
  tags?: string[];
}

export interface ResearchEvents {
  on(event: 'progress', listener: (resultId: string, progress: ResearchProgress) => void): this;
  on(event: 'complete', listener: (result: ResearchResult) => void): this;
  on(event: 'error', listener: (resultId: string, error: string) => void): this;
  emit(event: 'progress' | 'complete' | 'error', ...args: unknown[]): boolean;
}

export class ResearchEngine extends EventEmitter implements ResearchEvents {
  private config: ResearchConfig;
  private storage: ResearchStorage;
  private llm: LLMProvider;
  private collectors: SourceCollector[] = [];
  private activeResearch: Map<string, AbortController> = new Map();

  constructor(config: ResearchConfig, storage: ResearchStorage, llm: LLMProvider) {
    super();
    this.config = config;
    this.storage = storage;
    this.llm = llm;
  }

  /**
   * Daftarkan source collector (web, pdf, dll)
   */
  registerCollector(collector: SourceCollector): void {
    this.collectors.push(collector);
  }

  /**
   * Eksekusi research pipeline lengkap.
   *
   * @param query - Query riset dari user
   * @param meta  - Metadata opsional: id custom, parentId (sub-research), version, tags
   */
  async executeResearch(query: ResearchQuery, meta?: ResearchMeta): Promise<ResearchResult> {
    const abortController = new AbortController();
    const resultId = meta?.id ?? uuid();
    const mergedQuery = this.mergeDefaults(query);

    const result: ResearchResult = {
      id: resultId,
      query: mergedQuery,
      status: 'queued',
      sources: [],
      progress: { phase: 'queued', percent: 0, message: 'Dalam antrian...' },
      startedAt: new Date(),
      createdAt: new Date(),
      parentId: meta?.parentId,
      version: meta?.version,
      tags: meta?.tags,
    };

    // Simpan segera agar kelihatan di dashboard meski masih antri
    try {
      await this.storage.saveResult(result);
    } catch (err) {
      console.warn('[ResearchEngine] Gagal simpan status queued:', err);
    }
    // Emit 'started' agar dashboard reload & tampilkan item baru di queue
    this.emit('started', result);
    this.activeResearch.set(resultId, abortController);

    try {
      // Update status ke 'running'
      result.status = 'running';
      await this.storage.saveResult(result);

      // === Phase 1: Search & Collect ===
      await this.updateProgress(result, 'searching', 5, 'Mencari sumber informasi...', true);
      let allSources = 0;

      for (const collector of this.collectors) {
        if (abortController.signal.aborted) {
          throw new Error('Riset dibatalkan');
        }

        try {
          const sources = await collector.collect(mergedQuery);
          result.sources.push(...sources);
          allSources += sources.length;
          await this.updateProgress(
            result,
            'searching',
            10 + Math.min((allSources / mergedQuery.maxSources) * 20, 20),
            `Mengumpulkan sumber... (${allSources} ditemukan)`,
            true,
          );
        } catch (collectorError) {
          console.warn(`[ResearchEngine] Collector ${collector.name} gagal:`, collectorError);
          // Lanjutkan ke collector lain — jangan gagalkan seluruh riset
        }
      }

      if (result.sources.length === 0) {
        throw new Error('Tidak ada sumber yang berhasil dikumpulkan');
      }

      // Filter sumber berdasarkan relevance (jika sudah ada score)
      result.sources.sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0));

      // Cap jumlah sumber sesuai maxSources (extra safety)
      if (result.sources.length > mergedQuery.maxSources) {
        result.sources = result.sources.slice(0, mergedQuery.maxSources);
      }

      // === Phase 2: Processing ===
      await this.updateProgress(result, 'processing', 40, 'Memproses dan menganalisis sumber...', true);

      // Index sources ke vector database untuk semantic search nanti
      const storageWithIndex = this.storage as ResearchStorage & { indexSource(id: string, source: Source): Promise<void> };
      if (typeof storageWithIndex.indexSource === 'function') {
        for (const source of result.sources) {
          try {
            await storageWithIndex.indexSource(resultId, source);
          } catch {
            // Non-fatal: indexing failure tidak menggagalkan riset utama
          }
        }
      }

      // === Phase 3: Synthesize ===
      await this.updateProgress(result, 'synthesizing', 70, 'Mensintesis hasil riset...', true);
      const report = await this.llm.synthesize(result.sources, mergedQuery);
      result.report = report;

      // === Selesai ===
      result.status = 'completed';
      result.completedAt = new Date();
      await this.updateProgress(result, 'done', 100, 'Riset selesai!', true);

      // Final save — dengan embeddings lengkap untuk semantic search
      await this.storage.saveResult(result);
      this.emit('complete', result);

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.status = 'failed';
      result.error = errorMsg;
      result.completedAt = new Date();
      result.progress = { phase: 'done', percent: 0, message: `Gagal: ${errorMsg}` };

      // Tetap simpan hasil gagal (biar ada record)
      try {
        await this.storage.saveResult(result);
      } catch (err) {
        console.error('[ResearchEngine] Gagal menyimpan hasil riset:', errorMsg, err);
      }

      this.emit('error', resultId, errorMsg);
      return result;
    } finally {
      this.activeResearch.delete(resultId);
    }
  }

  /**
   * Batalkan riset yang sedang berjalan
   */
  cancelResearch(resultId: string): boolean {
    const controller = this.activeResearch.get(resultId);
    if (controller) {
      controller.abort();
      return true;
    }
    return false;
  }

  /**
   * Ambil hasil riset dari storage
   */
  async getResult(id: string): Promise<ResearchResult | null> {
    return this.storage.getResult(id);
  }

  /**
   * List hasil riset
   */
  async listResults(limit = 10, offset = 0): Promise<ResearchResult[]> {
    return this.storage.listResults(limit, offset);
  }

  /**
   * Cari hasil riset dengan semantic search
   */
  async searchResults(query: string): Promise<ResearchResult[]> {
    const storage = this.storage as ResearchStorage & { searchResults(q: string): Promise<ResearchResult[]> };
    if (typeof storage.searchResults === 'function') {
      return storage.searchResults(query);
    }
    return this.storage.listResults(10, 0);
  }

  /**
   * Hapus hasil riset
   */
  async deleteResult(id: string): Promise<void> {
    return this.storage.deleteResult(id);
  }

  /**
   * Dapatkan konfigurasi
   */
  getConfig(): ResearchConfig {
    return { ...this.config };
  }

  /**
   * Cek apakah ada riset aktif
   */
  hasActiveResearch(): boolean {
    return this.activeResearch.size > 0;
  }

  /**
   * Dapatkan daftar ID riset aktif
   */
  getActiveResearchIds(): string[] {
    return Array.from(this.activeResearch.keys());
  }

  /**
   * Recovery: temuin riset yg statusnya 'running' atau 'queued' tapi
   * gak ada di activeResearch (misal server mati mendadak / restart).
   * Tandai sebagai 'failed' biar gak stuck selamanya.
   */
  async recoverStaleTasks(): Promise<number> {
    let count = 0;
    try {
      const all = await this.storage.listResults(100, 0);
      for (const r of all) {
        if (r.status === 'running' || r.status === 'queued') {
          const stillActive = this.activeResearch.has(r.id);
          if (!stillActive) {
            await this.storage.updateResult(r.id, {
              status: 'failed',
              error: 'Server restart — riset terputus. Silakan coba lagi.',
              completedAt: new Date(),
              progress: { phase: 'done', percent: 0, message: 'Terputus oleh restart server' },
            });
            count++;
          }
        }
      }
    } catch (err) {
      console.warn('[ResearchEngine] Gagal recover stale tasks:', err);
    }
    return count;
  }

  /**
   * Rerun research dengan ID yang sama — query bisa di-override.
   * Versi naik 1, status lama tetap di history (parentId chain).
   */
  async rerunResearch(
    id: string,
    overrides?: Partial<ResearchQuery>,
  ): Promise<ResearchResult | null> {
    const existing = await this.storage.getResult(id);
    if (!existing) return null;

    const query: ResearchQuery = {
      ...existing.query,
      ...overrides,
    };

    // Simpan versi lama dengan status 'completed', link via childIds
    const nextVersion = (existing.version ?? 1) + 1;
    existing.childIds = [...(existing.childIds ?? []), existing.id]; // will be replaced

    // Execute baru
    const newResult = await this.executeResearch(query);
    newResult.parentId = existing.parentId || existing.id;
    newResult.version = nextVersion;

    // Update parent: tambah child link
    if (existing.parentId) {
      const parent = await this.storage.getResult(existing.parentId);
      if (parent) {
        parent.childIds = [...new Set([...(parent.childIds ?? []), newResult.id])];
        await this.storage.updateResult(existing.parentId, { childIds: parent.childIds });
      }
    } else {
      // Root research — update childIds
      existing.childIds = [...new Set([...(existing.childIds ?? []), newResult.id])];
      await this.storage.updateResult(existing.id, { childIds: existing.childIds });
    }

    return newResult;
  }

  /**
   * Retry research dengan ID yang SAMA (bukan bikin baru).
   * Reset status, hapus error, lalu execute ulang.
   * UI row tetap sama, progress bar jalan dari 0%.
   */
  async retryResearch(id: string): Promise<ResearchResult | null> {
    const existing = await this.storage.getResult(id);
    if (!existing) return null;

    // Reset result — pake ID yg sama, query yg sama
    const mergedQuery = this.mergeDefaults(existing.query);
    const result: ResearchResult = {
      id: existing.id,
      query: mergedQuery,
      status: 'queued',
      sources: [],
      report: undefined,
      error: undefined,
      completedAt: undefined,
      progress: { phase: 'queued', percent: 0, message: 'Dalam antrian...' },
      startedAt: new Date(),
      createdAt: existing.createdAt,
      version: (existing.version ?? 1) + 1,
      parentId: existing.parentId,
      tags: existing.tags,
    };

    // Simpan status queued
    try {
      await this.storage.saveResult(result);
    } catch (err) {
      console.warn('[ResearchEngine] Gagal simpan retry queued:', err);
    }

    this.emit('started', result);
    const abortController = new AbortController();
    this.activeResearch.set(result.id, abortController);

    try {
      result.status = 'running';
      await this.storage.saveResult(result);

      await this.updateProgress(result, 'searching', 5, 'Mencari sumber informasi...', true);
      let allSources = 0;

      for (const collector of this.collectors) {
        if (abortController.signal.aborted) throw new Error('Riset dibatalkan');
        try {
          const sources = await collector.collect(mergedQuery);
          result.sources.push(...sources);
          allSources += sources.length;
          await this.updateProgress(result, 'searching', 10 + Math.min((allSources / mergedQuery.maxSources) * 20, 20),
            `Mengumpulkan sumber... (${allSources} ditemukan)`, true);
        } catch (collectorError) {
          console.warn(`[ResearchEngine] Collector ${collector.name} gagal:`, collectorError);
        }
      }

      if (result.sources.length === 0) throw new Error('Tidak ada sumber yang berhasil dikumpulkan');
      result.sources.sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0));
      if (result.sources.length > mergedQuery.maxSources) {
        result.sources = result.sources.slice(0, mergedQuery.maxSources);
      }

      await this.updateProgress(result, 'processing', 40, 'Memproses dan menganalisis sumber...', true);

      const storageWithIndex = this.storage as ResearchStorage & { indexSource(id: string, source: Source): Promise<void> };
      if (typeof storageWithIndex.indexSource === 'function') {
        for (const source of result.sources) {
          try { await storageWithIndex.indexSource(result.id, source); } catch { /* non-fatal */ }
        }
      }

      await this.updateProgress(result, 'synthesizing', 70, 'Mensintesis hasil riset...', true);
      const report = await this.llm.synthesize(result.sources, mergedQuery);
      result.report = report;

      result.status = 'completed';
      result.completedAt = new Date();
      await this.updateProgress(result, 'done', 100, 'Riset selesai!', true);
      await this.storage.saveResult(result);
      this.emit('complete', result);
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.status = 'failed';
      result.error = errorMsg;
      result.completedAt = new Date();
      result.progress = { phase: 'done', percent: 0, message: `Gagal: ${errorMsg}` };
      try { await this.storage.saveResult(result); } catch (err) {
        console.error('[ResearchEngine] Gagal menyimpan hasil riset:', errorMsg, err);
      }
      this.emit('error', result.id, errorMsg);
      return result;
    } finally {
      this.activeResearch.delete(result.id);
    }
  }

  /**
   * Edit report & metadata dari hasil riset yang sudah selesai.
   */
  async updateResult(
    id: string,
    updates: {
      report?: ResearchReport;
      tags?: string[];
      query?: ResearchQuery;
    },
  ): Promise<ResearchResult | null> {
    const existing = await this.storage.getResult(id);
    if (!existing) return null;

    const patch: Partial<ResearchResult> = {};
    if (updates.report) patch.report = updates.report;
    if (updates.tags) patch.tags = updates.tags;
    if (updates.query) patch.query = { ...existing.query, ...updates.query };

    return this.storage.updateResult(id, patch);
  }

  /**
   * Buat sub-research (cabang) dari hasil riset yang sudah ada.
   * Anak bisa explore aspek spesifik dari topik parent.
   * Link parent↔child dibuat SEJAK queued (bukan setelah selesai),
   * sehingga graph langsung menunjukkan struktur cabang.
   */
  async addSubResearch(
    parentId: string,
    subQuery: ResearchQuery,
  ): Promise<ResearchResult | null> {
    const parent = await this.storage.getResult(parentId);
    if (!parent) return null;

    // Jalankan riset baru — parentId, tags, dan parentContext langsung ter-set
    // SEBELUM eksekusi. parentContext membuat pencarian child TER-SCOPE ke
    // konteks induk, sehingga hasilnya relevan (bukan pencarian generik nyasar).
    const scopedQuery: ResearchQuery = {
      ...subQuery,
      parentContext: parent.query.topic,
    };

    const child = await this.executeResearch(scopedQuery, {
      parentId,
      tags: [...(parent.tags ?? []), 'sub-research'],
    });
    child.tags = [...(parent.tags ?? []), 'sub-research'];

    // Update parent: tambah child link
    parent.childIds = [...new Set([...(parent.childIds ?? []), child.id])];
    await this.storage.updateResult(parentId, { childIds: parent.childIds });

    return child;
  }

  /**
   * Dapatkan semua sub-research dari parent
   */
  async getSubResearch(parentId: string): Promise<ResearchResult[]> {
    return this.storage.searchByParent(parentId);
  }

  /**
   * Bangun research graph (nodes + edges) dari SEMUA hasil riset.
   * Edge dibuat dari relasi parentId dan childIds (dedupe).
   */
  async getGraph(): Promise<ResearchGraph> {
    const all = await this.storage.listResults(500, 0);
    const nodes: ResearchGraph['nodes'] = [];
    const edges: ResearchGraph['edges'] = [];
    const nodeIds = new Set<string>();
    const edgeKeys = new Set<string>();

    for (const r of all) {
      if (nodeIds.has(r.id)) continue;
      nodeIds.add(r.id);
      nodes.push({
        id: r.id,
        label: r.query.topic,
        status: r.status,
        sources: r.sources.length,
        createdAt: r.createdAt,
        parentId: r.parentId,
        childCount: 0,
        version: r.version,
      });
    }

    // Edges: dari relasi parentId + childIds (pastikan node-nya ada)
    for (const r of all) {
      if (r.parentId && nodeIds.has(r.parentId)) {
        const key = `${r.parentId}->${r.id}`;
        if (!edgeKeys.has(key)) {
          edgeKeys.add(key);
          edges.push({ from: r.parentId, to: r.id });
        }
      }
      for (const childId of r.childIds ?? []) {
        if (nodeIds.has(childId)) {
          const key = `${r.id}->${childId}`;
          if (!edgeKeys.has(key)) {
            edgeKeys.add(key);
            edges.push({ from: r.id, to: childId });
          }
        }
      }
    }

    // Hitung childCount akurat dari edges
    const childCountMap = new Map<string, number>();
    for (const edge of edges) {
      childCountMap.set(edge.from, (childCountMap.get(edge.from) ?? 0) + 1);
    }
    for (const node of nodes) {
      node.childCount = childCountMap.get(node.id) ?? 0;
    }

    return { nodes, edges };
  }

  /**
   * Generate saran sub-query (deep dive) dari report parent via LLM.
   * Fallback: return [] jika report belum ada atau LLM gagal.
   *
   * @param parentId - ID research parent (harus completed + punya report)
   * @param count    - Jumlah saran (default: 5, max: 10)
   */
  async suggestSubQueries(parentId: string, count = 5): Promise<string[]> {
    const parent = await this.storage.getResult(parentId);
    if (!parent) return [];
    const report = parent.report;
    if (!report) return [];

    const safeCount = Math.min(Math.max(Math.floor(count), 1), 10);

    // Bangun konteks dari report — cukup headings & ringkasan, bukan full content
    const contextParts = [
      `Topik riset: ${parent.query.topic}`,
      report.summary ? `Ringkasan: ${report.summary.slice(0, 3000)}` : '',
      report.keyFindings.length > 0
        ? `Temuan kunci:\n${report.keyFindings.map((f) => `- ${f}`).slice(0, 10).join('\n')}`
        : '',
      report.sections.length > 0
        ? `Bagian laporan:\n${report.sections.map((s) => `- ${s.heading}`).join('\n')}`
        : '',
      report.conclusions.length > 0
        ? `Kesimpulan:\n${report.conclusions.map((c) => `- ${c}`).slice(0, 10).join('\n')}`
        : '',
    ];

    const context = contextParts.filter(Boolean).join('\n\n');

    const question =
      `Berdasarkan laporan riset di atas, buatkan ${safeCount} pertanyaan deep-dive ` +
      `(sub-query) untuk riset lanjutan yang LEBIH SPESIFIK dan MENDALAM. ` +
      `Setiap pertanyaan harus fokus pada SATU aspek spesifik yang belum terjawab ` +
      `atau layak digali lebih dalam dari topik "${parent.query.topic}". ` +
      `Format: satu pertanyaan per baris, awali dengan "- ". Jangan tambahkan teks lain.`;

    try {
      const raw = await this.llm.answer(question, context);
      const suggestions = raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.replace(/^[-*\d.)\s]+/, '').trim())
        .filter((line) => line.length >= 8 && line.length <= 300)
        .slice(0, safeCount);

      return suggestions;
    } catch (err) {
      console.warn('[ResearchEngine] Gagal generate saran sub-query:', err);
      return [];
    }
  }

  /**
   * Update progress dan emit event
   */
  private async updateProgress(
    result: ResearchResult,
    phase: ResearchProgress['phase'],
    percent: number,
    message: string,
    saveToStorage = false,
  ): Promise<void> {
    result.progress = { phase, percent, message };
    this.emit('progress', result.id, result.progress);
    if (saveToStorage) {
      try {
        // updateResult lebih ringan daripada saveResult (tidak re-embed)
        await this.storage.updateResult(result.id, {
          progress: result.progress,
          status: result.status,
          sources: result.sources,
        });
      } catch (err) {
        console.warn('[ResearchEngine] Gagal update progress:', err);
      }
    }
  }

  /**
   * Gabungkan query user dengan default config
   */
  private mergeDefaults(query: ResearchQuery): Required<ResearchQuery> {
    return {
      topic: query.topic,
      questions: query.questions ?? [],
      depth: query.depth ?? this.config.depth,
      maxSources: query.maxSources ?? this.config.maxSources,
      filters: query.filters ?? {},
      parentContext: query.parentContext,
    } as Required<ResearchQuery>;
  }
}
