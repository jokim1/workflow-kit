import { buildWorkflowApiSnapshot, type BranchRow, type SnapshotData } from '../api/snapshot.ts';
import type { ApiEnvelope, ApiIssue, LaneState, SourceHealthEntry } from '../api/envelope.ts';
import {
  loadAllTaskLocks,
  loadDeployState,
  loadPrState,
  printResult,
  resolveWorkflowContext,
  runGit,
  type DeployRecord,
  type Mode,
  type ParsedOperatorArgs,
  type PrRecord,
  type TaskLock,
  type WorkflowConfig,
} from '../state.ts';
import { renderLaneLine, renderStateGlyph, sanitizeForTerminal } from './helpers.ts';

// v0.6: `/status` terminal cockpit. Shells out to workflow:api snapshot
// via the in-process `buildWorkflowApiSnapshot` builder — same envelope
// the Pipelane Board consumes, so there's one rendering of truth per
// lane state. Zero derivation drift by construction.
//
// Shape of this handler:
// 1. Build the envelope (same code path as `workflow:api snapshot`).
// 2. If envelope.ok is false, print the envelope error verbatim and
//    exit non-zero — no silent fallback to raw pr-state.json / etc.
// 3. Otherwise render the cockpit via renderCockpit(envelope) and print.
//
// Tests exercise renderCockpit directly with a fixture envelope (see
// the golden-file case in test/workflow-kit.test.mjs).
//
// v1.4 extensions: --week / --stuck / --blast are alternate views on the
// same underlying state. They read DeployRecord + TaskLock + git diff
// directly (not the envelope) because they're time-series / set-diff
// questions the snapshot doesn't pre-aggregate. Only one view flag may
// be set at a time; the default (no flag) still renders the cockpit.
export async function handleStatus(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const { week, stuck, blastSha, json } = parsed.flags;
  const viewCount = [week, stuck, Boolean(blastSha.trim())].filter(Boolean).length;
  if (viewCount > 1) {
    throw new Error('Pass only one of --week, --stuck, --blast at a time.');
  }

  if (week) {
    const context = resolveWorkflowContext(cwd);
    const view = buildWeekView(context.commonDir, context.config);
    if (json) {
      printResult(parsed.flags, view);
      return;
    }
    process.stdout.write(renderWeekView(view) + '\n');
    return;
  }

  if (stuck) {
    const context = resolveWorkflowContext(cwd);
    const view = buildStuckView(context.commonDir, context.config);
    if (json) {
      printResult(parsed.flags, view);
      return;
    }
    process.stdout.write(renderStuckView(view) + '\n');
    return;
  }

  if (blastSha.trim()) {
    const context = resolveWorkflowContext(cwd);
    const view = buildBlastView(context.repoRoot, context.commonDir, context.config, blastSha.trim());
    if (json) {
      printResult(parsed.flags, view);
      return;
    }
    process.stdout.write(renderBlastView(view) + '\n');
    return;
  }

  let envelope: ApiEnvelope<SnapshotData>;
  try {
    envelope = buildWorkflowApiSnapshot(cwd);
  } catch (error) {
    // Fail loud. Never silently read raw state files.
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`workflow:api snapshot failed: ${message}`);
  }

  if (!envelope.ok) {
    throw new Error(envelope.message || 'workflow:api snapshot returned ok=false');
  }

  if (json) {
    printResult(parsed.flags, envelope);
    return;
  }

  // NO_COLOR spec (https://no-color.org): any non-empty value disables color.
  // Empty string or unset = color allowed (subject to TTY). `!noColor` matches
  // both undefined and '', which is exactly what the spec specifies.
  const noColor = process.env.NO_COLOR;
  const rendered = renderCockpit(envelope, {
    color: process.stdout.isTTY === true && !noColor,
  });
  process.stdout.write(rendered.endsWith('\n') ? rendered : `${rendered}\n`);
}

export interface RenderCockpitOptions {
  color?: boolean;
}

