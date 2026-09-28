import type { Gist, GistArtifact, GistChanged, StrataPolicy } from '@strata-ctx/core-types';
import { validateGist, pinSetText } from '@strata-ctx/core-types';
import type { ArtifactStore } from '@strata-ctx/security';
import type { StrataTelemetryEvent } from '@strata-ctx/telemetry';

/**
 * C-6: Offline consolidation / dreaming.
 *
 * Runs when the agent is idle to cluster related gists and create higher-level
 * meta-gists. See docs/architecture.md §6.5.
 *
 * Safety: never evicts a gist whose constraints are not fully represented in
 * the meta-gist (byte-equality on the constraint field).
 */

export interface DreamingConfig {
  readonly enabled: boolean;
  readonly intervalHours: number;
  readonly maxGistsPerRun: number;
}

export interface DreamingReport {
  readonly runId: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly inputGistCount: number;
  readonly clustersFormed: number;
  readonly metaGistsCreated: number;
  readonly gistsEvicted: number;
  readonly constraintsPreserved: boolean;
  readonly errors: readonly string[];
}

export interface GistCluster {
  readonly gists: readonly Gist[];
  readonly sharedPaths: readonly string[];
  readonly sharedConstraints: readonly string[];
  readonly topic: string;
}

export interface MetaGist extends Gist {
  readonly meta: true;
  readonly subsumedGistIds: readonly string[];
}

export interface DreamingDeps {
  readonly store: ArtifactStore;
  readonly policy: StrataPolicy;
  readonly getGists: () => Promise<readonly Gist[]>;
  readonly putGist: (gist: Gist) => Promise<void>;
  readonly removeGist: (taskId: string) => Promise<void>;
  readonly emitTelemetry: (event: StrataTelemetryEvent) => void;
  readonly clock: () => number;
  readonly config: DreamingConfig;
}

const DEFAULT_CONFIG: DreamingConfig = {
  enabled: true,
  intervalHours: 24,
  maxGistsPerRun: 50,
};

function mergeConfig(user: Partial<DreamingConfig>): DreamingConfig {
  return {
    enabled: user.enabled ?? DEFAULT_CONFIG.enabled,
    intervalHours: user.intervalHours ?? DEFAULT_CONFIG.intervalHours,
    maxGistsPerRun: user.maxGistsPerRun ?? DEFAULT_CONFIG.maxGistsPerRun,
  };
}

function extractFilePaths(gist: Gist): Set<string> {
  const paths = new Set<string>();
  for (const c of gist.changed) paths.add(c.path);
  return paths;
}

function extractConstraints(gist: Gist): Set<string> {
  return new Set(gist.constraints);
}

function jaccardSimilarity<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  return intersection.size / union.size;
}

function clusterGists(gists: readonly Gist[], maxClusters: number): GistCluster[] {
  if (gists.length === 0) return [];

  const clusters: GistCluster[] = [];
  const used = new Set<number>();

  for (let i = 0; i < gists.length && clusters.length < maxClusters; i++) {
    if (used.has(i)) continue;

    const seed = gists[i];
    if (!seed) continue;
    const clusterGists: Gist[] = [seed];
    const seedPaths = extractFilePaths(seed);
    const seedConstraints = extractConstraints(seed);
    used.add(i);

    for (let j = i + 1; j < gists.length; j++) {
      if (used.has(j)) continue;
      const candidate = gists[j];
      if (!candidate) continue;
      const candidatePaths = extractFilePaths(candidate);
      const candidateConstraints = extractConstraints(candidate);

      const pathSim = jaccardSimilarity(seedPaths, candidatePaths);
      const constraintSim = jaccardSimilarity(seedConstraints, candidateConstraints);

      if (pathSim > 0.3 || constraintSim > 0.5) {
        clusterGists.push(candidate);
        used.add(j);
      }
    }

    if (clusterGists.length > 1) {
      const allPaths = new Set<string>();
      const allConstraints = new Set<string>();
      for (const g of clusterGists) {
        for (const p of extractFilePaths(g)) allPaths.add(p);
        for (const c of extractConstraints(g)) allConstraints.add(c);
      }
      clusters.push({
        gists: clusterGists,
        sharedPaths: [...allPaths].sort(),
        sharedConstraints: [...allConstraints].sort(),
        topic: deriveTopic(clusterGists),
      });
    }
  }

  return clusters;
}

function deriveTopic(gists: readonly Gist[]): string {
  const goals = gists.map((g) => g.goal).join('; ');
  const words = goals.toLowerCase().match(/\b\w{4,}\b/g) ?? [];
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w);
  const firstGist = gists[0];
  return top.length > 0 ? top.join('_') : firstGist ? `cluster_${firstGist.task_id.slice(0, 8)}` : 'cluster_unknown';
}

