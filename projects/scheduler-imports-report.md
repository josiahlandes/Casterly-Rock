# Scheduler Module Import Report

## Overview
This report lists all files in the codebase that import from the scheduler module (`src/scheduler/`).

## Files Importing from Scheduler

### Source Files (Non-Test)

| File | Import Statement | Imported Items |
|------|------------------|----------------|
| `src/pipeline/process.ts` | `from '../scheduler/index.js'` | Multiple exports from scheduler index |
| `src/imessage/daemon.ts` | `from '../scheduler/index.js'` | Multiple exports from scheduler index |
| `src/autonomous/tools/types.ts` | `from '../../scheduler/store.js'` | `JobStore` (type) |
| `src/autonomous/loop.ts` | `from '../scheduler/store.js'` | `JobStore` (type) |
| `src/autonomous/agent-tools.ts` | `from '../scheduler/store.js'` | `JobStore` (type) |

### Test Files

| File | Import Statement | Imported Items |
|------|------------------|----------------|
| `tests/scheduler-executor.test.ts` | `from '../src/scheduler/executor.js'` | `createSchedulerExecutors` |
| `tests/scheduler-executor.test.ts` | `from '../src/scheduler/store.js'` | `JobStore` (type) |
| `tests/scheduler-executor.test.ts` | `from '../src/scheduler/types.js'` | `ScheduledJob` (type) |
| `tests/scheduler-trigger.test.ts` | `from '../src/scheduler/trigger.js'` | Various exports from trigger |
| `tests/scheduler-tools.test.ts` | `from '../src/scheduler/tools.js'` | Various exports from tools |
| `tests/scheduler-cron.test.ts` | `from '../src/scheduler/cron.js'` | Various exports from cron |
| `tests/scheduler-cron-trigger.test.ts` | `from '../src/scheduler/cron.js'` | Various exports from cron |
| `tests/scheduler-cron-trigger.test.ts` | `from '../src/scheduler/trigger.js'` | Various exports from trigger |
| `tests/planner-tool-params.test.ts` | `from '../src/scheduler/tools.js'` | `SCHEDULE_REMINDER_TOOL`, `LIST_REMINDERS_TOOL`, `CANCEL_REMINDER_TOOL` |
| `tests/tool-schemas.test.ts` | `from '../src/scheduler/tools.js'` | `SCHEDULE_REMINDER_TOOL`, `LIST_REMINDERS_TOOL`, `CANCEL_REMINDER_TOOL`, `getSchedulerToolSchemas` |
| `tests/scheduler-store.test.ts` | `from '../src/scheduler/store.js'` | `createJobStore`, `JobStore` (type) |
| `tests/scheduler-store.test.ts` | `from '../src/scheduler/types.js'` | `ScheduledJob` (type) |
| `tests/scheduler-checker.test.ts` | `from '../src/scheduler/checker.js'` | `checkDueJobs`, `MessageSender`, `ActionableHandler` |
| `tests/scheduler-checker.test.ts` | `from '../src/scheduler/store.js'` | `createJobStore`, `JobStore` (type) |
| `tests/scheduler-checker.test.ts` | `from '../src/scheduler/types.js'` | `ScheduledJob` (type) |

## Summary

- **Total files importing from scheduler**: 18 files
- **Source files (non-test)**: 5 files
- **Test files**: 13 files

### Most Common Imports

1. **`scheduler/tools.js`** - 4 files (tool schemas)
2. **`scheduler/store.js`** - 6 files (JobStore type and createJobStore)
3. **`scheduler/types.js`** - 3 files (ScheduledJob type)
4. **`scheduler/index.js`** - 2 files (full module exports)

## Scheduler Module Structure

The scheduler module (`src/scheduler/`) exports the following:

- **types.ts** - Type definitions (TriggerType, JobStatus, JobSource, ScheduledJob, etc.)
- **cron.ts** - Cron expression parsing and validation
- **trigger.ts** - Job creation and time parsing
- **store.ts** - Job storage factory (createJobStore)
- **tools.ts** - Tool schemas (SCHEDULE_REMINDER_TOOL, etc.)
- **executor.ts** - Tool executors (createSchedulerExecutors)
- **checker.ts** - Due job checking (checkDueJobs)
- **index.ts** - Barrel export file combining all exports