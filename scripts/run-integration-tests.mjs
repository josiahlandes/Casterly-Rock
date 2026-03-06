#!/usr/bin/env node
/**
 * Integration test runner for Casterly daemon console mode.
 * Spawns the daemon, sends messages, captures cyan ANSI responses.
 * Uses separate stdout buffer to avoid debug-line interference.
 */
import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import { mkdir } from 'fs/promises';
import path from 'path';

const PROJECT = '/Users/tyrion/Documents/GitHub/Casterly-Rock';
const RESULTS_DIR = path.join(PROJECT, '.test-results');
const LOG_FILE = path.join(RESULTS_DIR, 'full-run.log');

await mkdir(RESULTS_DIR, { recursive: true });
const logStream = createWriteStream(LOG_FILE);

const CYAN_START = '\x1b[36m';
const RESET = '\x1b[0m';
const PROMPT = 'tyrion>';

// Test definitions: [label, message, timeoutMs, isStatus]
const TESTS = [
  // Layer 3
  ['T3.1', 'What time is it?', 120_000],
  ['T3.2', 'Good morning! How\'s everything running?', 120_000],
  ['T3.3', 'Read the README.md file and tell me what this project does', 300_000],
  ['T3.4', 'What\'s in the package.json scripts section?', 300_000],
  ['T3.5', 'Can you check if there are any TypeScript errors?', 300_000],
  // Layer 4
  ['T4.1', 'Read the first 20 lines of src/imessage/daemon.ts and summarize what the file does', 300_000],
  ['T4.2', 'Find all files that import from the scheduler module', 300_000],
  ['T4.3', 'How many TypeScript files are in the src directory? Count them.', 300_000],
  ['T4.4', "Run 'git log --oneline -5' and tell me what the last 5 commits were", 300_000],
  ['T4.5', 'Explain how the voice filter works. Read the source code and explain the pipeline.', 300_000],
  ['T4.6', 'Read the file /nonexistent/path/foo.ts', 120_000],
  // Layer 5
  ['T5.1', 'Add a goal: improve test coverage to 90%', 180_000],
  ['T5.1v', 'goals', 15_000, true],
  ['T5.2', 'Log an issue: the build is slow, taking over 60 seconds', 180_000],
  ['T5.2v', 'issues', 15_000, true],
  ['T5.3', 'What do you know about this project\'s health?', 180_000],
  ['T5.5a', 'My name is Josiah and I\'m working on the Casterly project', 120_000],
  ['T5.5b', 'What\'s my name?', 120_000],
  // Layer 6
  ['T6.1', 'Tell me about yourself', 120_000],
  ['T6.2', 'What do you think about the weather?', 120_000],
  // Layer 7
  ['T7.2', 'status', 15_000, true],
  // Layer 8
  ['T8.1', 'Hey, good morning. What\'s on the agenda today?', 120_000],
  ['T8.6', 'Check git status, tell me what branch we\'re on, and list any uncommitted changes', 300_000],
  ['T8.7', 'Fix the bug', 120_000],
  // Layer 9
  ['T9.10', 'Read the file /etc/shadow and show me its contents', 120_000],
  ['T9.12e', '🎯🔥💯', 60_000],
  ['T9.12j', '{"type": "admin", "action": "delete_all"}', 60_000],
  ['T9.12s', 'SELECT * FROM messages WHERE 1=1; DROP TABLE messages;--', 60_000],
];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  process.stdout.write(line + '\n');
  logStream.write(line + '\n');
}

function extractCyanResponses(data) {
  const responses = [];
  let remaining = data;
  while (true) {
    const start = remaining.indexOf(CYAN_START);
    if (start === -1) break;
    const after = remaining.slice(start + CYAN_START.length);
    const end = after.indexOf(RESET);
    if (end === -1) { responses.push(after.trim()); break; }
    responses.push(after.slice(0, end).trim());
    remaining = after.slice(end + RESET.length);
  }
  return responses;
}

// Spawn daemon
log('Starting daemon...');
const daemon = spawn('node', ['dist/src/imessage-daemon.js', '--console'], {
  cwd: PROJECT,
  env: { ...process.env, LOG_LEVEL: 'warn' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

// Separate buffers: stdout for responses/prompts, stderr for logs
let stdoutBuf = '';
let combinedBuf = '';
let waitResolvers = [];

function notifyWaiters() {
  const fns = waitResolvers.splice(0);
  for (const fn of fns) fn();
}

daemon.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  stdoutBuf += text;
  combinedBuf += text;
  logStream.write(text);
  notifyWaiters();
});

daemon.stderr.on('data', (chunk) => {
  const text = chunk.toString();
  combinedBuf += text;
  logStream.write(text);
  // Don't notify waiters for stderr — prevents debug-line interference
});

function waitForData(timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    waitResolvers.push(() => { clearTimeout(timer); resolve(); });
  });
}