// Pure envelope → string renderer. Exported for golden-file tests.
export function renderCockpit(
  envelope: ApiEnvelope<SnapshotData>,
  options: RenderCockpitOptions = {},
): string {
  const color = options.color === true;
  const { boardContext, branches, sourceHealth, attention } = envelope.data;
  const baseBranch = boardContext.baseBranch;

  const lines: string[] = [];
  lines.push(renderHeader(envelope, color));
  lines.push('');

  // v1.5: persistent OVERRIDE banners. When the release gate is
  // currently bypassed, shout about it in red. Even after the gate is
  // re-armed, keep a softer yellow banner so "this repo has bypassed
  // release at least once" doesn't quietly disappear the moment someone
  // flips back to build. Both banners land above ATTENTION so a long
  // issues list can't scroll either off the screen.
  const override = boardContext.releaseReadiness?.effectiveOverride;
  const lastOverride = boardContext.releaseReadiness?.lastOverride;
  if (override) {
    lines.push(colorize('⚠ OVERRIDE ACTIVE', color, 'red'));
    lines.push(`  reason: ${sanitizeForTerminal(override.reason)}`);
    lines.push(`  since: ${sanitizeForTerminal(override.timestamp)}`);
    lines.push('');
  } else if (lastOverride) {
    lines.push(colorize('ℹ RELEASE GATE PREVIOUSLY BYPASSED', color, 'yellow'));
    lines.push(`  reason: ${sanitizeForTerminal(lastOverride.reason)}`);
    lines.push(`  at: ${sanitizeForTerminal(lastOverride.setAt)} by ${sanitizeForTerminal(lastOverride.setBy)}`);
    lines.push('');
  }

  // v1.2: probe banner mirrors the override banner pattern. Red for
  // degraded (a probe actively failed), yellow for stale (a probe exists
  // but is past PROBE_STALE_MS). Healthy + unknown stay silent; unknown
  // is nudged through attention[] rows (when stale/degraded surfaces exist)
  // or by the release gate's own "run /doctor --probe" message.
  const probeState = boardContext.releaseReadiness?.probeState;
  if (probeState === 'degraded') {
    lines.push(colorize('⚠ DEPLOY PROBE DEGRADED', color, 'red'));
    lines.push('  run `workflow:doctor --probe` to re-probe staging surfaces.');
    lines.push('');
  } else if (probeState === 'stale') {
    lines.push(colorize('ℹ DEPLOY PROBE STALE', color, 'yellow'));
    lines.push('  last probe is >24h old. Run `workflow:doctor --probe` to refresh.');
    lines.push('');
  }

  lines.push(...renderAttention(attention as ApiIssue[], color));
  lines.push('');

  const grouped = groupBranches(branches);

  lines.push(colorize('ACTIVE', color, 'bold'));
  if (grouped.active.length === 0) {
    lines.push('  (none)');
  } else {
    for (const branch of grouped.active) {
      lines.push(...renderBranch(branch, baseBranch, color));
    }
  }
  lines.push('');

  lines.push(colorize('RECENT', color, 'bold'));
  if (grouped.recent.length === 0) {
    lines.push('  (none)');
  } else {
    for (const branch of grouped.recent) {
      lines.push(...renderBranch(branch, baseBranch, color));
    }
  }
  lines.push('');

  lines.push(colorize('STALE', color, 'bold'));
  if (grouped.stale.length === 0) {
    lines.push('  (none)');
  } else {
    for (const branch of grouped.stale) {
      lines.push(...renderBranch(branch, baseBranch, color));
    }
  }
  lines.push('');

  lines.push(colorize('SOURCES', color, 'bold'));
  for (const src of sourceHealth) {
    lines.push(`  ${renderSource(src, color)}`);
  }

  return lines.join('\n');
}

