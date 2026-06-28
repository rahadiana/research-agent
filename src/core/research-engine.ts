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
} from '../types/index.js';

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
   * Eksekusi research pipeline lengkap
   */
  async executeResearch(query: ResearchQuery): Promise<ResearchResult> {
    const abortController = new AbortController();
    const resultId = uuid();
    const mergedQuery = this.mergeDefaults(query);

    const result: ResearchResult = {
      id: resultId,
      query: mergedQuery,
      status: 'queued',
      sources: [],
      progress: { phase: 'queued', percent: 0, message: 'Dalam antrian...' },
      startedAt: new Date(),
      createdAt: new Date(),
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
   */
  async addSubResearch(
    parentId: string,
    subQuery: ResearchQuery,
  ): Promise<ResearchResult | null> {
    const parent = await this.storage.getResult(parentId);
    if (!parent) return null;

    // Jalankan riset baru
    const child = await this.executeResearch(subQuery);
    child.parentId = parentId;
    child.tags = [...(parent.tags ?? []), 'sub-research'];

    // Update parent
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
    } as Required<ResearchQuery>;
  }
}
