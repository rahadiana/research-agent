/**
 * Dashboard Server — Express + Socket.IO + EJS
 * Web interface untuk Research Agent dengan real-time monitoring via WebSocket
 */

import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';
import type { ResearchEngine } from '../core/research-engine.js';
import type { ResearchScheduler } from '../core/scheduler.js';
import type {
  ResearchResult,
  ResearchQuery,
  ResearchProgress,
} from '../types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DashboardConfig {
  port: number;
  host: string;
}

interface DashboardStats {
  total: number;
  completed: number;
  failed: number;
  running: number;
  queued: number;
  totalSources: number;
  successRate: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Render EJS view dengan layout wrapper.
 * Render page content → inject ke layout.ejs via variabel `body`
 */
function renderWithLayout(
  res: express.Response,
  view: string,
  options: Record<string, unknown>,
): void {
  res.render(view, options, (err: unknown, html?: string) => {
    if (err || !html) {
      res.status(500).send(
        `Render error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    res.render('layout', { ...options, body: html }, (err2: unknown, html2?: string) => {
      if (err2 || !html2) {
        res.status(500).send(
          `Layout error: ${err2 instanceof Error ? err2.message : String(err2)}`,
        );
        return;
      }
      res.send(html2);
    });
  });
}

/**
 * Konversi ResearchResult report ke markdown string
 */
/**
 * Sanitasi markdown report sebelum di-render — konten report berasal dari
 * teks web yang di-scrape (UNTRUSTED). marked melewatkan raw HTML apa adanya,
 * jadi konten scraped bisa menyuntik <style> (mis. display:none → halaman
 * terlihat kosong), <script>, atau link berbahaya.
 *
 * Yang dilakukan:
 * - Hapus blok <style>/<script> (dan isinya)
 * - Netralkan link relatif (artifact Google cache: /httpservice/...)
 * - Netralkan link javascript:/data:
 * - Hapus SEMUA raw HTML tag yang tersisa (teksnya tetap dipertahankan)
 */
export function sanitizeReportMarkdown(md: string): string {
  return md
    // Blok style/script dihapus total (bisa menyembunyikan halaman / XSS)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    // Link relatif (artifact halaman cache Google) → teks saja
    .replace(/<a\s+href="\/(?!\/)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi, '$1')
    .replace(/\[([^\]]*)\]\(\/(?!\/)[^)\s]*\)/g, '$1')
    // Link berbahaya javascript:/data: → dibuang
    .replace(/\[([^\]]*)\]\((?:javascript|data):[^)]*\)/gi, '$1')
    // Meta refresh → hapus
    .replace(/<meta[^>]*url=[^>]*>/gi, '')
    // Raw HTML tag tersisa (untrusted) → teksnya saja
    .replace(/<[^>]*>/g, '');
}

/**
 * Konversi report ke markdown — versi FULL untuk export (MD/HTML).
 */
function reportToExportMarkdown(result: ResearchResult): string {
  const report = result.report;
  if (!report) return '';

  let md = `# ${report.title}\n\n`;
  md += `> ${report.summary}\n\n`;

  if (report.keyFindings.length > 0) {
    md += '## Key Findings\n\n';
    for (const finding of report.keyFindings) {
      md += `- ${finding}\n`;
    }
    md += '\n';
  }

  for (const section of report.sections) {
    md += `## ${section.heading}\n\n`;
    md += `${section.content}\n\n`;
    if (section.subsections) {
      for (const sub of section.subsections) {
        md += `### ${sub.heading}\n\n`;
        md += `${sub.content}\n\n`;
      }
    }
  }

  if (report.conclusions.length > 0) {
    md += '## Conclusions\n\n';
    for (const c of report.conclusions) {
      md += `- ${c}\n`;
    }
    md += '\n';
  }

  if (report.references.length > 0) {
    md += '## References\n\n';
    for (let i = 0; i < report.references.length; i++) {
      md += `${i + 1}. ${report.references[i]}\n`;
    }
    md += '\n';
  }

  return sanitizeReportMarkdown(md);
}

/**
 * Pecah teks jadi paragraf: prioritas double-newline, fallback split by kalimat.
 *
 * Split kalimat memakai lookbehind: titik/!? dianggap AKHIR kalimat HANYA jika
 * diikuti spasi + huruf kapital/angka/kutip. Ini mencegah titik di dalam
 * kalimat (domain "example.com", singkatan "e.g.", "U.S.A") memecah kalimat
 * di tengah dan MEMBUANG teks di depannya.
 */
export function splitIntoParagraphs(text: string): string[] {
  if (!text) return [];

  const byDouble = text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  if (byDouble.length > 1) return byDouble;

  // Split by kalimat — titik internal (domain/singkatan) tidak memecah kalimat
  let sentences = text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'“])/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length === 0) sentences = [text.trim()];

  // Group 7-8 kalimat per paragraf biar gak kepotong2 kecil
  const groupSize = sentences.length > 20 ? 8 : 6;
  const chunks: string[] = [];
  for (let i = 0; i < sentences.length; i += groupSize) {
    const chunk = sentences.slice(i, i + groupSize).join(' ').trim();
    if (chunk) chunks.push(chunk);
  }
  return chunks.length > 0 ? chunks : [text.trim()];
}

/**
 * Konversi HANYA sections report ke markdown — untuk ditampilkan di dashboard.
 * Summary, Key Findings, Conclusions, References sudah di-render oleh EJS card.
 */
function reportSectionsToMarkdown(result: ResearchResult): string {
  const report = result.report;
  if (!report) return '';

  const parts: string[] = [];

  for (const section of report.sections) {
    const paragraphs = splitIntoParagraphs(section.content);
    parts.push(`## ${section.heading}\n\n${paragraphs.join('\n\n')}`);
    if (section.subsections) {
      for (const sub of section.subsections) {
        const subParagraphs = splitIntoParagraphs(sub.content);
        parts.push(`### ${sub.heading}\n\n${subParagraphs.join('\n\n')}`);
      }
    }
  }

  return sanitizeReportMarkdown(parts.join('\n\n'));
}

/**
 * Komputasi statistik dari daftar hasil riset
 */
function computeStats(results: ResearchResult[]): DashboardStats {
  const total = results.length;
  const completed = results.filter((r) => r.status === 'completed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const running = results.filter((r) => r.status === 'running').length;
  const queued = results.filter((r) => r.status === 'queued').length;
  const totalSources = results.reduce((sum, r) => sum + r.sources.length, 0);
  const successRate = total > 0 ? Math.round((completed / total) * 100) : 0;

  return { total, completed, failed, running, queued, totalSources, successRate };
}

// ---------------------------------------------------------------------------
// DashboardServer
// ---------------------------------------------------------------------------

export class DashboardServer {
  private app: express.Application;
  private server: http.Server;
  private io: SocketIOServer;
  private engine: ResearchEngine;
  private scheduler?: ResearchScheduler;
  private port: number;
  private host: string;

  /**
   * @param engine    - Instance ResearchEngine
   * @param port      - Port (default: env DASHBOARD_PORT atau 3000)
   * @param host      - Host (default: env DASHBOARD_HOST atau 'localhost')
   * @param scheduler - Instance ResearchScheduler (opsional)
   */
  constructor(engine: ResearchEngine, port?: number, host?: string, scheduler?: ResearchScheduler) {
    this.engine = engine;
    this.scheduler = scheduler;
    this.port = port ?? (Number(process.env.DASHBOARD_PORT) || 3000);
    this.host = host ?? (process.env.DASHBOARD_HOST || 'localhost');

    this.app = express();
    this.server = http.createServer(this.app);
    this.io = new SocketIOServer(this.server, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
    });

    this.setupMiddleware();
    this.setupRoutes();
    this.setupSocketEvents();
    this.setupEngineListeners();
  }

  // -----------------------------------------------------------------------
  // Setup
  // -----------------------------------------------------------------------

  /** Konfigurasi Express middleware */
  private setupMiddleware(): void {
    this.app.set('view engine', 'ejs');
    this.app.set('views', path.join(__dirname, 'views'));
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(express.static(path.join(__dirname, 'public')));
  }

  /** Registrasi seluruh HTTP routes */
  private setupRoutes(): void {
    // ----- Scheduler API Routes -----
    if (this.scheduler) {
      this.app.get('/api/scheduler/tasks', async (_req, res) => {
        try {
          const tasks = await this.scheduler!.listTasks();
          res.json(tasks);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          res.status(500).json({ error: msg });
        }
      });

      this.app.post('/api/scheduler/task', async (req, res) => {
        try {
          const { name, topic, cronExpression, depth, maxSources, questions } = req.body;
          if (!name || !topic || !cronExpression) {
            res.status(400).json({ error: 'name, topic, and cronExpression are required' });
            return;
          }
          const query: ResearchQuery = {
            topic,
            depth: depth ?? 'medium',
            maxSources: maxSources ? Number(maxSources) : undefined,
            questions: questions ? (Array.isArray(questions) ? questions : [questions]) : undefined,
          };
          const task = await this.scheduler!.addTask(name, query, cronExpression);
          res.status(201).json(task);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          res.status(400).json({ error: msg });
        }
      });

      this.app.delete('/api/scheduler/task/:id', async (req, res) => {
        try {
          const deleted = await this.scheduler!.removeTask(req.params.id);
          if (deleted) res.json({ message: 'Task deleted' });
          else res.status(404).json({ error: 'Task not found' });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          res.status(500).json({ error: msg });
        }
      });

      this.app.post('/api/scheduler/task/:id/run', async (req, res) => {
        try {
          this.scheduler!.runNow(req.params.id).catch((err: Error) => {
            console.error('[Scheduler] Run task error:', err);
          });
          res.status(202).json({ message: 'Task started' });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          res.status(400).json({ error: msg });
        }
      });
    }

    // ----- Healthcheck (untuk Docker) -----
    this.app.get('/health', (_req, res) => {
      res.json({ status: 'ok', uptime: process.uptime() });
    });

    // ----- Dashboard utama -----
    this.app.get('/', async (_req, res) => {
      try {
        const allResults = await this.engine.listResults(100);
        const results = await this.engine.listResults(10);
        const stats = computeStats(allResults);
        renderWithLayout(res, 'index', { stats, results });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).send(`Error: ${msg}`);
      }
    });

    // ----- Detail research -----
    this.app.get('/research/:id', async (req, res) => {
      try {
        const result = await this.engine.getResult(req.params.id);
        if (!result) {
          res.status(404).send('Research not found');
          return;
        }

        let reportHtml = '';
        if (result.report) {
          const md = reportSectionsToMarkdown(result);
          reportHtml = await marked.parse(md);
        }

        // Data graph: parent + children untuk tampilkan cabang riset
        const [children, parent] = await Promise.all([
          this.engine.getSubResearch(result.id),
          result.parentId ? this.engine.getResult(result.parentId) : Promise.resolve(null),
        ]);

        renderWithLayout(res, 'detail', { result, reportHtml, children, parent });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).send(`Error: ${msg}`);
      }
    });

    // ----- Trigger research baru -----
    this.app.post('/research', async (req, res) => {
      try {
        const topic = req.body.topic;
        if (!topic || typeof topic !== 'string') {
          res.status(400).json({ error: 'Topic is required' });
          return;
        }

        const query: ResearchQuery = {
          topic,
          depth: req.body.depth,
          maxSources: req.body.maxSources ? Number(req.body.maxSources) : undefined,
          questions: req.body.questions,
        };

        // Fire-and-forget — client mendapat update via Socket.IO
        this.engine.executeResearch(query).catch((err: Error) => {
          console.error('[Dashboard] Research execution error:', err);
        });

        res.status(202).json({ message: 'Research queued' });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    });

    // ----- Export report -----
    this.app.get('/research/:id/export/:format', async (req, res) => {
      try {
        const result = await this.engine.getResult(req.params.id);
        if (!result) {
          res.status(404).send('Research not found');
          return;
        }
        if (!result.report) {
          res.status(400).send('No report available yet');
          return;
        }

        const format = req.params.format;
        const md = reportToExportMarkdown(result);

        switch (format) {
          case 'markdown': {
            const filename = `research-${result.id.slice(0, 8)}.md`;
            res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.send(md);
            break;
          }
          case 'json': {
            const filename = `research-${result.id.slice(0, 8)}.json`;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.json(result);
            break;
          }
          case 'html': {
            const filename = `research-${result.id.slice(0, 8)}.html`;
            const bodyHtml = await marked.parse(md);
            const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${result.report.title}</title>
  <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
</head>
<body class="bg-white p-8 max-w-4xl mx-auto prose">
  ${bodyHtml}
</body>
</html>`;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.send(fullHtml);
            break;
          }
          default:
            res.status(400).send('Invalid format. Use: markdown, json, html');
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).send(`Error: ${msg}`);
      }
    });

    // ----- Hapus research -----
    this.app.delete('/research/:id', async (req, res) => {
      try {
        await this.engine.deleteResult(req.params.id);
        res.json({ message: 'Research deleted' });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    });

    // ----- Retry research (jalanin ulang dengan ID & query yg sama) -----
    this.app.post('/research/:id/retry', async (req, res) => {
      try {
        const newResult = await this.engine.retryResearch(req.params.id);
        if (!newResult) {
          res.status(404).json({ error: 'Research not found' });
          return;
        }
        res.status(202).json({ message: 'Research retried', id: newResult.id });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    });

    // ----- Tambah sub-research (deep dive) dari parent -----
    this.app.post('/research/:id/sub', async (req, res) => {
      try {
        const parent = await this.engine.getResult(req.params.id);
        if (!parent) {
          res.status(404).json({ error: 'Research not found' });
          return;
        }

        const topic = req.body.topic;
        if (!topic || typeof topic !== 'string') {
          res.status(400).json({ error: 'Topic is required' });
          return;
        }

        const query: ResearchQuery = {
          topic,
          depth: req.body.depth,
          maxSources: req.body.maxSources ? Number(req.body.maxSources) : undefined,
          questions: req.body.questions,
        };

        // Fire-and-forget — client mendapat update via Socket.IO
        this.engine
          .addSubResearch(req.params.id, query)
          .then((child) => {
            if (child) {
              console.log(`[Dashboard] Sub-research created: ${child.id} (parent ${req.params.id})`);
            }
          })
          .catch((err: Error) => {
            console.error('[Dashboard] Sub-research error:', err);
          });

        res.status(202).json({ message: 'Sub-research queued', parentId: req.params.id });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    });

    // ----- Generate saran sub-query (deep dive) dari report parent -----
    this.app.post('/research/:id/suggest', async (req, res) => {
      try {
        const count = Number(req.body?.count) || 5;
        const suggestions = await this.engine.suggestSubQueries(req.params.id, count);
        res.json({ suggestions });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    });

    // ----- Hapus satu source dari research -----
    this.app.delete('/research/:id/sources/:sourceId', async (req, res) => {
      try {
        const result = await this.engine.removeSource(req.params.id, req.params.sourceId);
        if (!result) {
          res.status(404).json({ error: 'Research not found' });
          return;
        }
        res.json({ message: 'Source deleted', sources: result.sources.length });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(400).json({ error: msg });
      }
    });

    // ----- Kalkulasi ulang report dari sisa sumber -----
    this.app.post('/research/:id/report/regenerate', async (req, res) => {
      try {
        const result = await this.engine.getResult(req.params.id);
        if (!result) {
          res.status(404).json({ error: 'Research not found' });
          return;
        }
        if (result.sources.length === 0) {
          res.status(400).json({ error: 'Tidak ada sumber untuk disintesis ulang' });
          return;
        }

        // Fire-and-forget — client mendapat update via Socket.IO
        this.engine
          .regenerateReport(req.params.id)
          .then((r) => {
            if (r) console.log(`[Dashboard] Report regenerated: ${r.id}`);
          })
          .catch((err: Error) => {
            console.error('[Dashboard] Regenerate report error:', err);
          });

        res.status(202).json({ message: 'Report sedang dikalkulasi ulang' });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    });

    // ----- Halaman graph (visualisasi interconnected) -----
    this.app.get('/graph', async (_req, res) => {
      try {
        const graph = await this.engine.getGraph();
        renderWithLayout(res, 'graph', { graphJson: JSON.stringify(graph) });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).send(`Error: ${msg}`);
      }
    });

    // ----- API: List results -----
    this.app.get('/api/research', async (_req, res) => {
      try {
        const results = await this.engine.listResults(50);
        res.json(results);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    });

    // ----- API: Single result -----
    this.app.get('/api/research/:id', async (req, res) => {
      try {
        const result = await this.engine.getResult(req.params.id);
        if (!result) {
          res.status(404).json({ error: 'Not found' });
          return;
        }
        res.json(result);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    });

    // ----- API: Statistics -----
    this.app.get('/api/stats', async (_req, res) => {
      try {
        const allResults = await this.engine.listResults(100);
        const stats = computeStats(allResults);
        res.json(stats);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    });

    // ----- API: Research graph (nodes + edges) -----
    this.app.get('/api/graph', async (_req, res) => {
      try {
        const graph = await this.engine.getGraph();
        res.json(graph);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    });

    // ----- API: Children dari sebuah research -----
    this.app.get('/api/research/:id/children', async (req, res) => {
      try {
        const children = await this.engine.getSubResearch(req.params.id);
        res.json(children);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: msg });
      }
    });
  }

  /** Registrasi Socket.IO event handlers */
  private setupSocketEvents(): void {
    this.io.on('connection', (socket) => {
      console.log(`[Socket.IO] Client connected: ${socket.id}`);

      socket.on('research:subscribe', (data: { resultId: string }) => {
        if (data?.resultId) {
          socket.join(`research:${data.resultId}`);
        }
      });

      socket.on('disconnect', () => {
        console.log(`[Socket.IO] Client disconnected: ${socket.id}`);
      });
    });
  }

  /** Bridge event dari ResearchEngine → Socket.IO */
  private setupEngineListeners(): void {
    this.engine.on('started', (result: ResearchResult) => {
      this.io.emit('research:started', {
        resultId: result.id,
        topic: result.query.topic,
        parentId: result.parentId ?? null,
      });
    });

    this.engine.on('progress', (resultId: string, progress: ResearchProgress) => {
      this.io.to(`research:${resultId}`).emit('research:progress', { resultId, progress });
      this.io.emit('research:progress', { resultId, progress });
    });

    this.engine.on('complete', (result: ResearchResult) => {
      this.io.to(`research:${result.id}`).emit('research:complete', { resultId: result.id });
      this.io.emit('research:complete', { resultId: result.id });
    });

    this.engine.on('error', (resultId: string, errMsg: string) => {
      this.io.to(`research:${resultId}`).emit('research:error', { resultId, error: errMsg });
      this.io.emit('research:error', { resultId, error: errMsg });
    });

    // Report dikalkulasi ulang (setelah source dihapus) — UI reload
    this.engine.on('report:updated', (result: ResearchResult) => {
      this.io.to(`research:${result.id}`).emit('research:report-updated', { resultId: result.id });
      this.io.emit('research:report-updated', { resultId: result.id });
    });

    this.engine.on('report:error', (resultId: string, errMsg: string) => {
      this.io.to(`research:${resultId}`).emit('research:report-error', { resultId, error: errMsg });
      this.io.emit('research:report-error', { resultId, error: errMsg });
    });
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Start HTTP server */
  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, this.host, () => {
        console.log(`[Dashboard] Server running at http://${this.host}:${this.port}`);
        resolve();
      });
    });
  }

  /** Stop HTTP server */
  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.io.close();
      this.server.close((err) => {
        if (err) reject(err);
        else {
          console.log('[Dashboard] Server stopped');
          resolve();
        }
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
// Panggil setelah instance dibuat di app utama:
//   handleShutdown(server);
// Fungsi ini diexport untuk digunakan oleh entry point.

export function handleShutdown(server: DashboardServer): void {
  const shutdown = async (signal: string) => {
    console.log(`[Dashboard] Received ${signal}. Shutting down...`);
    await server.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