function renderHeader(envelope: ApiEnvelope<SnapshotData>, color: boolean): string {
  const { boardContext } = envelope.data;
  const modeLabel = boardContext.mode.toUpperCase();
  const freshnessLabel = boardContext.overallFreshness.state === 'fresh' ? 'fresh' : 'stale';
  return [
    colorize('Pipelane', color, 'bold'),
    `mode=${modeLabel}`,
    `base=${boardContext.baseBranch}`,
    `snapshot=${freshnessLabel}`,
  ].join('  ');
}

function renderAttention(attention: ApiIssue[], color: boolean): string[] {
  const lines = [colorize('ATTENTION', color, 'bold')];
  if (!Array.isArray(attention) || attention.length === 0) {
    lines.push('  (nothing blocking)');
    return lines;
  }
  for (const issue of attention) {
    const sev = colorize(issue.severity ?? 'warning', color, severityTone(issue.severity));
    const where = issue.branch ? ` ${sanitizeForTerminal(issue.branch)}` : '';
    lines.push(`  [${sev}]${where} ${sanitizeForTerminal(issue.message)}`);
  }
  return lines;
}

function renderBranch(branch: BranchRow, baseBranch: string, color: boolean): string[] {
  const marker = branch.current ? '▶' : ' ';
  const taskSlug = sanitizeForTerminal(branch.task?.taskSlug ?? branch.name);
  const header = `  ${marker} ${colorize(taskSlug, color, 'bold')}  ${dim(sanitizeForTerminal(branch.name), color)}`;
  const laneLine = `    ${colorizeLanes(branch.lanes, baseBranch, color)}`;
  const detail: string[] = [];
  if (branch.note) {
    detail.push(`    ${dim(sanitizeForTerminal(branch.note), color)}`);
  }
  const lockNextAction = readNextAction(branch);
  if (lockNextAction) {
    detail.push(`    next: ${sanitizeForTerminal(lockNextAction)}`);
  }
  return [header, laneLine, ...detail];
}

function readNextAction(branch: BranchRow): string | null {
  const text = branch.task?.nextAction?.trim() ?? '';
  return text || null;
}

function renderSource(src: SourceHealthEntry, color: boolean): string {
  const glyph = renderStateGlyph(src.state);
  const tinted = colorize(glyph, color, toneForState(src.state));
  return `${tinted} ${sanitizeForTerminal(src.name)}: ${sanitizeForTerminal(src.reason)}`;
}

function colorizeLanes(lanes: BranchRow['lanes'], baseBranch: string, color: boolean): string {
  if (!color) {
    return renderLaneLine(lanes, baseBranch);
  }
  const parts: string[] = [
    renderLaneCell('Local', lanes.local, color),
    renderLaneCell('PR', lanes.pr, color),
    renderLaneCell(`Base: ${baseBranch}`, lanes.base, color),
    renderLaneCell('Staging', lanes.staging, color),
    renderLaneCell('Production', lanes.production, color),
  ];
  return parts.join(' ');
}

function renderLaneCell(label: string, cell: { state: LaneState }, color: boolean): string {
  const glyph = renderStateGlyph(cell.state);
  const tinted = colorize(glyph, color, toneForState(cell.state));
  return `[${label} ${tinted}]`;
}

