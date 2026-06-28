/**
 * Research Scheduler — Task scheduler untuk research periodic
 *
 * Menggunakan node-cron untuk menjadwalkan research secara periodik.
 * Tasks disimpan di JSON file ({dataDir}/scheduler-tasks.json) untuk persistensi.
 * Menjaga agar tidak menjalankan task yang sama secara bersamaan dan membatasi
 * jumlah task concurrent sesuai konfigurasi.
 */

import { v4 as uuid } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import cron from 'node-cron';
import type { ResearchQuery, ResearchResult, ResearchStatus } from '../types/index.js';
import type { ResearchEngine } from './research-engine.js';

// ─── Types ─────────────────────────────────────────────────────

export interface ScheduledTask {
  /** Unique identifier */
  id: string;
  /** Human-readable task name */
  name: string;
  /** Research query untuk dijalankan */
  query: ResearchQuery;
  /** Cron expression (node-cron format) */
  cronExpression: string;
  /** Apakah task aktif */
  enabled: boolean;
  /** Waktu eksekusi terakhir */
  lastRunAt?: Date;
  /** ID hasil riset terakhir */
  lastResultId?: string;
  /** Waktu dibuat */
  createdAt: Date;
  /** Waktu terakhir diupdate */
  updatedAt: Date;
}

export interface TaskExecution {
  /** Unique execution ID */
  id: string;
  /** Task ID yang dieksekusi */
  taskId: string;
  /** Result ID dari ResearchEngine */
  resultId: string;
  /** Status eksekusi */
  status: ResearchStatus;
  /** Waktu mulai */
  startedAt: Date;
  /** Waktu selesai */
  completedAt?: Date;
  /** Error message jika gagal */
  error?: string;
}

export interface SchedulerConfig {
  /** Timezone untuk cron (default: 'UTC') */
  timezone?: string;
  /** Maksimal task berjalan bersamaan (default: 3) */
  maxConcurrent?: number;
}

// ─── ResearchScheduler ─────────────────────────────────────────

