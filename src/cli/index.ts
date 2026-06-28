#!/usr/bin/env node

/**
 * Research Agent — CLI Interface
 *
 * Command-line interface menggunakan commander, inquirer, chalk, dan ora.
 * Terintegrasi dengan ResearchEngine, ResearchScheduler, WebCollector, PDFCollector, DashboardServer.
 */

import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import dotenv from 'dotenv';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  ResearchQuery,
  ResearchConfig,
  ResearchDepth,
  ResearchProgress,
} from '../types/index.js';

import { ResearchEngine } from '../core/research-engine.js';
import { ResearchScheduler } from '../core/scheduler.js';
import { VectorDB } from '../storage/vector-db.js';
import { OpencodeSearchCollector } from '../collectors/opencode-search.js';
import { PDFCollector } from '../collectors/pdf-reader.js';
import { DashboardServer } from '../dashboard/server.js';
import { ReportExporter } from '../export/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_DIR = process.env.RESEARCH_DATA_DIR || path.resolve(process.cwd(), 'data');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(date: Date): string {
  return date.toLocaleString('id-ID', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function truncateId(id: string, len = 4): string {
  if (id.length <= len * 2 + 3) return id;
  return `${id.slice(0, len)}...${id.slice(-len)}`;
}

function formatProgress(progress: ResearchProgress): string {
  const phaseIcons: Record<string, string> = {
    searching: '\u{1F50D}',
    collecting: '\u{1F4E5}',
    processing: '\u{2699}\u{FE0F}',
    synthesizing: '\u{1F9E0}',
    done: '\u{2705}',
  };
  const icon = phaseIcons[progress.phase] ?? '\u{1F504}';
  return `${icon} ${progress.phase} (${progress.percent}%) \u2014 ${progress.message}`;
}

function statusBadge(status: string): string {
  switch (status) {
    case 'completed': return chalk.green('\u2713 completed');
    case 'running':   return chalk.cyan('\u25CC running');
    case 'queued':    return chalk.yellow('\u25CB queued');
    case 'failed':    return chalk.red('\u2717 failed');
    case 'cancelled': return chalk.gray('\u2212 cancelled');
    default:          return status;
  }
}

function depthLabel(depth?: string): string {
  switch (depth) {
    case 'quick':  return chalk.cyan('quick');
    case 'medium': return chalk.yellow('medium');
    case 'deep':   return chalk.red('deep');
    default:       return depth ?? '\u2014';
  }
}

function printResearchSummary(result: import('../types/index.js').ResearchResult): void {
  const W = 72;
  const report = result.report;

  console.log('\n' + chalk.bold.cyan('\u250c' + '\u2500'.repeat(W - 2) + '\u2510'));
  console.log(chalk.bold.cyan('\u2502') + chalk.bold('  RESEARCH SUMMARY').padEnd(W - 1) + chalk.bold.cyan('\u2502'));
  console.log(chalk.bold.cyan('\u251c' + '\u2500'.repeat(W - 2) + '\u2524'));

  // ID & Status row
  const statusStr = statusBadge(result.status);
  console.log(chalk.bold.cyan('\u2502') + `  ${chalk.bold('ID')}      ${chalk.cyan(truncateId(result.id))}${' '.repeat(Math.max(1, W - 12 - truncateId(result.id).length))}${statusStr}${' '.repeat(Math.max(1, W - 12 - truncateId(result.id).length - statusStr.length + 3))}${chalk.bold.cyan('\u2502')}`);

  console.log(chalk.bold.cyan('\u2502') + `  ${chalk.bold('Topic')}   ${chalk.white(result.query.topic)}${' '.repeat(Math.max(1, W - 12 - result.query.topic.length))}${chalk.bold.cyan('\u2502')}`);

  // Meta row: sources, depth, dates
  const metaParts = [
    `${chalk.bold('Src:')} ${result.sources.length}`,
    `${chalk.bold('Depth:')} ${depthLabel(result.query.depth)}`,
  ];
  if (result.version && result.version > 1) metaParts.push(`${chalk.bold('v')}${result.version}`);
  const metaStr = metaParts.join('  ');
  console.log(chalk.bold.cyan('\u2502') + `  ${metaStr}${' '.repeat(Math.max(1, W - 6 - metaStr.length))}${chalk.bold.cyan('\u2502')}`);

  if (result.parentId) {
    console.log(chalk.bold.cyan('\u2502') + `  ${chalk.bold('Sub of')} ${chalk.dim(truncateId(result.parentId))}${' '.repeat(Math.max(1, W - 12 - truncateId(result.parentId).length))}${chalk.bold.cyan('\u2502')}`);
  }
  if (result.tags?.length) {
    const tagsStr = result.tags.map(t => chalk.cyan(t)).join(', ');
    console.log(chalk.bold.cyan('\u2502') + `  ${chalk.bold('Tags')}   ${tagsStr}${' '.repeat(Math.max(1, W - 12 - tagsStr.length))}${chalk.bold.cyan('\u2502')}`);
  }

  // Dates
  if (result.startedAt || result.completedAt) {
    console.log(chalk.bold.cyan('\u2502') + `  ${chalk.dim(formatDate(result.startedAt || result.createdAt))}${result.completedAt ? chalk.dim(' \u2192 ' + formatDate(result.completedAt)) : ''}${' '.repeat(Math.max(1, W - 6))}${chalk.bold.cyan('\u2502')}`);
  }

  // Report section
  if (report) {
    console.log(chalk.bold.cyan('\u251c' + '\u2500'.repeat(W - 2) + '\u2524'));

    // Title
    const titleTrunc = report.title.length > W - 8 ? report.title.slice(0, W - 11) + '\u2026' : report.title;
    console.log(chalk.bold.cyan('\u2502') + `  ${chalk.bold(report.title)}${' '.repeat(Math.max(1, W - 6 - titleTrunc.length))}${chalk.bold.cyan('\u2502')}`);

    // Summary preview
    if (report.summary && report.summary.length > 0) {
      const summaryClean = report.summary.slice(0, W * 2).replace(/\s+/g, ' ').trim();
      const summaryLines = [];
      for (let i = 0; i < summaryClean.length; i += W - 6) {
        summaryLines.push(summaryClean.slice(i, i + W - 6));
      }
      summaryLines.slice(0, 3).forEach(line => {
        console.log(chalk.bold.cyan('\u2502') + `  ${chalk.dim(line)}${' '.repeat(Math.max(1, W - 6 - line.length))}${chalk.bold.cyan('\u2502')}`);
      });
      if (summaryClean.length > (W - 6) * 3) {
        console.log(chalk.bold.cyan('\u2502') + `  ${chalk.dim('\u2026'.padEnd(W - 8))}${chalk.bold.cyan('\u2502')}`);
      }
    }

    // Stats row
    const findingCount = report.keyFindings.length;
    const sectionCount = report.sections.length;
    const refCount = report.references.length;
    const findingColor = findingCount > 0 ? chalk.green : chalk.yellow;
    const statsStr = `${findingColor('\u25B6 ' + findingCount + ' Findings')}  ${chalk.blue('\u25B6 ' + sectionCount + ' Sections')}  ${chalk.magenta('\u25B6 ' + refCount + ' References')}`;
    console.log(chalk.bold.cyan('\u2502') + `  ${statsStr}${' '.repeat(Math.max(1, W - 8 - statsStr.length))}${chalk.bold.cyan('\u2502')}`);

    // Preview first few findings if available
    if (report.keyFindings.length > 0) {
      console.log(chalk.bold.cyan('\u2502') + `${' '.repeat(W - 2)}${chalk.bold.cyan('\u2502')}`);
      report.keyFindings.slice(0, Math.min(3, report.keyFindings.length)).forEach((f, i) => {
        const fTrunc = f.length > W - 12 ? f.slice(0, W - 15) + '\u2026' : f;
        console.log(chalk.bold.cyan('\u2502') + `     ${chalk.green((i + 1) + '.')} ${chalk.white(fTrunc)}${' '.repeat(Math.max(1, W - 10 - fTrunc.length))}${chalk.bold.cyan('\u2502')}`);
      });
      if (report.keyFindings.length > 3) {
        console.log(chalk.bold.cyan('\u2502') + `     ${chalk.dim('\u2026 and ' + (report.keyFindings.length - 3) + ' more')}${' '.repeat(Math.max(1, W - 10))}${chalk.bold.cyan('\u2502')}`);
      }
    }
  }

  console.log(chalk.bold.cyan('\u2514' + '\u2500'.repeat(W - 2) + '\u2518'));
  console.log(chalk.dim(`  research get ${truncateId(result.id)}  —  detail lengkap`));
  console.log();
}

// ---------------------------------------------------------------------------
// Factory Functions
// ---------------------------------------------------------------------------

async function createResearchEngine(): Promise<ResearchEngine> {
  const apiKey = process.env.OPENAI_API_KEY;
  const useOpenCode = !apiKey || process.env.USE_OPENCODE === 'true';

  const config: ResearchConfig = {
    openaiApiKey: apiKey || '',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    maxSources: parseInt(process.env.RESEARCH_MAX_SOURCES || '10', 10),
    depth: (process.env.RESEARCH_DEPTH as ResearchDepth) || 'medium',
    timeoutMs: parseInt(process.env.RESEARCH_TIMEOUT || '120000', 10),
    dataDir: DATA_DIR,
  };

  const storage = new VectorDB({
    dataDir: DATA_DIR,
    openaiApiKey: apiKey,
  });

  // Pilih LLM Provider: OpenCode SDK (default) > OpenAI
  let llm: import('../types/index.js').LLMProvider;

  if (useOpenCode) {
    const { OpenCodeProvider } = await import('../llm/opencode-provider.js');
    const provider = new OpenCodeProvider({ autoStart: true });
    await provider.initialize();
    llm = provider;
  } else {
    const { OpenAIProvider } = await import('../llm/llm-client.js');
    llm = new OpenAIProvider({
      apiKey: apiKey!,
      model: config.openaiModel,
      timeout: config.timeoutMs,
    });
  }

  const engine = new ResearchEngine(config, storage, llm);

  engine.registerCollector(new OpencodeSearchCollector({ autoStart: true }));
  engine.registerCollector(new PDFCollector());

  return engine;
}

async function createScheduler(engine: ResearchEngine): Promise<ResearchScheduler> {
  return new ResearchScheduler(engine);
}

// ---------------------------------------------------------------------------
// Command Handlers
// ---------------------------------------------------------------------------

async function handleResearchRun(
  topic: string,
  options: {
    depth?: string;
    sources?: string;
    questions?: string[];
    format?: string;
    watch?: boolean;
  },
): Promise<void> {
  const spinner = ora({
    text: chalk.cyan('Menyiapkan research engine...'),
    color: 'cyan',
  }).start();

  try {
    const engine = await createResearchEngine();
    const query: ResearchQuery = {
      topic,
      depth: (options.depth as ResearchDepth) || undefined,
      maxSources: options.sources ? parseInt(options.sources, 10) : undefined,
      questions: options.questions || undefined,
    };

    spinner.text = chalk.cyan('Menjalankan research...');

    if (options.watch) {
      engine.on('progress', (_resultId, progress) => {
        spinner.text = chalk.cyan(formatProgress(progress));
      });
    }

    const result = await engine.executeResearch(query);
    spinner.succeed(chalk.green('Research selesai!'));

    if (result.status === 'failed') {
      console.log(chalk.red(`\nStatus: ${result.error}`));
      return;
    }

    printResearchSummary(result);

    if (options.format) {
      await handleResearchExport(result.id, options.format, { output: undefined });
    }
  } catch (error) {
    spinner.fail(chalk.red('Research gagal'));
    throw error;
  }
}

async function handleResearchList(options: {
  limit?: string;
  offset?: string;
  status?: string;
}): Promise<void> {
  const engine = await createResearchEngine();
  const limit = options.limit ? parseInt(options.limit, 10) : 10;
  const offset = options.offset ? parseInt(options.offset, 10) : 0;

  const results = await engine.listResults(limit, offset);

  let filtered = results;
  if (options.status) {
    filtered = results.filter(r => r.status === options.status);
  }

  if (filtered.length === 0) {
    console.log(chalk.yellow('Tidak ada hasil research.'));
    return;
  }

  console.log(chalk.bold.cyan(`\n\u2550\u2550\u2550 Research Results (${filtered.length}) \u2550\u2550\u2550\n`));

  const rows = filtered.map(r => [
    truncateId(r.id),
    r.query.topic.length > 30 ? r.query.topic.slice(0, 30) + '\u2026' : r.query.topic,
    statusBadge(r.status),
    String(r.sources.length),
    formatDate(r.createdAt),
  ]);

  const colWidths = rows.reduce(
    (max, row) => row.map((cell, i) => Math.max(max[i] || 0, cell.length)),
    [4, 5, 6, 7, 4],
  );

  const pad = (str: string, width: number) => str.padEnd(width);

  console.log(' ' + ['ID', 'Topic', 'Status', 'Src', 'Date'].map((h, i) => pad(h, colWidths[i] + 2)).join(''));
  console.log(' ' + colWidths.map(w => '\u2500'.repeat(w + 2)).join(''));

  for (const row of rows) {
    console.log(' ' + row.map((cell, i) => pad(cell, colWidths[i] + 2)).join(''));
  }

  console.log(chalk.dim(`\nPage: offset=${offset} limit=${limit} total=${filtered.length}`));
}

async function handleResearchGet(
  id: string,
  options: { full?: boolean; sources?: boolean },
): Promise<void> {
  const engine = await createResearchEngine();

  const result = await engine.getResult(id);
  if (!result) {
    console.log(chalk.red(`Research dengan ID "${id}" tidak ditemukan.`));
    process.exit(1);
  }

  const W = 72;

  // ── HEADER ──
  console.log();
  console.log(chalk.bold.cyan('\u250c' + '\u2500'.repeat(W - 2) + '\u2510'));
  console.log(chalk.bold.cyan('\u2502') + chalk.bold('  RESEARCH DETAIL').padEnd(W - 1) + chalk.bold.cyan('\u2502'));
  console.log(chalk.bold.cyan('\u251c' + '\u2500'.repeat(W - 2) + '\u2524'));

  // Meta info
  const metaLines = [
    [chalk.bold('ID'), result.id],
    [chalk.bold('Topic'), result.query.topic],
    [chalk.bold('Status'), statusBadge(result.status)],
    [chalk.bold('Depth'), depthLabel(result.query.depth)],
    [chalk.bold('Max Sources'), String(result.query.maxSources ?? '\u2014')],
    [chalk.bold('Sources collected'), String(result.sources.length)],
    [chalk.bold('Started'), result.startedAt ? formatDate(result.startedAt) : '\u2014'],
    [chalk.bold('Completed'), result.completedAt ? formatDate(result.completedAt) : '\u2014'],
    [chalk.bold('Created'), formatDate(result.createdAt)],
  ];

  if (result.version && result.version > 1) metaLines.push([chalk.bold('Version'), String(result.version)]);
  if (result.parentId) metaLines.push([chalk.bold('Parent'), truncateId(result.parentId)]);
  if (result.tags?.length) metaLines.push([chalk.bold('Tags'), result.tags.join(', ')]);

  metaLines.forEach(([label, value]) => {
    const line = `  ${label}: ${value}`;
    const display = typeof value === 'string' ? value : String(value);
    const cleanLen = line.length; // approximate
    console.log(chalk.bold.cyan('\u2502') + `  ${label}: ${chalk.white(display)}${' '.repeat(Math.max(1, W - 6 - cleanLen))}${chalk.bold.cyan('\u2502')}`);
  });

  // Questions
  if (result.query.questions && result.query.questions.length > 0) {
    console.log(chalk.bold.cyan('\u2502') + ' '.repeat(W - 2) + chalk.bold.cyan('\u2502'));
    result.query.questions.forEach(q => {
      const qTrunc = q.length > W - 12 ? q.slice(0, W - 15) + '\u2026' : q;
      console.log(chalk.bold.cyan('\u2502') + `  ${chalk.bold('Q:')} ${chalk.yellow(qTrunc)}${' '.repeat(Math.max(1, W - 8 - qTrunc.length))}${chalk.bold.cyan('\u2502')}`);
    });
  }

  if (result.error) {
    console.log(chalk.bold.cyan('\u2502') + ' '.repeat(W - 2) + chalk.bold.cyan('\u2502'));
    console.log(chalk.bold.cyan('\u2502') + `  ${chalk.bold.red('ERROR:')} ${chalk.red(result.error)}${' '.repeat(Math.max(1, W - 10 - result.error.length))}${chalk.bold.cyan('\u2502')}`);
  }

  // ── REPORT ──
  const report = result.report;
  if (report) {
    console.log(chalk.bold.cyan('\u251c' + '\u2500'.repeat(W - 2) + '\u2524'));

    // Title
    const tTrunc = report.title.length > W - 8 ? report.title.slice(0, W - 11) + '\u2026' : report.title;
    console.log(chalk.bold.cyan('\u2502') + `  ${chalk.bold(report.title)}${' '.repeat(Math.max(1, W - 6 - tTrunc.length))}${chalk.bold.cyan('\u2502')}`);

    // Summary
    console.log(chalk.bold.cyan('\u2502') + ' '.repeat(W - 2) + chalk.bold.cyan('\u2502'));
    console.log(chalk.bold.cyan('\u2502') + `  ${chalk.bold('SUMMARY')}`.padEnd(W - 1) + chalk.bold.cyan('\u2502'));
    const summaryClean = report.summary.replace(/\s+/g, ' ').trim();
    if (summaryClean) {
      const words = summaryClean.split(' ');
      let line = '';
      words.forEach(word => {
        if ((line + ' ' + word).length > W - 8) {
          console.log(chalk.bold.cyan('\u2502') + `  ${chalk.white(line)}${' '.repeat(Math.max(1, W - 6 - line.length))}${chalk.bold.cyan('\u2502')}`);
          line = word;
        } else {
          line = line ? line + ' ' + word : word;
        }
      });
      if (line) {
        console.log(chalk.bold.cyan('\u2502') + `  ${chalk.white(line)}${' '.repeat(Math.max(1, W - 6 - line.length))}${chalk.bold.cyan('\u2502')}`);
      }
    }

    // ── Key Findings ──
    if (report.keyFindings.length > 0) {
      console.log(chalk.bold.cyan('\u2502') + ' '.repeat(W - 2) + chalk.bold.cyan('\u2502'));
      console.log(chalk.bold.cyan('\u2502') + `  ${chalk.bold.green(`KEY FINDINGS (${report.keyFindings.length})`)}`.padEnd(W - 1) + chalk.bold.cyan('\u2502'));
      report.keyFindings.forEach((f, i) => {
        const wrapped = [];
        const words = f.split(' ');
        let line = '';
        words.forEach(word => {
          if ((line + ' ' + word).length > W - 14) {
            wrapped.push(line);
            line = word;
          } else {
            line = line ? line + ' ' + word : word;
          }
        });
        if (line) wrapped.push(line);
        wrapped.forEach((wl, wi) => {
          const prefix = wi === 0 ? chalk.green(`${String(i + 1).padStart(2, '0')}.`) : '   ';
          console.log(chalk.bold.cyan('\u2502') + `     ${prefix} ${chalk.white(wl)}${' '.repeat(Math.max(1, W - 12 - wl.length))}${chalk.bold.cyan('\u2502')}`);
        });
      });
    }

    // ── Sections ──
    if (options.full && report.sections.length > 0) {
      console.log(chalk.bold.cyan('\u2502') + ' '.repeat(W - 2) + chalk.bold.cyan('\u2502'));
      console.log(chalk.bold.cyan('\u2502') + `  ${chalk.bold.blue(`SECTIONS (${report.sections.length})`)}`.padEnd(W - 1) + chalk.bold.cyan('\u2502'));
      report.sections.forEach((section, si) => {
        console.log(chalk.bold.cyan('\u2502') + ' '.repeat(W - 2) + chalk.bold.cyan('\u2502'));
        console.log(chalk.bold.cyan('\u2502') + `  ${chalk.bold.cyan(`${String(si + 1)}. ${section.heading}`)}`.padEnd(W - 1) + chalk.bold.cyan('\u2502'));
        const contentClean = section.content.replace(/\s+/g, ' ').trim();
        const words = contentClean.split(' ');
        let line = '';
        words.forEach(word => {
          if ((line + ' ' + word).length > W - 8) {
            console.log(chalk.bold.cyan('\u2502') + `  ${chalk.white(line)}${' '.repeat(Math.max(1, W - 6 - line.length))}${chalk.bold.cyan('\u2502')}`);
            line = word;
          } else {
            line = line ? line + ' ' + word : word;
          }
        });
        if (line) {
          console.log(chalk.bold.cyan('\u2502') + `  ${chalk.white(line)}${' '.repeat(Math.max(1, W - 6 - line.length))}${chalk.bold.cyan('\u2502')}`);
        }
        if (section.subsections) {
          section.subsections.forEach(sub => {
            console.log(chalk.bold.cyan('\u2502') + `    ${chalk.italic(sub.heading)}`.padEnd(W - 1) + chalk.bold.cyan('\u2502'));
            const subClean = sub.content.replace(/\s+/g, ' ').trim();
            const subWords = subClean.split(' ');
            let sLine = '';
            subWords.forEach(word => {
              if ((sLine + ' ' + word).length > W - 10) {
                console.log(chalk.bold.cyan('\u2502') + `    ${chalk.dim(sLine)}${' '.repeat(Math.max(1, W - 8 - sLine.length))}${chalk.bold.cyan('\u2502')}`);
                sLine = word;
              } else {
                sLine = sLine ? sLine + ' ' + word : word;
              }
            });
            if (sLine) {
              console.log(chalk.bold.cyan('\u2502') + `    ${chalk.dim(sLine)}${' '.repeat(Math.max(1, W - 8 - sLine.length))}${chalk.bold.cyan('\u2502')}`);
            }
          });
        }
      });
    } else if (report.sections.length > 0) {
      console.log(chalk.bold.cyan('\u2502') + ' '.repeat(W - 2) + chalk.bold.cyan('\u2502'));
      const sectionNames = report.sections.map((s, i) => `${i + 1}. ${s.heading}`);
      sectionNames.forEach(sn => {
        const snTrunc = sn.length > W - 10 ? sn.slice(0, W - 13) + '\u2026' : sn;
        console.log(chalk.bold.cyan('\u2502') + `  ${chalk.blue('\u25B6')} ${chalk.white(snTrunc)}${' '.repeat(Math.max(1, W - 8 - snTrunc.length))}${chalk.bold.cyan('\u2502')}`);
      });
    }

    // ── Conclusions ──
    if (report.conclusions.length > 0) {
      console.log(chalk.bold.cyan('\u2502') + ' '.repeat(W - 2) + chalk.bold.cyan('\u2502'));
      console.log(chalk.bold.cyan('\u2502') + `  ${chalk.bold.magenta(`CONCLUSIONS (${report.conclusions.length})`)}`.padEnd(W - 1) + chalk.bold.cyan('\u2502'));
      report.conclusions.forEach((c, i) => {
        const cTrunc = c.length > W - 14 ? c.slice(0, W - 17) + '\u2026' : c;
        console.log(chalk.bold.cyan('\u2502') + `    ${chalk.magenta(`${String(i + 1)}.`)} ${chalk.white(cTrunc)}${' '.repeat(Math.max(1, W - 12 - cTrunc.length))}${chalk.bold.cyan('\u2502')}`);
      });
    }

    // ── References ──
    if (report.references.length > 0) {
      console.log(chalk.bold.cyan('\u2502') + ' '.repeat(W - 2) + chalk.bold.cyan('\u2502'));
      console.log(chalk.bold.cyan('\u2502') + `  ${chalk.bold.dim(`REFERENCES (${report.references.length})`)}`.padEnd(W - 1) + chalk.bold.cyan('\u2502'));
      report.references.forEach((ref, i) => {
        const refTrunc = ref.length > W - 14 ? ref.slice(0, W - 17) + '\u2026' : ref;
        console.log(chalk.bold.cyan('\u2502') + `    ${chalk.dim(String(i + 1))}. ${chalk.dim(refTrunc)}${' '.repeat(Math.max(1, W - 12 - refTrunc.length))}${chalk.bold.cyan('\u2502')}`);
      });
    }
  }

  console.log(chalk.bold.cyan('\u2514' + '\u2500'.repeat(W - 2) + '\u2518'));
  console.log();
}

async function handleResearchSearch(query: string): Promise<void> {
  const spinner = ora({
    text: chalk.cyan('Mencari hasil research...'),
    color: 'cyan',
  }).start();

  try {
    const engine = await createResearchEngine();
    const results = await engine.searchResults(query);
    spinner.succeed(chalk.green(`Ditemukan ${results.length} hasil`));

    if (results.length === 0) {
      console.log(chalk.yellow('Tidak ada hasil yang cocok.'));
      return;
    }

    console.log(chalk.bold.cyan(`\n\u2550\u2550\u2550 Search Results: "${query}" \u2550\u2550\u2550\n`));

    for (const result of results) {
      const score = result.sources.reduce((max, s) => Math.max(max, s.relevanceScore ?? 0), 0);
      const bar = chalk.green('\u2588'.repeat(Math.round(score * 10))) +
        chalk.gray('\u2591'.repeat(10 - Math.round(score * 10)));
      console.log(`${chalk.bold(truncateId(result.id))} ${bar} ${(score * 100).toFixed(0)}%`);
      console.log(`  ${chalk.bold('Topic:')} ${result.query.topic}`);
      console.log(`  ${chalk.bold('Status:')} ${statusBadge(result.status)}`);
      console.log(`  ${chalk.bold('Sources:')} ${result.sources.length}`);
      console.log('');
    }
  } catch (error) {
    spinner.fail(chalk.red('Pencarian gagal'));
    throw error;
  }
}

async function handleResearchDelete(id: string): Promise<void> {
  const engine = await createResearchEngine();

  const result = await engine.getResult(id);
  if (!result) {
    console.log(chalk.red(`Research dengan ID "${id}" tidak ditemukan.`));
    process.exit(1);
  }

  console.log(chalk.yellow(`Anda akan menghapus research:`));
  console.log(`  ID:    ${result.id}`);
  console.log(`  Topic: ${result.query.topic}`);
  console.log(`  Date:  ${formatDate(result.createdAt)}`);

  const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Yakin ingin menghapus?',
      default: false,
    },
  ]);

  if (!confirm) {
    console.log(chalk.yellow('Dibatalkan.'));
    return;
  }

  const spinner = ora('Menghapus...').start();
  try {
    await engine.deleteResult(id);
    spinner.succeed(chalk.green(`Research "${truncateId(id)}" berhasil dihapus.`));
  } catch (error) {
    spinner.fail(chalk.red('Gagal menghapus'));
    throw error;
  }
}