function groupBranches(branches: BranchRow[]): { active: BranchRow[]; recent: BranchRow[]; stale: BranchRow[] } {
  const active: BranchRow[] = [];
  const recent: BranchRow[] = [];
  const stale: BranchRow[] = [];
  const recentWindowMs = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const branch of branches) {
    if (branch.status === 'missing-worktree') {
      stale.push(branch);
      continue;
    }
    if (branch.status === 'merged') {
      const mergedAt = branch.pr?.mergedAt ? Date.parse(branch.pr.mergedAt) : NaN;
      if (Number.isFinite(mergedAt) && now - mergedAt < recentWindowMs) {
        recent.push(branch);
      } else {
        stale.push(branch);
      }
      continue;
    }
    active.push(branch);
  }

  // Current branch first within "active". Rest sorted by slug for stable
  // output. Force `en` locale on localeCompare so golden-file tests don't
  // drift across CI locales (tr-TR flips i/I collation, etc.). Ties
  // break on branch name so readdirSync-order can't leak into the render.
  const byName = (a: BranchRow, b: BranchRow) => a.name.localeCompare(b.name, 'en');
  const bySlugThenName = (a: BranchRow, b: BranchRow) => {
    const slugCompare = (a.task?.taskSlug ?? a.name).localeCompare(b.task?.taskSlug ?? b.name, 'en');
    return slugCompare !== 0 ? slugCompare : byName(a, b);
  };
  active.sort((a, b) => {
    if (a.current && !b.current) return -1;
    if (b.current && !a.current) return 1;
    return bySlugThenName(a, b);
  });
  recent.sort((a, b) => {
    const am = a.pr?.mergedAt ? Date.parse(a.pr.mergedAt) : 0;
    const bm = b.pr?.mergedAt ? Date.parse(b.pr.mergedAt) : 0;
    if (am !== bm) return bm - am;
    return byName(a, b);
  });
  stale.sort(bySlugThenName);

  return { active, recent, stale };
}

type Tone = 'green' | 'blue' | 'cyan' | 'yellow' | 'red' | 'gray' | 'bold';

function toneForState(state: LaneState): Tone {
  switch (state) {
    case 'healthy': return 'green';
    case 'running': return 'blue';
    case 'awaiting_preflight': return 'cyan';
    case 'stale': return 'yellow';
    case 'degraded': return 'yellow';
    case 'blocked': return 'red';
    case 'unknown':
    case 'bypassed':
    default: return 'gray';
  }
}

function severityTone(severity: string | undefined): Tone {
  if (severity === 'error') return 'red';
  if (severity === 'warning') return 'yellow';
  return 'gray';
}

function colorize(text: string, color: boolean, tone: Tone): string {
  if (!color) return text;
  return `${ANSI[tone]}${text}${ANSI.reset}`;
}

function dim(text: string, color: boolean): string {
  if (!color) return text;
  return `${ANSI.gray}${text}${ANSI.reset}`;
}

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
} as const;

// v1.4 constants. Thresholds match the manifest's acceptance criteria:
// 72h idle is "stuck in release", 48h is "staging without prod
// promotion", 14 days is how far back we'll look for PR-without-deploy
// orphans (longer windows spam /status with ancient merges the operator
// has consciously moved on from).
const WEEK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const STUCK_IDLE_MS = 72 * 60 * 60 * 1000;
const STAGING_WITHOUT_PROD_MS = 48 * 60 * 60 * 1000;
const ORPHAN_PR_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────
// v1.4 --week
// ─────────────────────────────────────────────────────────────────────

export interface WeekDay {
  date: string; // YYYY-MM-DD (UTC)
  succeeded: number;
  failed: number;
  cycleSamplesMs: number[];
  p50CycleMs: number | null;
}

export interface WeekView {
  view: 'week';
  window: { fromIso: string; toIso: string };
  days: WeekDay[];
  totals: {
    succeeded: number;
    failed: number;
    distinctShas: number;
    p50CycleMs: number | null;
  };
}

