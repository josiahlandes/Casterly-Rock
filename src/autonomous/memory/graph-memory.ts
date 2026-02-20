/**
 * Graph Relational Memory — Entity-Relationship Graph (Mem0)
 *
 * Builds and maintains an in-memory graph of entities and their
 * relationships extracted from memory entries. This enables:
 *
 *   - Entity discovery: What files, concepts, people are mentioned?
 *   - Relationship tracking: How are entities related?
 *   - Context enrichment: Given a topic, what related knowledge exists?
 *   - Impact analysis: What would be affected by a change?
 *
 * Node types: file, concept, person, tool, module, pattern
 * Edge types: depends_on, related_to, uses, modifies, contains,
 *             authored_by, tested_by
 *
 * Storage: ~/.casterly/memory/graph.json
 *
 * Part of Advanced Memory: Graph Relational Memory (Mem0).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getTracer } from '../debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type NodeType = 'file' | 'concept' | 'person' | 'tool' | 'module' | 'pattern';

export type EdgeType =
  | 'depends_on'
  | 'related_to'
  | 'uses'
  | 'modifies'
  | 'contains'
  | 'authored_by'
  | 'tested_by';

/**
 * A node in the knowledge graph.
 */
export interface GraphNode {
  /** Unique node ID */
  id: string;

  /** Display label */
  label: string;

  /** Node type */
  type: NodeType;

  /** Number of mentions across memory */
  mentionCount: number;

  /** Associated memory entry IDs */
  memoryIds: string[];

  /** ISO timestamp of first mention */
  firstSeen: string;

  /** ISO timestamp of last mention */
  lastSeen: string;

  /** Arbitrary metadata */
  metadata: Record<string, string>;
}

/**
 * An edge (relationship) in the knowledge graph.
 */
export interface GraphEdge {
  /** Source node ID */
  sourceId: string;

  /** Target node ID */
  targetId: string;

  /** Relationship type */
  type: EdgeType;

  /** Edge weight (strength of the relationship) */
  weight: number;

  /** ISO timestamp when the edge was first established */
  createdAt: string;
}

export interface GraphMemoryConfig {
  /** Path to graph file */
  path: string;

  /** Maximum nodes */
  maxNodes: number;

