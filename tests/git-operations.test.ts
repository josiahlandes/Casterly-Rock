import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import { GitOperations } from '../src/autonomous/git.js';

// ─── Temp repo helpers ───────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-git-ops-test-${Date.now()}`);

function makeGitConfig() {
  return {
    remote: 'origin',
    baseBranch: 'main',
    branchPrefix: 'auto/',
    integrationMode: 'direct' as const,
    cleanup: {
      deleteMergedBranches: true,
      deleteFailedBranches: true,
      maxStaleBranchAgeHours: 48,
    },
  };
}

/**
 * Create a fresh git repo with an initial commit.
 * Returns the repo path.
 */
function initRepo(name: string): string {
  const repoPath = join(TEST_BASE, name);
  mkdirSync(repoPath, { recursive: true });
  execSync('git init --initial-branch=main', { cwd: repoPath });
  execSync('git config user.email "test@test.com"', { cwd: repoPath });
  execSync('git config user.name "Test"', { cwd: repoPath });
  writeFileSync(join(repoPath, 'README.md'), '# Test\n');
  execSync('git add -A && git commit -m "initial commit"', { cwd: repoPath });
  return repoPath;
}

/**
 * Create a bare remote and wire it up as 'origin' for the given repo.
 */
function addBareRemote(repoPath: string): string {
  const barePath = repoPath + '-bare';
  execSync(`git clone --bare "${repoPath}" "${barePath}"`);
  execSync(`git remote add origin "${barePath}"`, { cwd: repoPath });
  return barePath;
}

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GitOperations — getCurrentBranch
// ═══════════════════════════════════════════════════════════════════════════════