function createMetaGist(cluster: GistCluster, policy: StrataPolicy, _clock: () => number): MetaGist {
  const allChanged = new Map<string, GistChanged>();
  const allDecided = new Map<string, Gist['decided'][number]>();
  const allUnresolved = new Set<string>();
  const allArtifacts = new Map<string, GistArtifact>();
  const allCurrentValues = new Map<string, string>();
  const allRan = new Set<string>();
  const allFailed = new Set<string>();
  const allSalientErrors = new Set<string>();
  const allSalientWarnings = new Set<string>();
  let totalDropped = 0;
  const subsumedIds: string[] = [];

  let earliestTurn = Infinity;
  let latestTurn = -Infinity;

  for (const g of cluster.gists) {
    subsumedIds.push(g.task_id);
    for (const c of g.changed) {
      if (!allChanged.has(c.path) || c.sha > allChanged.get(c.path)!.sha) {
        allChanged.set(c.path, c);
      }
    }
    for (const d of g.decided) {
      if (!allDecided.has(d.id)) allDecided.set(d.id, d);
    }
    for (const u of g.unresolved) allUnresolved.add(u);
    for (const a of g.artifacts) {
      if (!allArtifacts.has(a.uri)) allArtifacts.set(a.uri, a);
    }
    for (const [k, v] of Object.entries(g.current_values)) allCurrentValues.set(k, v);
    for (const r of g.log_gist.ran) allRan.add(r);
    for (const f of g.log_gist.failed) allFailed.add(f);
    for (const e of g.log_gist.salient_errors) allSalientErrors.add(e);
    for (const w of g.log_gist.salient_warnings) allSalientWarnings.add(w);
    totalDropped += g.log_gist.dropped_count;
    const [from, to] = g.source_turn_range;
    if (from < earliestTurn) earliestTurn = from;
    if (to > latestTurn) latestTurn = to;
  }

const metaTaskId = `meta_${cluster.topic}_${Date.now().toString(36)}`;
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const meta: MetaGist = {
    v: 1,
    task_id: metaTaskId,
    status: 'complete',
    goal: `Consolidated summary of ${cluster.gists.length} related tasks: ${cluster.topic}`,
    changed: [...allChanged.values()],
    current_values: Object.fromEntries(allCurrentValues),
    decided: [...allDecided.values()],
    unresolved: [...allUnresolved].sort(),
    artifacts: [...allArtifacts.values()],
    next: {
      question: 'What is the next high-level objective?',
      next_command: 'continue',
      blockers: [],
    },
    log_gist: {
      ran: [...allRan].sort(),
      failed: [...allFailed].sort(),
      salient_errors: [...allSalientErrors].sort(),
      salient_warnings: [...allSalientWarnings].sort(),
      dropped_count: totalDropped,
      raw_uri: `artifact://log/meta_${metaTaskId}`,
    },
    verification: { status: 'untested', tests_run: [] },
    constraints: [...pinSetText(policy)],
    source_turn_range: [earliestTurn, latestTurn],
    raw_recoverable: true,
    compressed_by: 'none',
    meta: true,
    subsumedGistIds: subsumedIds,
  } as MetaGist;

  return meta;
}

function constraintsByteEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function metaGistSubsumesGist(meta: MetaGist, gist: Gist): boolean {
  return constraintsByteEqual(meta.constraints, gist.constraints);
}

export class DreamingJob {
  readonly #deps: DreamingDeps;

  constructor(deps: DreamingDeps) {
    this.#deps = {
      ...deps,
      config: mergeConfig(deps.config ?? {}),
    };
  }

  get config(): DreamingConfig {
    return this.#deps.config;
  }

  async run(): Promise<DreamingReport> {
    const startedAt = this.#deps.clock();
    const runId = `dream_${startedAt.toString(36)}`;
    const errors: string[] = [];

    if (!this.#deps.config.enabled) {
      return {
        runId,
        startedAt,
        finishedAt: this.#deps.clock(),
        inputGistCount: 0,
        clustersFormed: 0,
        metaGistsCreated: 0,
        gistsEvicted: 0,
        constraintsPreserved: true,
        errors: ['dreaming disabled'],
      };
    }

    let allGists: readonly Gist[];
    try {
      allGists = await this.#deps.getGists();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`failed to load gists: ${msg}`);
      return {
        runId,
        startedAt,
        finishedAt: this.#deps.clock(),
        inputGistCount: 0,
        clustersFormed: 0,
        metaGistsCreated: 0,
        gistsEvicted: 0,
        constraintsPreserved: false,
        errors,
      };
    }

    const limitedGists = allGists.slice(0, this.#deps.config.maxGistsPerRun);
    const clusters = clusterGists(limitedGists, this.#deps.config.maxGistsPerRun);

    let metaGistsCreated = 0;
    let gistsEvicted = 0;
    let constraintsPreserved = true;

    for (const cluster of clusters) {
      const meta = createMetaGist(cluster, this.#deps.policy, this.#deps.clock);

      const validation = validateGist(meta);
      if (!validation.ok) {
        errors.push(`meta-gist ${meta.task_id} validation failed: ${validation.defects.map((d) => d.kind).join(', ')}`);
        constraintsPreserved = false;
        continue;
      }

      try {
        await this.#deps.putGist(meta);
        metaGistsCreated++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`failed to store meta-gist ${meta.task_id}: ${msg}`);
        constraintsPreserved = false;
        continue;
      }

      for (const gist of cluster.gists) {
        if (metaGistSubsumesGist(meta, gist)) {
          try {
            await this.#deps.removeGist(gist.task_id);
            gistsEvicted++;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            errors.push(`failed to evict gist ${gist.task_id}: ${msg}`);
          }
        }
      }
    }

    const finishedAt = this.#deps.clock();

    const consolidationEvent: StrataTelemetryEvent = {
      type: 'consolidation',
      runId,
      clustersFormed: clusters.length,
      metaGistsCreated,
      gistsEvicted,
      constraintsPreserved,
      durationMs: finishedAt - startedAt,
    };
    const typedEvent = consolidationEvent as StrataTelemetryEvent & { type: 'consolidation' };
    this.#deps.emitTelemetry(typedEvent);

    return {
      runId,
      startedAt,
      finishedAt,
      inputGistCount: limitedGists.length,
      clustersFormed: clusters.length,
      metaGistsCreated,
      gistsEvicted,
      constraintsPreserved,
      errors: Object.freeze(errors),
    };
  }
}

export function createDreamingJob(deps: DreamingDeps): DreamingJob {
  return new DreamingJob(deps);
}