  /** Maximum edges */
  maxEdges: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: GraphMemoryConfig = {
  path: '~/.casterly/memory/graph.json',
  maxNodes: 500,
  maxEdges: 2000,
};

function resolvePath(filePath: string): string {
  if (filePath.startsWith('~')) {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
    return filePath.replace('~', home);
  }
  return filePath;
}

function generateNodeId(label: string, type: NodeType): string {
  // Use a deterministic ID based on label and type for deduplication
  return `${type}:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph Memory
// ─────────────────────────────────────────────────────────────────────────────

export class GraphMemory {
  private readonly config: GraphMemoryConfig;
  private nodes: Map<string, GraphNode> = new Map();
  private edges: GraphEdge[] = [];
  private loaded: boolean = false;

  /** Index: nodeId → set of edge indices */
  private adjacency: Map<string, Set<number>> = new Map();

  constructor(config?: Partial<GraphMemoryConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  async load(): Promise<void> {
    const tracer = getTracer();
    const resolvedPath = resolvePath(this.config.path);

    try {
      const content = await readFile(resolvedPath, 'utf8');
      const data = JSON.parse(content) as {
        nodes: GraphNode[];
        edges: GraphEdge[];
      };

      this.nodes.clear();
      for (const node of data.nodes ?? []) {
        this.nodes.set(node.id, node);
      }

      this.edges = data.edges ?? [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        tracer.log('memory', 'warn', 'Failed to load graph memory', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.nodes.clear();
      this.edges = [];
    }

    this.rebuildIndex();
    this.loaded = true;
    tracer.log('memory', 'debug', `Graph memory loaded: ${this.nodes.size} nodes, ${this.edges.length} edges`);
  }

  async save(): Promise<void> {
    const tracer = getTracer();
    const resolvedPath = resolvePath(this.config.path);

    await mkdir(dirname(resolvedPath), { recursive: true });
    await writeFile(
      resolvedPath,
      JSON.stringify(
        {
          nodes: [...this.nodes.values()],
          edges: this.edges,
        },
        null,
        2,
      ),
      'utf8',
    );

    tracer.log('memory', 'debug', `Graph memory saved: ${this.nodes.size} nodes, ${this.edges.length} edges`);
  }

  // ── Node Operations ───────────────────────────────────────────────────────

  /**
   * Add or update a node. If a node with the same label+type exists,
   * increments its mention count.
   */
  addNode(params: {
    label: string;
    type: NodeType;
    memoryId?: string;
    metadata?: Record<string, string>;
  }): GraphNode {
    const id = generateNodeId(params.label, params.type);
    const existing = this.nodes.get(id);

    if (existing) {
      existing.mentionCount++;
      existing.lastSeen = new Date().toISOString();
      if (params.memoryId && !existing.memoryIds.includes(params.memoryId)) {
        existing.memoryIds.push(params.memoryId);
      }
      if (params.metadata) {
        Object.assign(existing.metadata, params.metadata);
      }
      return existing;
    }

    if (this.nodes.size >= this.config.maxNodes) {
      this.evictLeastMentioned();
    }

    const now = new Date().toISOString();
    const node: GraphNode = {
      id,
      label: params.label,
      type: params.type,
      mentionCount: 1,
      memoryIds: params.memoryId ? [params.memoryId] : [],
      firstSeen: now,
      lastSeen: now,
      metadata: params.metadata ?? {},
    };

    this.nodes.set(id, node);
    return node;
  }

  /**
   * Remove a node and all its edges.
   */
  removeNode(nodeId: string): boolean {
    if (!this.nodes.has(nodeId)) return false;

    this.nodes.delete(nodeId);

    // Remove edges connected to this node
    const edgeIndices = this.adjacency.get(nodeId);
    if (edgeIndices) {
      const toRemove = new Set(edgeIndices);
      this.edges = this.edges.filter((_, i) => !toRemove.has(i));
      this.rebuildIndex();
    }

    return true;
  }

  /**
   * Get a node by ID.
   */
  getNode(nodeId: string): GraphNode | undefined {
    return this.nodes.get(nodeId);
  }

  /**
   * Find nodes by type.
   */
  getNodesByType(type: NodeType): GraphNode[] {
    return [...this.nodes.values()].filter((n) => n.type === type);
  }

  /**
   * Search nodes by label (substring match).
   */
  searchNodes(query: string): GraphNode[] {
    const lower = query.toLowerCase();
    return [...this.nodes.values()].filter((n) =>
      n.label.toLowerCase().includes(lower),
    );
  }

  // ── Edge Operations ───────────────────────────────────────────────────────

  /**
   * Add or strengthen an edge between two nodes.
   */
  addEdge(params: {
    sourceId: string;
    targetId: string;
    type: EdgeType;
    weight?: number;
  }): boolean {
    if (!this.nodes.has(params.sourceId) || !this.nodes.has(params.targetId)) {
      return false;
    }

    if (params.sourceId === params.targetId) return false;

    // Check for existing edge
    const existingIdx = this.edges.findIndex(
      (e) =>
        e.sourceId === params.sourceId &&
        e.targetId === params.targetId &&
        e.type === params.type,
    );

    if (existingIdx >= 0) {
      // Strengthen existing edge
      this.edges[existingIdx]!.weight = Math.min(
        1.0,
        this.edges[existingIdx]!.weight + 0.1,
      );
      return true;
    }

    if (this.edges.length >= this.config.maxEdges) {
      this.evictWeakestEdge();
    }

    const edge: GraphEdge = {
      sourceId: params.sourceId,
      targetId: params.targetId,
      type: params.type,
      weight: params.weight ?? 0.5,
      createdAt: new Date().toISOString(),
    };

    const idx = this.edges.length;
    this.edges.push(edge);
    this.indexEdge(idx, edge);

    return true;
  }

  /**
   * Get all edges for a node (both incoming and outgoing).
   */
  getEdgesForNode(nodeId: string): GraphEdge[] {
    const indices = this.adjacency.get(nodeId);
    if (!indices) return [];

    return [...indices]
      .map((i) => this.edges[i])
      .filter((e): e is GraphEdge => e !== undefined);
  }

  /**
   * Get neighbors of a node (nodes directly connected).
   */
  getNeighbors(nodeId: string): GraphNode[] {
    const edges = this.getEdgesForNode(nodeId);
    const neighborIds = new Set<string>();

    for (const edge of edges) {
      if (edge.sourceId === nodeId) neighborIds.add(edge.targetId);
      if (edge.targetId === nodeId) neighborIds.add(edge.sourceId);
    }

    return [...neighborIds]
      .map((id) => this.nodes.get(id))
      .filter((n): n is GraphNode => n !== undefined);
  }

  /**
   * Find the shortest path between two nodes (BFS).
   */
  shortestPath(fromId: string, toId: string): string[] | null {
    if (!this.nodes.has(fromId) || !this.nodes.has(toId)) return null;
    if (fromId === toId) return [fromId];

    const visited = new Set<string>();
    const queue: Array<{ id: string; path: string[] }> = [
      { id: fromId, path: [fromId] },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.id === toId) return current.path;

      if (visited.has(current.id)) continue;
      visited.add(current.id);

      const neighbors = this.getNeighbors(current.id);
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor.id)) {
          queue.push({
            id: neighbor.id,
            path: [...current.path, neighbor.id],
          });
        }
      }
    }

    return null;
  }

  /**
   * Find connected components (clusters of related entities).
   */
  getConnectedComponents(): string[][] {
    const visited = new Set<string>();
    const components: string[][] = [];

    for (const nodeId of this.nodes.keys()) {
      if (visited.has(nodeId)) continue;

      const component: string[] = [];
      const stack = [nodeId];

      while (stack.length > 0) {
        const current = stack.pop()!;
        if (visited.has(current)) continue;
        visited.add(current);
        component.push(current);

        for (const neighbor of this.getNeighbors(current)) {
          if (!visited.has(neighbor.id)) {
            stack.push(neighbor.id);
          }
        }
      }

      components.push(component);
    }

    return components.sort((a, b) => b.length - a.length);
  }

  // ── Query ──────────────────────────────────────────────────────────────────

  nodeCount(): number {
    return this.nodes.size;
  }

  edgeCount(): number {
    return this.edges.length;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  getAllNodes(): ReadonlyArray<GraphNode> {
    return [...this.nodes.values()];
  }

  getAllEdges(): ReadonlyArray<GraphEdge> {
    return this.edges;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private rebuildIndex(): void {
    this.adjacency.clear();
    for (let i = 0; i < this.edges.length; i++) {
      this.indexEdge(i, this.edges[i]!);
    }
  }

  private indexEdge(idx: number, edge: GraphEdge): void {
    if (!this.adjacency.has(edge.sourceId)) {
      this.adjacency.set(edge.sourceId, new Set());
    }
    this.adjacency.get(edge.sourceId)!.add(idx);

    if (!this.adjacency.has(edge.targetId)) {
      this.adjacency.set(edge.targetId, new Set());
    }
    this.adjacency.get(edge.targetId)!.add(idx);
  }

  private evictLeastMentioned(): void {
    let leastId = '';
    let leastCount = Infinity;

    for (const [id, node] of this.nodes) {
      if (node.mentionCount < leastCount) {
        leastId = id;
        leastCount = node.mentionCount;
      }
    }

    if (leastId) this.removeNode(leastId);
  }

  private evictWeakestEdge(): void {
    if (this.edges.length === 0) return;

    let weakestIdx = 0;
    let weakestWeight = this.edges[0]!.weight;

    for (let i = 1; i < this.edges.length; i++) {
      if (this.edges[i]!.weight < weakestWeight) {
        weakestIdx = i;
        weakestWeight = this.edges[i]!.weight;
      }
    }

    this.edges.splice(weakestIdx, 1);
    this.rebuildIndex();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createGraphMemory(
  config?: Partial<GraphMemoryConfig>,
): GraphMemory {
  return new GraphMemory(config);
}
