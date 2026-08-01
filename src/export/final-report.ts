/**
 * Final Report — laporan gabungan satu pohon riset (riset induk + semua
 * sub-query) dalam satu dokumen Markdown.
 *
 * @module export/final-report
 */

import type { ResearchResult } from '../types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Bersihkan teks dari konten scraped (untrusted): blok style/script dan
 * raw HTML tags. Markdown link absolut ([teks](https://...)) tetap utuh.
 */
function cleanText(text: string): string {
  return text
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\[([^\]]*)\]\(\/(?!\/)[^)\s]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .trim();
}

function statusLabel(status: string): string {
  switch (status) {
    case 'completed': return 'Selesai';
    case 'running': return 'Sedang berjalan';
    case 'queued': return 'Antrian';
    case 'failed': return 'Gagal';
    case 'cancelled': return 'Dibatalkan';
    default: return status;
  }
}

function formatDate(date: Date | undefined): string {
  if (!date) return '-';
  try {
    return date.toLocaleString('id-ID', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '-';
  }
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Bangun markdown Final Report gabungan.
 *
 * @param root - Riset induk (puncak pohon)
 * @param tree - Seluruh pohon: index 0 = root, sisanya descendant
 *               (parent selalu muncul sebelum child-nya)
 */
export function buildFinalReportMarkdown(root: ResearchResult, tree: ResearchResult[]): string {
  const parts: string[] = [];
  const totalSources = tree.reduce((sum, r) => sum + r.sources.length, 0);
  const completedCount = tree.filter((r) => r.status === 'completed').length;
  // Depth tiap node: parent selalu muncul sebelum child di tree (BFS)
  const depths = computeDepths(tree);

  // ── Header ────────────────────────────────────────────────────────────
  parts.push(`# Final Report: ${root.query.topic}`);
  parts.push('');
  parts.push(
    `> ${tree.length} riset dalam 1 pohon · ${completedCount} selesai · ` +
    `${totalSources} total sumber · dibuat ${formatDate(root.createdAt)}`,
  );
  parts.push('');

  // ── Tiap riset dalam pohon ────────────────────────────────────────────
  tree.forEach((result, index) => {
    const depth = depths.get(result.id) ?? 0; // 0 = root
    const blockLevel = Math.min(depth + 2, 6); // root → ##, child → ###, dst.
    const blockHeading = '#'.repeat(blockLevel);

    const roleLabel =
      depth === 0
        ? 'riset induk'
        : depth === 1
          ? 'sub-query'
          : 'sub-query (level ' + depth + ')';

    const header =
      `${blockHeading} ${index + 1}. ${result.query.topic} ` +
      `*(~{roleLabel}~)*`.replace('~{roleLabel}~', roleLabel);

    parts.push(header);
    parts.push('');

    // Metadata
    const metaBits = [
      `**Status:** ${statusLabel(result.status)}`,
      `**Sumber:** ${result.sources.length}`,
      `**Depth:** ${result.query.depth ?? '-'}`,
      `**Dibuat:** ${formatDate(result.createdAt)}`,
    ];
    if (result.completedAt) metaBits.push(`**Selesai:** ${formatDate(result.completedAt)}`);
    if (result.parentId && depth > 0) {
      const parent = tree.find((r) => r.id === result.parentId);
      metaBits.push(`**Parent:** ${parent?.query.topic ?? result.parentId.slice(0, 8)}`);
    }
    parts.push(metaBits.join(' · '));
    parts.push('');

    // Konten report
    const report = result.report;
    const subLevel = blockLevel + 1;

    if (!report) {
      if (result.error) {
        parts.push(`_Belum ada report — ${statusLabel(result.status)}: ${cleanText(result.error)}_`);
      } else {
        parts.push(`_Belum ada report — status: ${statusLabel(result.status)}._`);
      }
      parts.push('');
      parts.push('---');
      parts.push('');
      return;
    }

    // Ringkasan
    if (report.summary) {
      parts.push(`${'#'.repeat(subLevel)} Ringkasan`);
      parts.push('');
      parts.push(cleanText(report.summary));
      parts.push('');
    }

    // Temuan Kunci
    if (report.keyFindings.length > 0) {
      parts.push(`${'#'.repeat(subLevel)} Temuan Kunci`);
      parts.push('');
      for (const finding of report.keyFindings) {
        parts.push(`- ${cleanText(finding)}`);
      }
      parts.push('');
    }

    // Bagian (sections + subsections)
    if (report.sections.length > 0) {
      parts.push(`${'#'.repeat(subLevel)} Bagian`);
      parts.push('');
      for (const section of report.sections) {
        parts.push(`${'#'.repeat(subLevel + 1)} ${cleanText(section.heading)}`);
        parts.push('');
        parts.push(cleanText(section.content));
        parts.push('');
        for (const sub of section.subsections ?? []) {
          parts.push(`${'#'.repeat(subLevel + 2)} ${cleanText(sub.heading)}`);
          parts.push('');
          parts.push(cleanText(sub.content));
          parts.push('');
        }
      }
    }

    // Kesimpulan
    if (report.conclusions.length > 0) {
      parts.push(`${'#'.repeat(subLevel)} Kesimpulan`);
      parts.push('');
      for (const c of report.conclusions) {
        parts.push(`- ${cleanText(c)}`);
      }
      parts.push('');
    }

    // Referensi
    if (report.references.length > 0) {
      parts.push(`${'#'.repeat(subLevel)} Referensi`);
      parts.push('');
      for (let i = 0; i < report.references.length; i++) {
        parts.push(`${i + 1}. ${report.references[i]}`);
      }
      parts.push('');
    }

    parts.push('---');
    parts.push('');
  });

  return parts.join('\n').trim() + '\n';
}

/**
 * Hitung kedalaman tiap node dari root (0 = root itu sendiri).
 * Tree dari getResearchTree dijamin BFS: parent selalu muncul sebelum child,
 * jadi depth bisa dihitung dalam satu pass.
 */
function computeDepths(tree: ResearchResult[]): Map<string, number> {
  const depths = new Map<string, number>();
  for (const r of tree) {
    if (!r.parentId) {
      depths.set(r.id, 0);
    } else {
      const parentDepth = depths.get(r.parentId);
      depths.set(r.id, parentDepth !== undefined ? parentDepth + 1 : 1);
    }
  }
  return depths;
}
