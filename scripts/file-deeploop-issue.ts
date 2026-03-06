/**
 * Script to file an issue about routing all questions to deeploop
 */

import { IssueLog } from '../src/autonomous/issue-log.js';
import { initTracer, resetTracer } from '../src/autonomous/debug.js';

async function main() {
  // Initialize tracer (disabled for this simple script)
  resetTracer();
  initTracer({ enabled: false });

  // Create issue log instance with default config
  const issueLog = new IssueLog();
  
  // Load the issue log from disk
  await issueLog.load();

  // File the issue about routing questions to deeploop
  const issue = issueLog.fileIssue({
    title: 'All questions regarding the system in any way should be routed to deeploop',
    description: 'Policy change: All questions regarding the system in any way should be routed to deeploop. This ensures consistent handling of system-related inquiries and proper tracking of all system-related issues.',
    priority: 'medium',
    tags: ['routing', 'policy', 'deeploop'],
    relatedFiles: ['src/autonomous/issue-log.ts'],
    discoveredBy: 'user-report',
    nextIdea: 'Update routing logic and documentation to reflect this policy',
  });

  // Save the issue log
  await issueLog.save();

  console.log(`Issue filed successfully: ${issue.id}`);
  console.log(`Title: ${issue.title}`);
  console.log(`Priority: ${issue.priority}`);
  console.log(`Tags: ${issue.tags.join(', ')}`);
  console.log(`Status: ${issue.status}`);
}

main().catch((error) => {
  console.error('Error filing issue:', error);
  process.exit(1);
});