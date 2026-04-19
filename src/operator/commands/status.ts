import { buildWorkflowApiSnapshot, type BranchRow, type SnapshotData } from '../api/snapshot.ts';
import type { ApiEnvelope, ApiIssue, LaneState, SourceHealthEntry } from '../api/envelope.ts';
import {
  printResult,
  type ParsedOperatorArgs,
} from '../state.ts';
import { renderLaneLine, renderStateGlyph } from './helpers.ts';

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
export async function handleStatus(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
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

  if (parsed.flags.json) {
    printResult(parsed.flags, envelope);
    return;
  }

  const rendered = renderCockpit(envelope, {
    color: process.stdout.isTTY === true && process.env.NO_COLOR === undefined,
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
    const where = issue.branch ? ` ${issue.branch}` : '';
    lines.push(`  [${sev}]${where} ${issue.message}`);
  }
  return lines;
}

function renderBranch(branch: BranchRow, baseBranch: string, color: boolean): string[] {
  const marker = branch.current ? '▶' : ' ';
  const taskSlug = branch.task?.taskSlug ?? branch.name;
  const header = `  ${marker} ${colorize(taskSlug, color, 'bold')}  ${dim(branch.name, color)}`;
  const laneLine = `    ${colorizeLanes(branch.lanes, baseBranch, color)}`;
  const detail: string[] = [];
  if (branch.note) {
    detail.push(`    ${dim(branch.note, color)}`);
  }
  const lockNextAction = readNextAction(branch);
  if (lockNextAction) {
    detail.push(`    next: ${lockNextAction}`);
  }
  return [header, laneLine, ...detail];
}

// The envelope puts TaskLock fields under `branch.task`, but snapshot.ts
// as of this PR only maps a subset (taskSlug/mode/worktreePath/updatedAt).
// `nextAction` is read directly from the lock shape as an additional
// field — callers that consume the envelope JSON (dashboard) will get it
// from the underlying task-lock file just like status does here.
function readNextAction(branch: BranchRow): string | null {
  const task = branch.task as unknown as { nextAction?: string } | null;
  if (!task) return null;
  const text = typeof task.nextAction === 'string' ? task.nextAction.trim() : '';
  return text || null;
}

function renderSource(src: SourceHealthEntry, color: boolean): string {
  const glyph = renderStateGlyph(src.state);
  const tinted = colorize(glyph, color, toneForState(src.state));
  return `${tinted} ${src.name}: ${src.reason}`;
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

  // Current branch first within "active". Rest sorted by slug for stable output.
  active.sort((a, b) => {
    if (a.current && !b.current) return -1;
    if (b.current && !a.current) return 1;
    return (a.task?.taskSlug ?? a.name).localeCompare(b.task?.taskSlug ?? b.name);
  });
  recent.sort((a, b) => {
    const am = a.pr?.mergedAt ? Date.parse(a.pr.mergedAt) : 0;
    const bm = b.pr?.mergedAt ? Date.parse(b.pr.mergedAt) : 0;
    return bm - am;
  });
  stale.sort((a, b) => (a.task?.taskSlug ?? a.name).localeCompare(b.task?.taskSlug ?? b.name));

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