async function handleResearchExport(
  id: string,
  format = 'markdown',
  options: { output?: string },
): Promise<void> {
  const engine = await createResearchEngine();

  const result = await engine.getResult(id);
  if (!result) {
    console.log(chalk.red(`Research dengan ID "${id}" tidak ditemukan.`));
    process.exit(1);
  }

  if (!result.report) {
    console.log(chalk.red('Tidak ada report untuk hasil research ini.'));
    process.exit(1);
  }

  const validFormats = ['markdown', 'json', 'html'] as const;
  const fmt = validFormats.includes(format as typeof validFormats[number])
    ? (format as typeof validFormats[number])
    : 'markdown' as const;

  const extMap: Record<string, string> = { markdown: '.md', json: '.json', html: '.html' };
  let outputPath = options.output;
  if (!outputPath) {
    const safeName = result.query.topic.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
    outputPath = path.join(DATA_DIR, `export-${safeName}-${Date.now()}${extMap[fmt]}`);
  }

  const spinner = ora(`Exporting to ${fmt}...`).start();

  try {
    const exporter = new ReportExporter(DATA_DIR);
    const exportResult = await exporter.export(result, { format: fmt, includeSources: true, includeMetadata: true });
    await writeFile(outputPath, exportResult.content, 'utf-8');
    spinner.succeed(chalk.green(`Report diexport ke: ${outputPath}`));
  } catch (error) {
    spinner.fail(chalk.red('Export gagal'));
    throw error;
  }
}