describe('GitOperations — getCurrentBranch', () => {
  it('returns main on fresh repo', async () => {
    const repo = initRepo('branch-main');
    const git = new GitOperations(repo, makeGitConfig());
    const branch = await git.getCurrentBranch();
    expect(branch).toBe('main');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GitOperations — isClean
// ═══════════════════════════════════════════════════════════════════════════════

describe('GitOperations — isClean', () => {
  it('returns true on clean repo', async () => {
    const repo = initRepo('clean-yes');
    const git = new GitOperations(repo, makeGitConfig());
    expect(await git.isClean()).toBe(true);
  });

  it('returns false with uncommitted changes', async () => {
    const repo = initRepo('clean-no');
    writeFileSync(join(repo, 'dirty.txt'), 'dirty');
    const git = new GitOperations(repo, makeGitConfig());
    expect(await git.isClean()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GitOperations — createBranch
// ═══════════════════════════════════════════════════════════════════════════════

describe('GitOperations — createBranch', () => {
  it('creates a branch with the configured prefix', async () => {
    const repo = initRepo('create-branch');
    addBareRemote(repo);
    const git = new GitOperations(repo, makeGitConfig());
    const branchName = await git.createBranch('hyp-001');
    expect(branchName).toBe('auto/hyp-001');
    const current = await git.getCurrentBranch();
    expect(current).toBe('auto/hyp-001');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GitOperations — branchExists
// ═══════════════════════════════════════════════════════════════════════════════

describe('GitOperations — branchExists', () => {
  it('returns true for existing local branch', async () => {
    const repo = initRepo('exists-yes');
    execSync('git checkout -b test-branch', { cwd: repo });
    execSync('git checkout main', { cwd: repo });
    const git = new GitOperations(repo, makeGitConfig());
    expect(await git.branchExists('test-branch')).toBe(true);
  });

  it('returns false for nonexistent branch', async () => {
    const repo = initRepo('exists-no');
    const git = new GitOperations(repo, makeGitConfig());
    expect(await git.branchExists('does-not-exist')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GitOperations — listAutoBranches
// ═══════════════════════════════════════════════════════════════════════════════

describe('GitOperations — listAutoBranches', () => {
  it('lists branches with the auto/ prefix', async () => {
    const repo = initRepo('list-auto');
    execSync('git checkout -b auto/fix-1', { cwd: repo });
    execSync('git checkout main', { cwd: repo });
    execSync('git checkout -b auto/fix-2', { cwd: repo });
    execSync('git checkout main', { cwd: repo });
    execSync('git checkout -b feature/not-auto', { cwd: repo });
    execSync('git checkout main', { cwd: repo });

    const git = new GitOperations(repo, makeGitConfig());
    const branches = await git.listAutoBranches();
    expect(branches.length).toBe(2);
    expect(branches).toContain('auto/fix-1');
    expect(branches).toContain('auto/fix-2');
  });

  it('returns empty when no auto branches exist', async () => {
    const repo = initRepo('list-empty');
    const git = new GitOperations(repo, makeGitConfig());
    const branches = await git.listAutoBranches();
    expect(branches.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GitOperations — deleteBranch
// ═══════════════════════════════════════════════════════════════════════════════

describe('GitOperations — deleteBranch', () => {
  it('deletes a local branch', async () => {
    const repo = initRepo('delete-branch');
    execSync('git checkout -b to-delete', { cwd: repo });
    execSync('git checkout main', { cwd: repo });

    const git = new GitOperations(repo, makeGitConfig());
    await git.deleteBranch('to-delete');
    expect(await git.branchExists('to-delete')).toBe(false);
  });

  it('switches away before deleting current branch', async () => {
    const repo = initRepo('delete-current');
    addBareRemote(repo);
    execSync('git checkout -b temp-branch', { cwd: repo });

    const git = new GitOperations(repo, makeGitConfig());
    await git.deleteBranch('temp-branch');
    const current = await git.getCurrentBranch();
    expect(current).toBe('main');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GitOperations — applyChanges
// ═══════════════════════════════════════════════════════════════════════════════

describe('GitOperations — applyChanges', () => {
  it('creates new files', async () => {
    const repo = initRepo('apply-create');
    const git = new GitOperations(repo, makeGitConfig());
    await git.applyChanges([
      { path: 'src/newfile.ts', type: 'create', diff: 'const x = 1;\n' },
    ]);
    expect(existsSync(join(repo, 'src', 'newfile.ts'))).toBe(true);
    expect(readFileSync(join(repo, 'src', 'newfile.ts'), 'utf-8')).toBe('const x = 1;\n');
  });

  it('modifies existing files', async () => {
    const repo = initRepo('apply-modify');
    writeFileSync(join(repo, 'file.ts'), 'old');
    const git = new GitOperations(repo, makeGitConfig());
    await git.applyChanges([
      { path: 'file.ts', type: 'modify', diff: 'new' },
    ]);
    expect(readFileSync(join(repo, 'file.ts'), 'utf-8')).toBe('new');
  });

  it('deletes files', async () => {
    const repo = initRepo('apply-delete');
    writeFileSync(join(repo, 'remove-me.ts'), 'bye');
    const git = new GitOperations(repo, makeGitConfig());
    await git.applyChanges([
      { path: 'remove-me.ts', type: 'delete' },
    ]);
    expect(existsSync(join(repo, 'remove-me.ts'))).toBe(false);
  });

  it('handles multiple changes at once', async () => {
    const repo = initRepo('apply-multi');
    writeFileSync(join(repo, 'existing.ts'), 'original');
    const git = new GitOperations(repo, makeGitConfig());
    await git.applyChanges([
      { path: 'brand-new.ts', type: 'create', diff: 'created\n' },
      { path: 'existing.ts', type: 'modify', diff: 'modified\n' },
    ]);
    expect(readFileSync(join(repo, 'brand-new.ts'), 'utf-8')).toBe('created\n');
    expect(readFileSync(join(repo, 'existing.ts'), 'utf-8')).toBe('modified\n');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GitOperations — commit
// ═══════════════════════════════════════════════════════════════════════════════

describe('GitOperations — commit', () => {
  it('stages and commits changes', async () => {
    const repo = initRepo('commit-basic');
    writeFileSync(join(repo, 'new.ts'), 'content');
    const git = new GitOperations(repo, makeGitConfig());
    const hash = await git.commit('test commit');
    expect(hash).toBeTruthy();
    expect(hash.length).toBeGreaterThanOrEqual(7);
    // Working tree should be clean now
    expect(await git.isClean()).toBe(true);
  });

  it('throws when there are no changes to commit', async () => {
    const repo = initRepo('commit-empty');
    const git = new GitOperations(repo, makeGitConfig());
    await expect(git.commit('empty')).rejects.toThrow('No changes to commit');
  });

  it('commits specific files when provided', async () => {
    const repo = initRepo('commit-specific');
    writeFileSync(join(repo, 'a.ts'), 'aaa');
    writeFileSync(join(repo, 'b.ts'), 'bbb');
    const git = new GitOperations(repo, makeGitConfig());
    await git.commit('only a', ['a.ts']);
    // a.ts should be committed, b.ts should still be untracked
    const clean = await git.isClean();
    expect(clean).toBe(false); // b.ts is still untracked
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GitOperations — push
// ═══════════════════════════════════════════════════════════════════════════════

describe('GitOperations — push', () => {
  it('pushes to remote', async () => {
    const repo = initRepo('push-test');
    addBareRemote(repo);
    writeFileSync(join(repo, 'pushed.ts'), 'content');
    const git = new GitOperations(repo, makeGitConfig());
    await git.commit('to push');
    await git.push('main');
    // Verify push succeeded by checking remote log
    const bareLog = execSync('git log --oneline', { cwd: repo + '-bare', encoding: 'utf-8' });
    expect(bareLog).toContain('to push');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GitOperations — integrate (direct merge)
// ═══════════════════════════════════════════════════════════════════════════════

describe('GitOperations — integrate', () => {
  it('merges branch directly when integration mode is direct', async () => {
    const repo = initRepo('integrate-direct');
    addBareRemote(repo);
    // Push main to remote first
    execSync('git push -u origin main', { cwd: repo });

    // Create a feature branch with a change
    execSync('git checkout -b auto/test-feat', { cwd: repo });
    writeFileSync(join(repo, 'feature.ts'), 'feature code');
    execSync('git add -A && git commit -m "add feature"', { cwd: repo });
    execSync('git push -u origin auto/test-feat', { cwd: repo });
    execSync('git checkout main', { cwd: repo });

    const git = new GitOperations(repo, makeGitConfig());
    const result = await git.integrate('auto/test-feat');

    expect(result.success).toBe(true);
    expect(result.mode).toBe('direct');
    expect(result.branch).toBe('auto/test-feat');
    expect(result.mergeCommit).toBeTruthy();
  });

  it('returns failure on merge conflict', async () => {
    const repo = initRepo('integrate-conflict');
    addBareRemote(repo);
    execSync('git push -u origin main', { cwd: repo });

    // Create a branch that modifies README
    execSync('git checkout -b auto/conflict', { cwd: repo });
    writeFileSync(join(repo, 'README.md'), '# Conflict version A\n');
    execSync('git add -A && git commit -m "branch change"', { cwd: repo });
    execSync('git checkout main', { cwd: repo });

    // Create a conflicting change on main
    writeFileSync(join(repo, 'README.md'), '# Conflict version B\n');
    execSync('git add -A && git commit -m "main change"', { cwd: repo });
    execSync('git push origin main', { cwd: repo });

    const git = new GitOperations(repo, makeGitConfig());
    const result = await git.integrate('auto/conflict');

    expect(result.success).toBe(false);
    expect(result.mode).toBe('direct');
    expect(result.error).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GitOperations — revert
// ═══════════════════════════════════════════════════════════════════════════════

describe('GitOperations — revert', () => {
  it('reverts to base branch', async () => {
    const repo = initRepo('revert-basic');
    addBareRemote(repo);
    execSync('git push -u origin main', { cwd: repo });

    const git = new GitOperations(repo, makeGitConfig());
    const branch = await git.createBranch('revert-test');
    // Add a tracked change (must be committed) then add a dirty change
    writeFileSync(join(repo, 'tracked.ts'), 'tracked content');
    execSync('git add -A && git commit -m "tracked change"', { cwd: repo });

    await git.revert(branch);
    const current = await git.getCurrentBranch();
    expect(current).toBe('main');
    // Branch should have been cleaned up (deleteFailedBranches=true)
    expect(await git.branchExists('auto/revert-test')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GitOperations — fetchLatest and checkoutBase
// ═══════════════════════════════════════════════════════════════════════════════

describe('GitOperations — fetchLatest & checkoutBase', () => {
  it('fetchLatest does not throw with valid remote', async () => {
    const repo = initRepo('fetch-ok');
    addBareRemote(repo);
    execSync('git push -u origin main', { cwd: repo });

    const git = new GitOperations(repo, makeGitConfig());
    await expect(git.fetchLatest()).resolves.not.toThrow();
  });

  it('checkoutBase switches to main', async () => {
    const repo = initRepo('checkout-base');
    addBareRemote(repo);
    execSync('git push -u origin main', { cwd: repo });
    execSync('git checkout -b other-branch', { cwd: repo });

    const git = new GitOperations(repo, makeGitConfig());
    await git.checkoutBase();
    const current = await git.getCurrentBranch();
    expect(current).toBe('main');
  });
});
