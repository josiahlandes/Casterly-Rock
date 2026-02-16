/**
 * Git Operations for Autonomous Self-Improvement
 *
 * Handles all git operations: branching, committing, pushing, merging, PRs.
 * GitHub is the source of truth for all changes.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import type { AutonomousConfig, FileChange, IntegrationResult } from './types.js';

const execAsync = promisify(exec);

// ============================================================================
// GIT OPERATIONS
// ============================================================================

export class GitOperations {
  private readonly projectRoot: string;
  private readonly config: AutonomousConfig['git'];

  constructor(projectRoot: string, config: AutonomousConfig['git']) {
    this.projectRoot = projectRoot;
    this.config = config;
  }

  // --------------------------------------------------------------------------
  // BASIC OPERATIONS
  // --------------------------------------------------------------------------

  /**
   * Execute a git command.
   */
  private async git(command: string): Promise<string> {
    try {
      const { stdout } = await execAsync(`git ${command}`, {
        cwd: this.projectRoot,
        timeout: 60000,
      });
      return stdout.trim();
    } catch (error) {
      const err = error as { stderr?: string; message?: string };
      throw new Error(`Git command failed: ${err.stderr || err.message}`);
    }
  }

  /**
   * Fetch latest changes from remote.
   */
  async fetchLatest(): Promise<void> {
    await this.git(`fetch ${this.config.remote} ${this.config.baseBranch}`);
  }

  /**
   * Checkout and pull the base branch.
   */
  async checkoutBase(): Promise<void> {
    await this.git(`checkout ${this.config.baseBranch}`);
    await this.git(`pull ${this.config.remote} ${this.config.baseBranch}`);
  }

  /**
   * Get current branch name.
   */
  async getCurrentBranch(): Promise<string> {
    return await this.git('branch --show-current');
  }

  /**
   * Check if working directory is clean.
   */
  async isClean(): Promise<boolean> {
    const status = await this.git('status --porcelain');
    return status.length === 0;
  }

  // --------------------------------------------------------------------------
  // BRANCH OPERATIONS
  // --------------------------------------------------------------------------

  /**
   * Create a new branch for a hypothesis.
   */
  async createBranch(hypothesisId: string): Promise<string> {
    const branchName = `${this.config.branchPrefix}${hypothesisId}`;

    // Make sure we're on the base branch first
    await this.checkoutBase();

    // Create and checkout new branch
    await this.git(`checkout -b ${branchName}`);

    return branchName;
  }

  /**
   * Check if a branch exists locally or remotely.
   */
  async branchExists(branchName: string): Promise<boolean> {
    try {
      await this.git(`rev-parse --verify ${branchName}`);
      return true;
    } catch {
      // Try remote
      try {
        await this.git(`rev-parse --verify ${this.config.remote}/${branchName}`);
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * List all auto branches.
   */
  async listAutoBranches(): Promise<string[]> {
    try {
      const output = await this.git(`branch -a --format="%(refname:short)"`);
      return output
        .split('\n')
        .filter((b) => b.startsWith(this.config.branchPrefix) || b.includes(`/${this.config.branchPrefix}`));
    } catch {
      return [];
    }
  }

  /**
   * Delete a branch locally and remotely.
   */
  async deleteBranch(branchName: string): Promise<void> {
    // Switch to base first if we're on the branch to delete
    const current = await this.getCurrentBranch();
    if (current === branchName) {
      await this.git(`checkout ${this.config.baseBranch}`);
    }

    // Delete locally (force in case not merged)
    try {
      await this.git(`branch -D ${branchName}`);
    } catch {
      // Branch may not exist locally
    }

    // Delete remotely
    try {
      await this.git(`push ${this.config.remote} --delete ${branchName}`);
    } catch {
      // Branch may not exist remotely
    }
  }

  // --------------------------------------------------------------------------
  // COMMIT OPERATIONS
  // --------------------------------------------------------------------------

  /**
   * Apply file changes to the working directory.
   */
  async applyChanges(changes: FileChange[]): Promise<void> {
    const fs = await import('fs/promises');
    const path = await import('path');

    for (const change of changes) {
      const fullPath = path.join(this.projectRoot, change.path);

      switch (change.type) {
        case 'create':
        case 'modify':
          if (change.diff) {
            // Ensure directory exists
            await fs.mkdir(path.dirname(fullPath), { recursive: true });
            await fs.writeFile(fullPath, change.diff, 'utf-8');
          }
          break;
        case 'delete':
          try {
            await fs.unlink(fullPath);
          } catch {
            // File may not exist
          }
          break;
      }
    }
  }

  /**
   * Stage and commit changes.
   */
  async commit(message: string, files?: string[]): Promise<string> {
    // Stage files
    if (files && files.length > 0) {
      for (const file of files) {
        await this.git(`add "${file}"`);
      }
    } else {
      await this.git('add -A');
    }

    // Check if there are changes to commit
    const status = await this.git('status --porcelain');
    if (!status) {
      throw new Error('No changes to commit');
    }

    // Commit with message (escape quotes in message)
    const escapedMessage = message.replace(/"/g, '\\"');
    await this.git(`commit -m "${escapedMessage}"`);

    // Return commit hash
    return await this.git('rev-parse HEAD');
  }

  /**
   * Push branch to remote.
   */
  async push(branchName: string, setUpstream: boolean = true): Promise<void> {
    const upstreamFlag = setUpstream ? '-u' : '';
    await this.git(`push ${upstreamFlag} ${this.config.remote} ${branchName}`);
  }

  // --------------------------------------------------------------------------
  // INTEGRATION OPERATIONS
  // --------------------------------------------------------------------------

  /**
   * Integrate a branch (merge or PR based on config).
   * For approval_required mode, the approval gate runs in the loop BEFORE
   * calling integrate() — so by the time we get here, approval is already granted.
   */
  async integrate(branchName: string): Promise<IntegrationResult> {
    if (this.config.integrationMode === 'pull_request') {
      return await this.createPullRequest(branchName);
    } else {
      // Both 'direct' and 'approval_required' use direct merge
      // (approval gate is handled upstream in the loop)
      return await this.mergeDirect(branchName);
    }
  }

  /**
   * Merge branch directly to main.
   */
  async mergeDirect(branchName: string): Promise<IntegrationResult> {
    try {
      // Checkout base
      await this.git(`checkout ${this.config.baseBranch}`);

      // Pull latest
      await this.git(`pull ${this.config.remote} ${this.config.baseBranch}`);

      // Merge the branch
      await this.git(`merge ${branchName} --no-ff -m "auto: merge ${branchName}"`);

      // Push
      await this.git(`push ${this.config.remote} ${this.config.baseBranch}`);

      // Get merge commit
      const mergeCommit = await this.git('rev-parse HEAD');

      // Cleanup branch if configured
      if (this.config.cleanup.deleteMergedBranches) {
        await this.deleteBranch(branchName);
      }

      return {
        success: true,
        mode: 'direct',
        branch: branchName,
        mergeCommit,
      };
    } catch (error) {
      // Abort merge if in progress
      try {
        await this.git('merge --abort');
      } catch {
        // Not in merge state
      }

      return {
        success: false,
        mode: 'direct',
        branch: branchName,
        error: error instanceof Error ? error.message : 'Merge failed',
      };
    }
  }

  /**
   * Create a pull request using GitHub CLI.
   */
  async createPullRequest(branchName: string): Promise<IntegrationResult> {
    try {
      const prConfig = this.config.pullRequest;
      if (!prConfig) {
        throw new Error('Pull request configuration not set');
      }

      // Build labels argument
      const labelsArg = prConfig.labels.length > 0 ? `--label "${prConfig.labels.join(',')}"` : '';

      // Build reviewers argument
      const reviewersArg =
        prConfig.reviewers.length > 0 ? `--reviewer "${prConfig.reviewers.join(',')}"` : '';

      // Build draft argument
      const draftArg = prConfig.draft ? '--draft' : '';

      // Create PR using gh CLI
      const { stdout } = await execAsync(
        `gh pr create --base ${this.config.baseBranch} --head ${branchName} --title "auto: ${branchName}" --body "Autonomous improvement" ${labelsArg} ${reviewersArg} ${draftArg}`,
        { cwd: this.projectRoot, timeout: 30000 }
      );

      // Parse PR URL from output
      const prUrl = stdout.trim();
      const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
      const prNumber = prNumberMatch && prNumberMatch[1] ? parseInt(prNumberMatch[1], 10) : undefined;

      // Auto-merge if configured
      if (prConfig.autoMerge && prNumber) {
        try {
          await execAsync(`gh pr merge ${prNumber} --auto --merge`, {
            cwd: this.projectRoot,
            timeout: 30000,
          });
        } catch {
          // Auto-merge may require CI to pass first
        }
      }

      return {
        success: true,
        mode: 'pull_request',
        branch: branchName,
        pullRequestUrl: prUrl,
        pullRequestNumber: prNumber,
      };
    } catch (error) {
      return {
        success: false,
        mode: 'pull_request',
        branch: branchName,
        error: error instanceof Error ? error.message : 'PR creation failed',
      };
    }
  }

  // --------------------------------------------------------------------------
  // CLEANUP OPERATIONS
  // --------------------------------------------------------------------------

  /**
   * Revert a failed change (checkout base, delete branch).
   */
  async revert(branchName: string): Promise<void> {
    // Discard any local changes
    try {
      await this.git('checkout -- .');
    } catch {
      // No changes to discard
    }

    // Checkout base
    await this.git(`checkout ${this.config.baseBranch}`);

    // Delete the branch if configured
    if (this.config.cleanup.deleteFailedBranches) {
      await this.deleteBranch(branchName);
    }
  }

  /**
   * Clean up stale auto branches.
   */
  async cleanupStaleBranches(): Promise<string[]> {
    const deleted: string[] = [];
    const maxAgeMs = this.config.cleanup.maxStaleBranchAgeHours * 60 * 60 * 1000;
    const now = Date.now();

    const branches = await this.listAutoBranches();

    for (const branch of branches) {
      try {
        // Get branch's last commit timestamp
        const timestamp = await this.git(`log -1 --format="%ct" ${branch}`);
        const commitTime = parseInt(timestamp, 10) * 1000;

        if (now - commitTime > maxAgeMs) {
          await this.deleteBranch(branch);
          deleted.push(branch);
        }
      } catch {
        // Skip branches we can't check
      }
    }

    return deleted;
  }
}