export function buildWeekView(
  commonDir: string,
  config: WorkflowConfig,
  now: Date = new Date(),
): WeekView {
  const to = now.getTime();
  const from = to - WEEK_WINDOW_MS;
  const { records } = loadDeployState(commonDir, config);

  const byDay = new Map<string, { succeeded: number; failed: number; cycles: number[] }>();
  // Pre-seed 7 days so every day shows up even when idle.
  for (let i = 6; i >= 0; i -= 1) {
    const day = utcDay(new Date(to - i * 24 * 60 * 60 * 1000));
    byDay.set(day, { succeeded: 0, failed: 0, cycles: [] });
  }

  let succeededTotal = 0;
  let failedTotal = 0;
  const shas = new Set<string>();
  const allCycles: number[] = [];

  for (const record of records) {
    const requestedMs = Date.parse(record.requestedAt);
    if (!Number.isFinite(requestedMs) || requestedMs < from || requestedMs > to) continue;
    const day = utcDay(new Date(requestedMs));
    const bucket = byDay.get(day) ?? { succeeded: 0, failed: 0, cycles: [] };
    if (record.status === 'succeeded') {
      bucket.succeeded += 1;
      succeededTotal += 1;
      const verifiedMs = record.verifiedAt ? Date.parse(record.verifiedAt) : NaN;
      if (Number.isFinite(verifiedMs) && verifiedMs >= requestedMs) {
        const cycle = verifiedMs - requestedMs;
        bucket.cycles.push(cycle);
        allCycles.push(cycle);
      }
    } else if (record.status === 'failed') {
      bucket.failed += 1;
      failedTotal += 1;
    }
    if (record.sha) shas.add(record.sha);
    byDay.set(day, bucket);
  }

  // Sort days oldest→newest so the render reads like a timeline.
  const days: WeekDay[] = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, entry]) => ({
      date,
      succeeded: entry.succeeded,
      failed: entry.failed,
      cycleSamplesMs: entry.cycles,
      p50CycleMs: median(entry.cycles),
    }));

  return {
    view: 'week',
    window: { fromIso: new Date(from).toISOString(), toIso: new Date(to).toISOString() },
    days,
    totals: {
      succeeded: succeededTotal,
      failed: failedTotal,
      distinctShas: shas.size,
      p50CycleMs: median(allCycles),
    },
  };
}

export function renderWeekView(view: WeekView): string {
  const header = `SHIPPED (last 7 days, ${view.window.fromIso.slice(0, 10)} → ${view.window.toIso.slice(0, 10)})`;
  const rows: string[][] = [['date', 'ok', 'fail', 'p50-cycle']];
  for (const day of view.days) {
    rows.push([
      day.date,
      String(day.succeeded),
      String(day.failed),
      formatDurationOrDash(day.p50CycleMs),
    ]);
  }
  rows.push([
    'TOTAL',
    String(view.totals.succeeded),
    String(view.totals.failed),
    formatDurationOrDash(view.totals.p50CycleMs),
  ]);
  const tableLines = renderTable(rows, { indent: '  ' });
  const summaryLines = [
    `  distinct shas deployed: ${view.totals.distinctShas}`,
  ];
  return [header, '', ...tableLines, '', ...summaryLines].join('\n');
}

// ─────────────────────────────────────────────────────────────────────
// v1.4 --stuck
// ─────────────────────────────────────────────────────────────────────

export interface StuckIdleTask {
  taskSlug: string;
  taskName: string | null;
  branchName: string;
  mode: Mode;
  idleMs: number;
  updatedAt: string;
  nextAction: string | null;
}

export interface StuckOrphanPr {
  taskSlug: string;
  number: number | null;
  title: string;
  mergedSha: string | null;
  mergedAt: string | null;
}

export interface StuckStaleStaging {
  sha: string;
  surfaces: string[];
  verifiedAt: string | null;
  ageMs: number;
}

export interface StuckView {
  view: 'stuck';
  idleTasks: StuckIdleTask[];
  orphanMergedPrs: StuckOrphanPr[];
  staleStaging: StuckStaleStaging[];
}