async function handleResearchRerun(
  id: string,
  options: { depth?: string; sources?: string; questions?: string[] },
): Promise<void> {
  const engine = await createResearchEngine();
  const spinner = ora('Mererun research...').start();

  try {
    const overrides: Partial<ResearchQuery> = {};
    if (options.depth) overrides.depth = options.depth as ResearchDepth;
    if (options.sources) overrides.maxSources = parseInt(options.sources, 10);
    if (options.questions?.length) overrides.questions = options.questions;

    const result = await engine.rerunResearch(id, overrides);
    if (!result) {
      spinner.fail(chalk.red(`Research dengan ID "${id}" tidak ditemukan.`));
      return;
    }

    spinner.succeed(chalk.green('Research selesai!'));
    printResearchSummary(result);
  } catch (error) {
    spinner.fail(chalk.red('Rerun gagal'));
    throw error;
  }
}

async function handleResearchEdit(
  id: string,
  options: { title?: string; summary?: string; findings?: string[]; conclusions?: string[]; tags?: string[] },
): Promise<void> {
  const engine = await createResearchEngine();
  const spinner = ora('Mengupdate research...').start();

  try {
    const existing = await engine.getResult(id);
    if (!existing) {
      spinner.fail(chalk.red(`Research dengan ID "${id}" tidak ditemukan.`));
      return;
    }

    const existingReport = existing.report;
    const reportUpdates: Partial<import('../types/index.js').ResearchReport> = {};
    if (options.title) reportUpdates.title = options.title;
    if (options.summary) reportUpdates.summary = options.summary;
    if (options.findings?.length) reportUpdates.keyFindings = options.findings;
    if (options.conclusions?.length) reportUpdates.conclusions = options.conclusions;

    // Merge dengan report yang sudah ada
    const mergedReport = existingReport
      ? { ...existingReport, ...reportUpdates }
      : undefined;

    const updates: { report?: import('../types/index.js').ResearchReport; tags?: string[] } = {};
    if (mergedReport) updates.report = mergedReport as import('../types/index.js').ResearchReport;
    if (options.tags?.length) updates.tags = options.tags;

    const result = await engine.updateResult(id, updates);
    if (!result) {
      spinner.fail(chalk.red('Gagal mengupdate research.'));
      return;
    }

    spinner.succeed(chalk.green('Research berhasil diupdate!'));
    printResearchSummary(result);
  } catch (error) {
    spinner.fail(chalk.red('Update gagal'));
    throw error;
  }
}