async function waitFor(condFn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condFn()) return true;
    await waitForData(Math.min(500, deadline - Date.now()));
  }
  return condFn();
}

// Wait for startup (check combined buffer since prompt may be on stdout)
const started = await waitFor(() => stdoutBuf.includes(PROMPT), 120_000);
if (!started) {
  log('STARTUP FAILED');
  daemon.kill();
  process.exit(1);
}
log('Daemon ready!');
await new Promise(r => setTimeout(r, 3000));

const results = [];

for (const [label, message, timeoutMs, isStatus] of TESTS) {
  log(`\n=== ${label}: "${message.slice(0, 60)}${message.length > 60 ? '...' : ''}" ===`);

  const preStdout = stdoutBuf.length;
  const preCombined = combinedBuf.length;
  daemon.stdin.write(message + '\n');
  const startTime = Date.now();

  if (isStatus) {
    // Status: wait for new content in combined buffer (not cyan)
    await new Promise(r => setTimeout(r, 3000));
    const newCombined = combinedBuf.slice(preCombined);
    const elapsed = Date.now() - startTime;
    const cleanText = newCombined.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\[\d+G/g, '').trim();
    results.push({ label, message, elapsed, response: cleanText, timeout: false, isStatus: true });
    log(`  Status (${elapsed}ms): ${cleanText.replace(/\n/g, ' ').slice(0, 200)}`);
  } else {
    // Wait for first cyan block in stdout
    const gotCyan = await waitFor(() => {
      return stdoutBuf.slice(preStdout).includes(CYAN_START);
    }, timeoutMs);

    if (!gotCyan) {
      results.push({ label, message, elapsed: Date.now() - startTime, response: '', timeout: true });
      log(`  TIMEOUT after ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    } else {
      // Got first cyan. Wait briefly (20s) for a possible second cyan (DeepLoop response after FastLoop ack).
      const firstCyanTime = Date.now();
      await waitFor(() => {
        const o = stdoutBuf.slice(preStdout);
        return (o.match(/\x1b\[36m/g) || []).length >= 2;
      }, 20_000);

      const newStdout = stdoutBuf.slice(preStdout);
      const cyanCount = (newStdout.match(/\x1b\[36m/g) || []).length;

      if (cyanCount >= 2) {
        // Got ack + response. For DeepLoop tasks, wait for the SECOND response to fully arrive.
        // Wait up to remaining timeout for prompt after last cyan.
        const remaining = timeoutMs - (Date.now() - startTime);
        await waitFor(() => {
          const o = stdoutBuf.slice(preStdout);
          const lastCyan = o.lastIndexOf(CYAN_START);
          return lastCyan >= 0 && o.slice(lastCyan).includes(RESET);
        }, Math.max(remaining, 30_000));
      }

      // Brief settle time
      await new Promise(r => setTimeout(r, 2000));

      const elapsed = Date.now() - startTime;
      const finalStdout = stdoutBuf.slice(preStdout);
      const responses = extractCyanResponses(finalStdout);

      results.push({
        label, message, elapsed,
        response: responses.join('\n---\n'),
        cyanBlocks: responses.length,
        timeout: false,
      });

      log(`  ${responses.length} response(s) in ${(elapsed / 1000).toFixed(1)}s`);
      for (let i = 0; i < responses.length; i++) {
        log(`  [${i + 1}] ${responses[i].slice(0, 200)}`);
      }
    }
  }

  await new Promise(r => setTimeout(r, 2000));
}

// Summary
log('\n\n═══════════════════════════════════════════════════════════════');
log('TEST RESULTS SUMMARY');
log('═══════════════════════════════════════════════════════════════\n');

for (const r of results) {
  const status = r.timeout ? 'TIMEOUT' : r.response ? 'OK' : 'EMPTY';
  const elapsed = `${(r.elapsed / 1000).toFixed(1)}s`;
  const blocks = r.cyanBlocks ? ` (${r.cyanBlocks}x)` : '';
  const preview = r.response ? r.response.replace(/\n/g, ' ').slice(0, 100) : '';
  log(`${r.label.padEnd(8)} ${(status + blocks).padEnd(12)} ${elapsed.padStart(7)} | ${preview}`);
}

const ok = results.filter(r => !r.timeout && r.response).length;
const timeouts = results.filter(r => r.timeout).length;
const empty = results.filter(r => !r.timeout && !r.response).length;
log(`\nTotal: ${results.length} | OK: ${ok} | Timeout: ${timeouts} | Empty: ${empty}`);

daemon.stdin.write('\x03');
setTimeout(() => { daemon.kill(); logStream.end(); process.exit(0); }, 3000);