export function buildStuckView(
  commonDir: string,
  config: WorkflowConfig,
  now: Date = new Date(),
): StuckView {
  const nowMs = now.getTime();
  const locks = loadAllTaskLocks(commonDir, config);
  const { records } = loadDeployState(commonDir, config);
  const prRecords = Object.values(loadPrState(commonDir, config).records);

  const idleTasks: StuckIdleTask[] = [];
  for (const lock of locks) {
    if (lock.mode !== 'release') continue;
    const updatedMs = Date.parse(lock.updatedAt);
    if (!Number.isFinite(updatedMs)) continue;
    const idleMs = nowMs - updatedMs;
    if (idleMs < STUCK_IDLE_MS) continue;
    idleTasks.push({
      taskSlug: lock.taskSlug,
      taskName: lock.taskName ?? null,
      branchName: lock.branchName,
      mode: lock.mode,
      idleMs,
      updatedAt: lock.updatedAt,
      nextAction: lock.nextAction?.trim() || null,
    });
  }
  idleTasks.sort((a, b) => b.idleMs - a.idleMs);

  // "PRs merged with no matching DeployRecord" — a DeployRecord matches
  // when it shares the mergedSha and environment='staging' or 'prod'.
  // We don't require success here; the signal is "we merged but never
  // even tried to deploy this sha," which is the state operators want
  // to be reminded of.
  const deployedShas = new Set(records.map((record) => record.sha).filter(Boolean));
  const orphanMergedPrs: StuckOrphanPr[] = [];
  for (const pr of prRecords) {
    if (!pr.mergedSha || !pr.mergedAt) continue;
    const mergedMs = Date.parse(pr.mergedAt);
    if (!Number.isFinite(mergedMs)) continue;
    if (nowMs - mergedMs > ORPHAN_PR_WINDOW_MS) continue;
    if (deployedShas.has(pr.mergedSha)) continue;
    orphanMergedPrs.push({
      taskSlug: pr.taskSlug,
      number: pr.number ?? null,
      title: pr.title ?? '',
      mergedSha: pr.mergedSha,
      mergedAt: pr.mergedAt,
    });
  }
  orphanMergedPrs.sort((a, b) => (a.mergedAt ?? '').localeCompare(b.mergedAt ?? ''));

  // "Staging DeployRecords with no prod promotion after 48h" — for each
  // succeeded+verified staging record whose sha never shows up in a
  // succeeded prod record, warn if verifiedAt is older than 48h.
  const prodShas = new Set(
    records.filter((r) => r.environment === 'prod' && r.status === 'succeeded').map((r) => r.sha),
  );
  const stagingByShaSurfaces = new Map<string, DeployRecord>();
  for (const record of records) {
    if (record.environment !== 'staging') continue;
    if (record.status !== 'succeeded') continue;
    if (!record.sha) continue;
    const key = `${record.sha}:${[...(record.surfaces ?? [])].sort().join(',')}`;
    const prev = stagingByShaSurfaces.get(key);
    const prevVerifiedMs = prev?.verifiedAt ? Date.parse(prev.verifiedAt) : 0;
    const curVerifiedMs = record.verifiedAt ? Date.parse(record.verifiedAt) : 0;
    if (!prev || curVerifiedMs > prevVerifiedMs) stagingByShaSurfaces.set(key, record);
  }
  const staleStaging: StuckStaleStaging[] = [];
  for (const record of stagingByShaSurfaces.values()) {
    if (prodShas.has(record.sha)) continue;
    const verifiedMs = record.verifiedAt ? Date.parse(record.verifiedAt) : NaN;
    if (!Number.isFinite(verifiedMs)) continue;
    const ageMs = nowMs - verifiedMs;
    if (ageMs < STAGING_WITHOUT_PROD_MS) continue;
    staleStaging.push({
      sha: record.sha,
      surfaces: [...(record.surfaces ?? [])].sort(),
      verifiedAt: record.verifiedAt ?? null,
      ageMs,
    });
  }
  staleStaging.sort((a, b) => b.ageMs - a.ageMs);

  return { view: 'stuck', idleTasks, orphanMergedPrs, staleStaging };
}

