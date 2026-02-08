/**
 * PageRank Implementation
 *
 * Computes importance scores for files in a repository
 * based on their reference graph (which files import which).
 *
 * Files that are imported by many other files get higher scores.
 */

/**
 * Node in the reference graph.
 */
interface GraphNode {
  id: string;
  outLinks: Set<string>;
  inLinks: Set<string>;
  score: number;
}

/**
 * Options for PageRank computation.
 */
export interface PageRankOptions {
  /** Damping factor (probability of following a link). Default: 0.85 */
  dampingFactor?: number;
  /** Maximum iterations. Default: 100 */
  maxIterations?: number;
  /** Convergence threshold. Default: 0.0001 */
  tolerance?: number;
}

/**
 * Default PageRank options.
 */
const DEFAULT_OPTIONS: Required<PageRankOptions> = {
  dampingFactor: 0.85,
  maxIterations: 100,
  tolerance: 0.0001,
};

/**
 * Compute PageRank scores for a graph of files.
 *
 * @param nodes - Map of file path to set of files it references (outgoing links)
 * @param options - PageRank options
 * @returns Map of file path to importance score (0-1)
 */
export function computePageRank(
  nodes: Map<string, Set<string>>,
  options: PageRankOptions = {}
): Map<string, number> {
  const { dampingFactor, maxIterations, tolerance } = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  const n = nodes.size;
  if (n === 0) {
    return new Map();
  }

  // Build graph with both directions
  const graph = new Map<string, GraphNode>();

  // Initialize all nodes
  for (const [id, outLinks] of nodes) {
    graph.set(id, {
      id,
      outLinks: new Set(outLinks),
      inLinks: new Set(),
      score: 1 / n, // Initial score
    });
  }

  // Build in-links (reverse edges)
  for (const [id, node] of graph) {
    for (const targetId of node.outLinks) {
      const target = graph.get(targetId);
      if (target) {
        target.inLinks.add(id);
      }
    }
  }

  // Find dangling nodes (nodes with no out-links)
  const danglingNodes: string[] = [];
  for (const [id, node] of graph) {
    // Count out-links that actually exist in the graph
    let validOutLinks = 0;
    for (const link of node.outLinks) {
      if (graph.has(link)) {
        validOutLinks++;
      }
    }
    if (validOutLinks === 0) {
      danglingNodes.push(id);
    }
  }

  // Iterate until convergence
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Calculate dangling sum (redistributed equally to all nodes)
    let danglingSum = 0;
    for (const id of danglingNodes) {
      const node = graph.get(id);
      if (node) {
        danglingSum += node.score;
      }
    }

    // Calculate new scores
    const newScores = new Map<string, number>();
    let maxDelta = 0;

    for (const [id, node] of graph) {
      // Base score from random jumps and dangling nodes
      let newScore = (1 - dampingFactor) / n + (dampingFactor * danglingSum) / n;

      // Add contributions from in-links
      for (const sourceId of node.inLinks) {
        const source = graph.get(sourceId);
        if (source) {
          // Count valid out-links for the source
          let validOutLinks = 0;
          for (const link of source.outLinks) {
            if (graph.has(link)) {
              validOutLinks++;
            }
          }
          if (validOutLinks > 0) {
            newScore += (dampingFactor * source.score) / validOutLinks;
          }
        }
      }

      newScores.set(id, newScore);
      maxDelta = Math.max(maxDelta, Math.abs(newScore - node.score));
    }

    // Update scores
    for (const [id, score] of newScores) {
      const node = graph.get(id);
      if (node) {
        node.score = score;
      }
    }

    // Check convergence
    if (maxDelta < tolerance) {
      break;
    }
  }

  // Normalize scores to 0-1 range
  let maxScore = 0;
  for (const node of graph.values()) {
    maxScore = Math.max(maxScore, node.score);
  }

  const result = new Map<string, number>();
  for (const [id, node] of graph) {
    result.set(id, maxScore > 0 ? node.score / maxScore : 0);
  }

  return result;
}

/**
 * Compute importance scores with boost for entry points.
 *
 * Entry points (index.ts, main.ts, etc.) get a boost
 * since they're often the main interface to a module.
 */
export function computeImportance(
  references: Map<string, Set<string>>,
  options: PageRankOptions & { entryPointBoost?: number } = {}
): Map<string, number> {
  const { entryPointBoost = 0.2, ...prOptions } = options;

  // Compute base PageRank
  const scores = computePageRank(references, prOptions);

  // Entry point patterns
  const entryPatterns = [
    /index\.[jt]sx?$/,
    /main\.[jt]sx?$/,
    /app\.[jt]sx?$/,
    /mod\.[jt]sx?$/,
    /lib\.[jt]sx?$/,
  ];

  // Apply entry point boost
  for (const [path, score] of scores) {
    const isEntryPoint = entryPatterns.some((p) => p.test(path));
    if (isEntryPoint) {
      scores.set(path, Math.min(1, score + entryPointBoost));
    }
  }

  return scores;
}

/**
 * Get the top N files by importance.
 */
export function getTopFiles(
  scores: Map<string, number>,
  n: number
): Array<{ path: string; score: number }> {
  return Array.from(scores.entries())
    .map(([path, score]) => ({ path, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}
