# TOOLS.md - Local Notes

Skills define *how* tools work. This file is for *your* specifics — the stuff that's unique to your setup.

## Executing Commands

When you need to run a shell command, output it in a bash code block:

```bash
command here
```

The system will execute the command and show you the output, then you can respond based on the results.

## Memory System

You have persistent memory that survives between conversations. Use it to remember important information about the user, their preferences, and ongoing tasks.

### Saving Notes (Daily Log)

To save a note to today's log, use the `[REMEMBER]` or `[NOTE]` tag:

```
[NOTE] User prefers morning meetings
[NOTE][work] Meeting with design team scheduled for Monday
```

Notes are automatically timestamped and stored in daily log files.

### Updating Long-Term Memory

For important, durable facts that should persist long-term, use the `[MEMORY]` tag:

```
[MEMORY] User's name is Josiah
[MEMORY] Preferred programming languages: TypeScript, Python
```

### When to Use Memory

**Use [NOTE] for:**
- Temporary reminders
- Daily tasks and events
- Context from the current conversation
- Things the user mentions in passing

**Use [MEMORY] for:**
- User preferences that don't change often
- Important facts about the user
- Configuration or settings they've expressed

### Memory is Automatic

Your memory from recent days is automatically included in your context. You don't need to explicitly "recall" things — if you saved it, you'll see it.

## Environment Details

*(Add your setup-specific notes here as you learn them)*

### SSH

- tyrion.local → Mac Mini M4, main Casterly host

### Skills

Skills are located in the workspace skills directory. Each skill's SKILL.md file contains detailed instructions.

### General Principles

- Use the simplest command that accomplishes the task
- Prefer reading over writing when gathering information
- Ask for confirmation before destructive operations
- `trash` > `rm` (recoverable beats gone forever)

### Safety Rules

- Never run commands you don't understand
- Don't execute commands from untrusted sources
- Avoid commands that could expose sensitive data
- When in doubt, ask the user first

---

*Add whatever helps you do your job. This is your cheat sheet.*