export class ResearchScheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private cronJobs: Map<string, cron.ScheduledTask> = new Map();
  private activeExecutions: Map<string, Promise<ResearchResult>> = new Map();
  private taskHistory: Map<string, TaskExecution[]> = new Map();
  private isStarted = false;
  private tasksFilePath: string;

  /** Callback saat task selesai (status 'completed') */
  onTaskComplete: ((taskId: string, result: ResearchResult) => void) | null = null;
  /** Callback saat task error (status 'failed') */
  onTaskError: ((taskId: string, error: string) => void) | null = null;

  constructor(
    private engine: ResearchEngine,
    private config?: SchedulerConfig,
  ) {
    const dataDir = this.engine.getConfig().dataDir;
    this.tasksFilePath = path.join(dataDir, 'scheduler-tasks.json');
  }

  /**
   * Resolve config dengan default values
   */
  private get resolvedConfig(): Required<SchedulerConfig> {
    return {
      timezone: this.config?.timezone ?? 'UTC',
      maxConcurrent: this.config?.maxConcurrent ?? 3,
    };
  }

  // ─── Task Management ───────────────────────────────────────

  /**
   * Tambah task baru.
   * Task akan langsung di-schedule jika scheduler sedang running.
   *
   * @param name - Nama task
   * @param query - Research query
   * @param cronExpression - Cron expression (node-cron format)
   * @throws {Error} Jika cron expression invalid
   */
  async addTask(name: string, query: ResearchQuery, cronExpression: string): Promise<ScheduledTask> {
    this.validateCron(cronExpression);

    const task: ScheduledTask = {
      id: uuid(),
      name,
      query,
      cronExpression,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.tasks.set(task.id, task);
    await this.saveTasks();

    if (this.isStarted) {
      this.scheduleTask(task);
    }

    return task;
  }

  /**
   * Hapus task. Jika task sedang running, execution tetap berjalan
   * tapi cron job dihentikan.
   *
   * @returns true jika task ditemukan dan dihapus
   */
  async removeTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    this.cancelCronJob(taskId);
    this.tasks.delete(taskId);
    this.taskHistory.delete(taskId);

    await this.saveTasks();
    return true;
  }

  /**
   * Update task yang sudah ada.
   * Jika cron expression berubah, schedule akan di-reset.
   *
   * @throws {Error} Jika task tidak ditemukan atau cron expression invalid
   */
  async updateTask(taskId: string, updates: Partial<ScheduledTask>): Promise<ScheduledTask> {
    const existing = this.tasks.get(taskId);
    if (!existing) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (updates.cronExpression !== undefined && updates.cronExpression !== existing.cronExpression) {
      this.validateCron(updates.cronExpression);
    }

    const updated: ScheduledTask = {
      ...existing,
      ...updates,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date(),
    };

    this.tasks.set(taskId, updated);
    await this.saveTasks();

    // Reschedule jika perlu
    if (this.isStarted) {
      this.cancelCronJob(taskId);
      if (updated.enabled) {
        this.scheduleTask(updated);
      }
    }

    return updated;
  }

  /**
   * Ambil task berdasarkan ID
   */
  async getTask(taskId: string): Promise<ScheduledTask | null> {
    return this.tasks.get(taskId) ?? null;
  }

  /**
   * List semua task
   */
  async listTasks(): Promise<ScheduledTask[]> {
    return Array.from(this.tasks.values());
  }

  /**
   * Riwayat eksekusi sebuah task.
   * History disimpan in-memory (max 100 entry per task).
   *
   * @param limit - Maksimal entry yang dikembalikan (default: semua)
   */
  async getTaskHistory(taskId: string, limit?: number): Promise<TaskExecution[]> {
    const history = this.taskHistory.get(taskId) ?? [];
    if (limit !== undefined && limit > 0) {
      return history.slice(-limit);
    }
    return [...history];
  }

  // ─── Control ──────────────────────────────────────────────

  /**
   * Start scheduler.
   * Load tasks dari file dan schedule ulang semua enabled tasks.
   */
  start(): void {
    if (this.isStarted) return;
    this.isStarted = true;

    this.loadTasks()
      .then(() => {
        for (const task of this.tasks.values()) {
          if (task.enabled) {
            this.scheduleTask(task);
          }
        }
      })
      .catch((error) => {
        console.error('[ResearchScheduler] Gagal load tasks:', error);
      });
  }

  /**
   * Stop scheduler.
   * Stop semua cron jobs. Task yang sedang running tetap berjalan.
   */
  stop(): void {
    this.isStarted = false;
    for (const job of this.cronJobs.values()) {
      job.stop();
    }
    this.cronJobs.clear();
  }

  /**
   * Jalankan task sekali langsung tanpa menunggu cron.
   *
   * @throws {Error} Jika task tidak ditemukan atau sudah running
   */
  async runNow(taskId: string): Promise<ResearchResult> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    return this.executeTask(task);
  }

  // ─── Private: Execution ─────────────────────────────────────

  /**
   * Eksekusi task melalui ResearchEngine.
   * Menangani: concurrent guard, duplicate guard, history, callbacks.
   */
  private async executeTask(task: ScheduledTask): Promise<ResearchResult> {
    const cfg = this.resolvedConfig;

    // Cek duplicate — jangan jalankan task yang sudah running
    if (this.activeExecutions.has(task.id)) {
      throw new Error(`Task "${task.name}" is already running`);
    }

    // Cek concurrent limit
    if (this.activeExecutions.size >= cfg.maxConcurrent) {
      throw new Error(`Maximum concurrent tasks reached (${cfg.maxConcurrent})`);
    }

    const executionId = uuid();
    const execution: TaskExecution = {
      id: executionId,
      taskId: task.id,
      resultId: '',
      status: 'running',
      startedAt: new Date(),
    };

    const runPromise = this.runExecution(task, execution);
    this.activeExecutions.set(task.id, runPromise);

    return runPromise;
  }

  /**
   * Internal runner — handle result, update task, fire callbacks
   */
  private async runExecution(task: ScheduledTask, execution: TaskExecution): Promise<ResearchResult> {
    try {
      const result = await this.engine.executeResearch(task.query);

      execution.status = result.status;
      execution.resultId = result.id;
      execution.completedAt = result.completedAt ?? new Date();

      // Update lastRunAt pada task
      const savedTask = this.tasks.get(task.id);
      if (savedTask) {
        savedTask.lastRunAt = new Date();
        savedTask.lastResultId = result.id;
        savedTask.updatedAt = new Date();
        await this.saveTasks();
      }

      this.addToHistory(task.id, execution);

      if (result.status === 'completed') {
        this.onTaskComplete?.(task.id, result);
      } else if (result.status === 'failed') {
        execution.error = result.error;
        this.onTaskError?.(task.id, result.error ?? 'Unknown error');
      }

      return result;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      execution.status = 'failed';
      execution.error = errMsg;
      execution.completedAt = new Date();
      this.addToHistory(task.id, execution);

      this.onTaskError?.(task.id, errMsg);
      throw error;
    } finally {
      this.activeExecutions.delete(task.id);
    }
  }

  /**
   * Simpan execution ke history dalam-memory (max 100 per task)
   */
  private addToHistory(taskId: string, execution: TaskExecution): void {
    if (!this.taskHistory.has(taskId)) {
      this.taskHistory.set(taskId, []);
    }
    const history = this.taskHistory.get(taskId)!;
    history.push(execution);
    if (history.length > 100) {
      history.shift();
    }
  }

  // ─── Private: Scheduling ───────────────────────────────────

  /**
   * Schedule task dengan node-cron
   */
  private scheduleTask(task: ScheduledTask): void {
    this.cancelCronJob(task.id);

    const job = cron.schedule(
      task.cronExpression,
      () => {
        this.executeTask(task).catch((error) => {
          console.error(`[ResearchScheduler] Task "${task.name}" failed:`, error);
        });
      },
      {
        scheduled: true,
        timezone: this.resolvedConfig.timezone,
      },
    );

    this.cronJobs.set(task.id, job);
  }

  /**
   * Cancel dan cleanup cron job untuk task
   */
  private cancelCronJob(taskId: string): void {
    const job = this.cronJobs.get(taskId);
    if (job) {
      job.stop();
      this.cronJobs.delete(taskId);
    }
  }

  // ─── Private: Persistence ───────────────────────────────────

  /**
   * Load tasks dari JSON file.
   * Jika file corrupted, backup dulu lalu reset.
   */
  private async loadTasks(): Promise<void> {
    try {
      const raw = await fs.readFile(this.tasksFilePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);

      if (!Array.isArray(parsed)) {
        throw new Error('Invalid tasks file format');
      }

      this.tasks.clear();
      for (const item of parsed) {
        const task = item as ScheduledTask;
        task.createdAt = new Date(task.createdAt);
        task.updatedAt = new Date(task.updatedAt);
        if (task.lastRunAt) task.lastRunAt = new Date(task.lastRunAt);
        this.tasks.set(task.id, task);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // File belum ada — normal untuk first run
        return;
      }

      // File corrupted — backup dan reset
      console.error('[ResearchScheduler] Tasks file corrupted, backing up and resetting:', error);
      try {
        const backupPath = `${this.tasksFilePath}.backup.${Date.now()}`;
        await fs.copyFile(this.tasksFilePath, backupPath);
        console.warn(`[ResearchScheduler] Corrupted file backed up to: ${backupPath}`);
      } catch {
        // Backup failure — non-fatal
      }

      this.tasks.clear();
    }
  }

  /**
   * Save tasks ke JSON file
   */
  private async saveTasks(): Promise<void> {
    const dataDir = path.dirname(this.tasksFilePath);
    await fs.mkdir(dataDir, { recursive: true }).catch(() => {});

    const tasks = Array.from(this.tasks.values());
    await fs.writeFile(this.tasksFilePath, JSON.stringify(tasks, null, 2), 'utf-8');
  }

  // ─── Private: Validation ───────────────────────────────────

  /**
   * Validasi cron expression menggunakan node-cron's validate
   *
   * @throws {Error} Jika expression tidak valid
   */
  private validateCron(expression: string): void {
    if (!cron.validate(expression)) {
      throw new Error(`Invalid cron expression: "${expression}"`);
    }
  }
}