async function handleResearchSub(
  parentId: string,
  topic: string,
  options: { depth?: string; sources?: string; questions?: string[] },
): Promise<void> {
  const engine = await createResearchEngine();
  const spinner = ora(`Menjalankan sub-research: "${topic}"...`).start();

  try {
    const query: ResearchQuery = {
      topic,
      depth: options.depth as ResearchDepth,
      maxSources: options.sources ? parseInt(options.sources, 10) : undefined,
      questions: options.questions?.length ? options.questions : undefined,
    };

    const result = await engine.addSubResearch(parentId, query);
    if (!result) {
      spinner.fail(chalk.red(`Parent research dengan ID "${parentId}" tidak ditemukan.`));
      return;
    }

    spinner.succeed(chalk.green('Sub-research selesai!'));
    printResearchSummary(result);

    // Tampilkan parent info
    const parent = await engine.getResult(parentId);
    if (parent) {
      console.log(chalk.dim(`  Parent: ${parent.query.topic} (${parentId.slice(0, 8)}...)`));
    }
  } catch (error) {
    spinner.fail(chalk.red('Sub-research gagal'));
    throw error;
  }
}

async function handleScheduleAdd(
  name: string,
  cronExpr: string,
  topic: string,
  options: { depth?: string; sources?: string },
): Promise<void> {
  const engine = await createResearchEngine();
  const scheduler = await createScheduler(engine);

  const query: ResearchQuery = {
    topic,
    depth: (options.depth as ResearchDepth) || undefined,
    maxSources: options.sources ? parseInt(options.sources, 10) : undefined,
  };

  try {
    const task = await scheduler.addTask(name, query, cronExpr);
    console.log(chalk.green(`Task "${name}" berhasil ditambahkan.`));
    console.log(`  ID:    ${task.id}`);
    console.log(`  Cron:  ${cronExpr}`);
    console.log(`  Topic: ${topic}`);
  } catch (error) {
    console.log(chalk.red(`Gagal menambahkan task: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

async function handleScheduleList(): Promise<void> {
  const engine = await createResearchEngine();
  const scheduler = await createScheduler(engine);
  const tasks = await scheduler.listTasks();

  if (tasks.length === 0) {
    console.log(chalk.yellow('Tidak ada scheduled task.'));
    return;
  }

  console.log(chalk.bold.cyan(`\n\u2550\u2550\u2550 Scheduled Tasks (${tasks.length}) \u2550\u2550\u2550\n`));

  const rows = tasks.map(t => [
    truncateId(t.id),
    t.name.length > 15 ? t.name.slice(0, 15) + '\u2026' : t.name,
    t.cronExpression,
    t.query.topic.length > 20 ? t.query.topic.slice(0, 20) + '\u2026' : t.query.topic,
    t.enabled ? chalk.green('\u2713') : chalk.red('\u2717'),
    t.lastRunAt ? formatDate(t.lastRunAt) : '\u2014',
  ]);

  const colWidths = rows.reduce(
    (max, row) => row.map((cell, i) => Math.max(max[i] || 0, cell.length)),
    [4, 5, 5, 6, 7, 9],
  );

  const pad = (str: string, width: number) => str.padEnd(width);

  console.log(' ' + ['ID', 'Name', 'Cron', 'Topic', 'Active', 'Last Run'].map((h, i) => pad(h, colWidths[i] + 2)).join(''));
  console.log(' ' + colWidths.map(w => '\u2500'.repeat(w + 2)).join(''));

  for (const row of rows) {
    console.log(' ' + row.map((cell, i) => pad(cell, colWidths[i] + 2)).join(''));
  }
}

async function handleScheduleRemove(id: string): Promise<void> {
  const engine = await createResearchEngine();
  const scheduler = await createScheduler(engine);

  const task = await scheduler.getTask(id);
  if (!task) {
    console.log(chalk.red(`Task dengan ID "${id}" tidak ditemukan.`));
    process.exit(1);
  }

  console.log(chalk.yellow(`Menghapus task:`));
  console.log(`  Name:  ${task.name}`);
  console.log(`  Topic: ${task.query.topic}`);

  const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Yakin ingin menghapus task ini?',
      default: false,
    },
  ]);

  if (!confirm) {
    console.log(chalk.yellow('Dibatalkan.'));
    return;
  }

  await scheduler.removeTask(id);
  console.log(chalk.green(`Task berhasil dihapus.`));
}

async function handleScheduleRun(id: string): Promise<void> {
  const engine = await createResearchEngine();
  const scheduler = await createScheduler(engine);

  const task = await scheduler.getTask(id);
  if (!task) {
    console.log(chalk.red(`Task dengan ID "${id}" tidak ditemukan.`));
    process.exit(1);
  }

  console.log(chalk.cyan(`Menjalankan task "${task.name}"...`));
  await scheduler.runNow(id);
  console.log(chalk.green(`Task "${task.name}" selesai.`));
}

async function handleDashboard(): Promise<void> {
  try {
    const engine = await createResearchEngine();
    const port = parseInt(process.env.DASHBOARD_PORT || '3000', 10);
    const host = process.env.DASHBOARD_HOST || 'localhost';
    const server = new DashboardServer(engine, port, host);
    await server.start();
  } catch (error) {
    console.log(chalk.red('Dashboard gagal dijalankan:'));
    console.log(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

async function handleConfig(): Promise<void> {
  const config = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ? chalk.green('\u2713 configured') : chalk.red('\u2717 not set'),
    OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    SERPAPI_KEY: process.env.SERPAPI_KEY ? chalk.green('\u2713 configured') : chalk.yellow('\u25CB optional'),
    RESEARCH_DATA_DIR: DATA_DIR,
    RESEARCH_MAX_SOURCES: process.env.RESEARCH_MAX_SOURCES || '10',
    RESEARCH_DEPTH: process.env.RESEARCH_DEPTH || 'medium',
    RESEARCH_TIMEOUT: process.env.RESEARCH_TIMEOUT || '120000',
  };

  console.log(chalk.bold.cyan('\n\u2550\u2550\u2550 Research Agent Configuration \u2550\u2550\u2550\n'));

  const entries = Object.entries(config);
  const keyWidth = Math.max(...entries.map(([k]) => k.length));

  for (const [key, value] of entries) {
    console.log(`  ${chalk.bold(key.padEnd(keyWidth))}  ${value}`);
  }

  console.log('');
}

// ---------------------------------------------------------------------------
// Program Setup
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('research')
  .description(chalk.cyan('Multi-Platform AI Research Agent \u2014 CLI'))
  .version('0.1.0');

// ── research commands ──────────────────────────────────────────────────

const research = program.command('research').description('Kelola hasil research');

research
  .command('run')
  .description('Jalankan research untuk topic tertentu')
  .argument('<topic>', 'Topik yang ingin diteliti')
  .option('-d, --depth <d>', 'Kedalaman riset: quick, medium, deep')
  .option('-s, --sources <n>', 'Jumlah maksimal sumber')
  .option('-q, --questions <q...>', 'Pertanyaan spesifik')
  .option('-f, --format <f>', 'Format output: markdown, json, html')
  .option('-w, --watch', 'Tampilkan live progress update')
  .action(async (topic, options) => {
    try {
      await handleResearchRun(topic, options);
    } catch (error) {
      console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

research
  .command('list')
  .description('List semua hasil research')
  .option('-l, --limit <n>', 'Jumlah hasil per halaman')
  .option('-o, --offset <n>', 'Offset halaman')
  .option('-s, --status <s>', 'Filter berdasarkan status')
  .action(async (options) => {
    try {
      await handleResearchList(options);
    } catch (error) {
      console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

research
  .command('get')
  .description('Lihat detail hasil research')
  .argument('<id>', 'ID hasil research')
  .option('--full', 'Tampilkan report lengkap')
  .option('--sources', 'Tampilkan daftar sumber')
  .action(async (id, options) => {
    try {
      await handleResearchGet(id, options);
    } catch (error) {
      console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

research
  .command('search')
  .description('Cari hasil research dengan semantic search')
  .argument('<query>', 'Query pencarian')
  .action(async (query) => {
    try {
      await handleResearchSearch(query);
    } catch (error) {
      console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

research
  .command('delete')
  .description('Hapus hasil research')
  .argument('<id>', 'ID hasil research')
  .action(async (id) => {
    try {
      await handleResearchDelete(id);
    } catch (error) {
      console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

research
  .command('export')
  .description('Export report ke file')
  .argument('<id>', 'ID hasil research')
  .argument('[format]', 'Format export: markdown, json, html')
  .option('-o, --output <path>', 'Custom output path')
  .action(async (id, format, options) => {
    try {
      await handleResearchExport(id, format, options);
    } catch (error) {
      console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

research
  .command('rerun')
  .description('Jalankan ulang research (versi baru)')
  .argument('<id>', 'ID hasil research')
  .option('-d, --depth <d>', 'Kedalaman riset: quick, medium, deep')
  .option('-s, --sources <n>', 'Jumlah maksimal sumber')
  .option('-q, --questions <q...>', 'Pertanyaan spesifik')
  .action(async (id, options) => {
    try {
      await handleResearchRerun(id, options);
    } catch (error) {
      console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

research
  .command('edit')
  .description('Edit report hasil research (summary, findings, conclusions)')
  .argument('<id>', 'ID hasil research')
  .option('--title <title>', 'Judul baru')
  .option('--summary <text>', 'Ringkasan baru')
  .option('--findings <items...>', 'Temuan kunci (pisah dengan spasi)')
  .option('--conclusions <items...>', 'Kesimpulan baru')
  .option('--tags <tags...>', 'Tag baru')
  .action(async (id, options) => {
    try {
      await handleResearchEdit(id, options);
    } catch (error) {
      console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

research
  .command('sub')
  .description('Tambah sub-research (cabang) dari hasil yang sudah ada')
  .argument('<parentId>', 'ID parent research')
  .argument('<topic>', 'Topik sub-research')
  .option('-d, --depth <d>', 'Kedalaman riset')
  .option('-s, --sources <n>', 'Jumlah maksimal sumber')
  .option('-q, --questions <q...>', 'Pertanyaan spesifik')
  .action(async (parentId, topic, options) => {
    try {
      await handleResearchSub(parentId, topic, options);
    } catch (error) {
      console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

// ── schedule commands ──────────────────────────────────────────────────

const schedule = program.command('schedule').description('Kelola scheduled task');

schedule
  .command('add')
  .description('Tambah scheduled task baru')
  .argument('<name>', 'Nama task')
  .argument('<cron>', 'Cron expression (5-field)')
  .argument('<topic>', 'Topik research')
  .option('-d, --depth <d>', 'Kedalaman riset')
  .option('-s, --sources <n>', 'Jumlah maksimal sumber')
  .action(async (name, cronExpr, topic, options) => {
    try {
      await handleScheduleAdd(name, cronExpr, topic, options);
    } catch (error) {
      console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

schedule
  .command('list')
  .description('List semua scheduled task')
  .action(async () => {
    try {
      await handleScheduleList();
    } catch (error) {
      console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

schedule
  .command('remove')
  .description('Hapus scheduled task')
  .argument('<id>', 'ID task')
  .action(async (id) => {
    try {
      await handleScheduleRemove(id);
    } catch (error) {
      console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

schedule
  .command('run')
  .description('Jalankan scheduled task sekali sekarang')
  .argument('<id>', 'ID task')
  .action(async (id) => {
    try {
      await handleScheduleRun(id);
    } catch (error) {
      console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

// ── top-level commands ─────────────────────────────────────────────────

program
  .command('dashboard')
  .description('Jalankan web dashboard')
  .action(async () => {
    try {
      await handleDashboard();
    } catch (error) {
      console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

program
  .command('config')
  .description('Tampilkan konfigurasi saat ini')
  .action(async () => {
    try {
      await handleConfig();
    } catch (error) {
      console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

// ── fallback ───────────────────────────────────────────────────────────

program.on('command:*', () => {
  console.error(chalk.red(`Perintah tidak dikenal: ${program.args.join(' ')}`));
  console.log('');
  program.help();
});

// ---------------------------------------------------------------------------
// Error Handling
// ---------------------------------------------------------------------------

process.on('uncaughtException', (error) => {
  console.error(chalk.red('\n\u26D4 Uncaught Exception:'));
  console.error(chalk.red(error.stack || error.message));
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error(chalk.red('\n\u26D4 Unhandled Rejection:'));
  console.error(chalk.red(reason instanceof Error ? reason.stack : String(reason)));
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log(chalk.yellow('\n\u23F9 Dibatalkan oleh user.'));
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log(chalk.yellow('\n\u23F9 Dihentikan.'));
  process.exit(0);
});

// ---------------------------------------------------------------------------
// Main Entry
// ---------------------------------------------------------------------------

const isMainModule =
  process.argv[1]?.endsWith('cli/index.ts') ||
  process.argv[1]?.endsWith('cli/index.js');

if (isMainModule) {
  dotenv.config();

  if (!process.env.OPENAI_API_KEY) {
    console.warn(chalk.yellow('\u26A0\uFE0F  OPENAI_API_KEY tidak ditemukan.'));
    console.warn(chalk.dim('   Buat file .env atau set environment variable.'));
    console.warn(chalk.dim('   Contoh: OPENAI_API_KEY=sk-... research run "topic"'));
    console.warn('');
  }

  program.parseAsync(process.argv).catch((error) => {
    console.error(chalk.red(`\nFatal: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  });
}

export { program };