export function renderStuckView(view: StuckView): string {
  const lines: string[] = ['STUCK'];
  const nothingStuck =
    view.idleTasks.length === 0 &&
    view.orphanMergedPrs.length === 0 &&
    view.staleStaging.length === 0;
  if (nothingStuck) {
    lines.push('  (nothing stuck)');
    return lines.join('\n');
  }

  lines.push('  idle >72h (release mode):');
  if (view.idleTasks.length === 0) {
    lines.push('    (none)');
  } else {
    for (const task of view.idleTasks) {
      const head = `    ${task.taskSlug}  branch=${task.branchName}  idle=${formatDuration(task.idleMs)}`;
      lines.push(head);
      if (task.nextAction) {
        lines.push(`      next: ${sanitizeForTerminal(task.nextAction)}`);
      }
    }
  }

  lines.push('  merged PRs without DeployRecord (last 14d):');
  if (view.orphanMergedPrs.length === 0) {
    lines.push('    (none)');
  } else {
    for (const pr of view.orphanMergedPrs) {
      const prLabel = pr.number !== null ? `PR #${pr.number}` : 'PR (no number)';
      lines.push(
        `    ${prLabel}  task=${pr.taskSlug}  mergedSha=${pr.mergedSha ?? '?'}  mergedAt=${pr.mergedAt ?? '?'}`,
      );
    }
  }

  lines.push('  staging without prod promotion (>48h):');
  if (view.staleStaging.length === 0) {
    lines.push('    (none)');
  } else {
    for (const staging of view.staleStaging) {
      lines.push(
        `    sha=${staging.sha.slice(0, 12)}  surfaces=${staging.surfaces.join(',') || '(none)'}  verifiedAt=${staging.verifiedAt ?? '?'}  age=${formatDuration(staging.ageMs)}`,
      );
    }
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────
// v1.4 --blast
// ─────────────────────────────────────────────────────────────────────

export type BlastBaseKind = 'prod-deploy' | 'merge-base' | 'base-branch';

export interface BlastView {
  view: 'blast';
  sha: string;
  resolvedSha: string;
  base: { kind: BlastBaseKind; sha: string; label: string };
  surfaces: Record<string, string[]>;
  other: string[];
  totalFiles: number;
  hint: string | null;
}

export function buildBlastView(
  repoRoot: string,
  commonDir: string,
  config: WorkflowConfig,
  sha: string,
): BlastView {
  const resolvedSha = runGit(repoRoot, ['rev-parse', sha], true);
  if (!resolvedSha) {
    throw new Error(`Could not resolve "${sha}" in this repo. Pass a commit sha or rev-parseable ref.`);
  }

  // Prefer the most recent succeeded prod DeployRecord as the base. That's
  // the "what's currently in prod" anchor. Fall back to baseBranch HEAD if
  // no prod deploys have ever happened, and finally to merge-base if the
  // baseBranch ref can't be resolved.
  const { records } = loadDeployState(commonDir, config);
  const lastGood = records
    .filter((r) => r.environment === 'prod' && r.status === 'succeeded' && r.sha)
    .sort((a, b) => (b.verifiedAt ?? b.requestedAt).localeCompare(a.verifiedAt ?? a.requestedAt))[0];
  let base: BlastView['base'];
  if (lastGood?.sha && runGit(repoRoot, ['cat-file', '-e', lastGood.sha], true) !== null) {
    base = {
      kind: 'prod-deploy',
      sha: lastGood.sha,
      label: `last succeeded prod deploy @ ${lastGood.verifiedAt ?? lastGood.requestedAt}`,
    };
  } else {
    const baseSha = runGit(repoRoot, ['rev-parse', config.baseBranch], true);
    if (baseSha) {
      base = { kind: 'base-branch', sha: baseSha, label: `${config.baseBranch} HEAD` };
    } else {
      const mergeBase = runGit(repoRoot, ['merge-base', 'HEAD', resolvedSha], true);
      if (!mergeBase) {
        throw new Error(
          `No prior prod deploy and baseBranch "${config.baseBranch}" is unresolvable — cannot compute blast radius.`,
        );
      }
      base = { kind: 'merge-base', sha: mergeBase, label: `merge-base(HEAD, ${resolvedSha.slice(0, 7)})` };
    }
  }

  const diffOutput = runGit(repoRoot, ['diff', '--name-only', `${base.sha}..${resolvedSha}`], true) ?? '';
  const files = diffOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const map = config.surfacePathMap ?? {};
  const surfaceBuckets: Record<string, string[]> = {};
  const other: string[] = [];
  for (const file of files) {
    const matched = matchSurface(file, map);
    if (matched) {
      if (!surfaceBuckets[matched]) surfaceBuckets[matched] = [];
      surfaceBuckets[matched].push(file);
    } else {
      other.push(file);
    }
  }
  for (const list of Object.values(surfaceBuckets)) list.sort();
  other.sort();

  const hint =
    Object.keys(map).length === 0
      ? 'configure `surfacePathMap` in .project-workflow.json to group these files by surface.'
      : null;

  return {
    view: 'blast',
    sha,
    resolvedSha,
    base,
    surfaces: surfaceBuckets,
    other,
    totalFiles: files.length,
    hint,
  };
}

export function renderBlastView(view: BlastView): string {
  const lines: string[] = [];
  const shortSha = view.resolvedSha.slice(0, 12);
  const shortBase = view.base.sha.slice(0, 12);
  lines.push(`BLAST ${shortSha}  (base: ${view.base.kind} ${shortBase} — ${view.base.label})`);
  lines.push(`  ${view.totalFiles} file(s) changed.`);
  lines.push('');

  if (view.totalFiles === 0) {
    lines.push('  (no files changed between base and target)');
    if (view.hint) lines.push(`  hint: ${view.hint}`);
    return lines.join('\n');
  }

  const surfaceNames = Object.keys(view.surfaces).sort();
  for (const surface of surfaceNames) {
    const files = view.surfaces[surface];
    lines.push(`  ${surface} (${files.length} file${files.length === 1 ? '' : 's'}):`);
    for (const file of files) lines.push(`    ${file}`);
  }
  if (view.other.length > 0) {
    lines.push(`  other (${view.other.length} file${view.other.length === 1 ? '' : 's'}):`);
    for (const file of view.other) lines.push(`    ${file}`);
  }
  if (view.hint) {
    lines.push('');
    lines.push(`  hint: ${view.hint}`);
  }
  return lines.join('\n');
}

// Match a POSIX-ish file path against a surface map. A file matches when
// one of the map's prefixes is either an exact string equal to the file,
// or a directory prefix (ending in '/' or treated as one). First match
// wins in surface-insertion order; ties go to the shorter key name so
// tests stay deterministic regardless of Object.keys iteration.
function matchSurface(file: string, map: Record<string, string[]>): string | null {
  const surfaces = Object.keys(map).sort();
  for (const surface of surfaces) {
    for (const pattern of map[surface] ?? []) {
      if (!pattern) continue;
      if (pattern === file) return surface;
      const dirPattern = pattern.endsWith('/') ? pattern : `${pattern}/`;
      if (file.startsWith(dirPattern)) return surface;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// v1.4 helpers
// ─────────────────────────────────────────────────────────────────────

function utcDay(date: Date): string {
  // Use toISOString so daylight-saving never shifts the bucket; month
  // and day always land on UTC boundaries.
  return date.toISOString().slice(0, 10);
}

function median(samples: number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
  return sorted[mid];
}

function formatDurationOrDash(ms: number | null): string {
  if (ms === null) return '—';
  return formatDuration(ms);
}

function formatDuration(ms: number): string {
  if (ms < 0) return '0s';
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
  }
  if (hours > 0) {
    return `${hours}h${String(minutes).padStart(2, '0')}m`;
  }
  if (minutes > 0) {
    return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  }
  return `${seconds}s`;
}

// Left-aligned fixed-width table. No color, no unicode box-drawing —
// terminals behave predictably and the output diff-compares cleanly for
// golden-file tests.
function renderTable(rows: string[][], options: { indent?: string } = {}): string[] {
  if (rows.length === 0) return [];
  const indent = options.indent ?? '';
  const widths = rows[0].map((_, colIndex) =>
    rows.reduce((max, row) => Math.max(max, (row[colIndex] ?? '').length), 0),
  );
  return rows.map((row) => {
    const parts = row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i])));
    return `${indent}${parts.join('  ')}`;
  });
}
