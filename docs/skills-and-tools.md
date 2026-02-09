# Creating Skills and Tools

This guide explains how to create custom skills and define native tools for Casterly.

## Skills Overview

Skills extend Casterly's capabilities with domain-specific instructions and optional native tools. They are defined in `SKILL.md` files using YAML frontmatter and markdown content.

**Skill locations:**
- `~/.casterly/workspace/skills/` - User skills
- `skills/` - Project skills

## Basic Skill Structure

```
my-skill/
└── SKILL.md
```

### SKILL.md Format

```markdown
---
name: my-skill
description: Short description of what the skill does
homepage: https://example.com  # Optional
metadata:
  openclaw:
    emoji: "🔧"
    os: ["darwin", "linux"]  # Optional OS restrictions
    requires:
      bins: ["git", "npm"]   # Required binaries
      envVars: ["API_KEY"]   # Required environment variables
    install:
      - id: brew
        kind: brew
        formula: my-tool
        bins: ["my-tool"]
---

# My Skill

Instructions for the LLM on how to use this skill.

## Usage

Explain when and how to use the skill.

## Examples

\`\`\`bash
example-command --flag
\`\`\`
```

## Skill Frontmatter Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | `string` | Yes | Unique skill identifier |
| `description` | `string` | Yes | Short description |
| `homepage` | `string` | No | Project homepage URL |
| `metadata` | `object` | No | OpenClaw metadata |
| `tools` | `ToolSchema[]` | No | Native tool definitions |

### OpenClaw Metadata

```yaml
metadata:
  openclaw:
    emoji: "🎯"              # Display emoji
    os: ["darwin"]           # Supported platforms
    requires:
      bins: ["tool-name"]    # Required CLI tools
      envVars: ["ENV_VAR"]   # Required env vars
    install:
      - id: brew
        kind: brew
        formula: formula-name
```

## Adding Native Tools to Skills

Skills can define native tools that are registered when the skill loads. This enables structured tool calling instead of text-based command parsing.

### Tool Schema Format

```yaml
---
name: weather-skill
description: Get weather information
tools:
  - name: get_weather
    description: Get current weather for a location
    inputSchema:
      type: object
      properties:
        location:
          type: string
          description: City name or coordinates
        units:
          type: string
          description: Temperature units
          enum: ["celsius", "fahrenheit"]
      required:
        - location
---
```

### Complete Example with Tools

```yaml
---
name: file-manager
description: Manage files and directories
tools:
  - name: list_files
    description: List files in a directory
    inputSchema:
      type: object
      properties:
        path:
          type: string
          description: Directory path to list
        recursive:
          type: boolean
          description: Whether to list recursively
      required:
        - path

  - name: read_file
    description: Read contents of a file
    inputSchema:
      type: object
      properties:
        path:
          type: string
          description: Path to the file to read
        encoding:
          type: string
          description: File encoding
          enum: ["utf-8", "ascii", "base64"]
      required:
        - path

  - name: write_file
    description: Write content to a file
    inputSchema:
      type: object
      properties:
        path:
          type: string
          description: Path to write to
        content:
          type: string
          description: Content to write
        append:
          type: boolean
          description: Append instead of overwrite
      required:
        - path
        - content
---

# File Manager Skill

Manage files using native tool calls.

## When to use

Use this skill when the user asks to:
- List files in a directory
- Read file contents
- Create or modify files

## Notes

- Always confirm before overwriting existing files
- Use recursive listing sparingly on large directories
```

## Tool Property Types

| Type | Description | Example |
|------|-------------|---------|
| `string` | Text value | `"hello"` |
| `number` | Decimal number | `3.14` |
| `integer` | Whole number | `42` |
| `boolean` | True/false | `true` |
| `object` | Nested object | `{"key": "value"}` |
| `array` | List of items | `["a", "b", "c"]` |

### String Enums

Restrict string values to specific options:

```yaml
properties:
  color:
    type: string
    description: Color choice
    enum: ["red", "green", "blue"]
```

### Array Types

Define array item types:

```yaml
properties:
  tags:
    type: array
    description: List of tags
    items:
      type: string
      description: A tag
```

### Nested Objects

Define complex nested structures:

```yaml
properties:
  config:
    type: object
    description: Configuration options
    properties:
      enabled:
        type: boolean
        description: Whether enabled
      timeout:
        type: integer
        description: Timeout in seconds
    required:
      - enabled
```

## Skill Availability

Skills are automatically checked for availability based on their requirements:

1. **OS Check**: Skill is unavailable if `os` doesn't include current platform
2. **Binary Check**: Skill is unavailable if required `bins` aren't on PATH
3. **Env Check**: Skill is unavailable if required `envVars` aren't set

Unavailable skills are loaded but not included in the LLM context.

## Skill Registry API

Access skills programmatically:

```typescript
import { createSkillRegistry } from './skills';

const registry = createSkillRegistry();

// Get all available skills
const skills = registry.getAvailable();

// Get skill by ID
const skill = registry.get('my-skill');

// Get all tools from skills
const tools = registry.getTools();

// Get relevant instructions for a message
const instructions = registry.getRelevantSkillInstructions('send a message');
```

## Built-in Tools

Casterly includes these core tools:

### bash

Execute shell commands:

```typescript
{
  name: 'bash',
  description: 'Execute a shell command on the local system.',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute.'
      }
    },
    required: ['command']
  }
}
```

### route_decision

Used internally by the router:

```typescript
{
  name: 'route_decision',
  description: 'Declare your routing decision for the user request.',
  inputSchema: {
    type: 'object',
    properties: {
      route: {
        type: 'string',
        enum: ['local', 'cloud']
      },
      reason: {
        type: 'string'
      },
      confidence: {
        type: 'number'
      }
    },
    required: ['route', 'reason', 'confidence']
  }
}
```

## Creating Custom Tool Executors

To execute tools defined by skills, register custom executors:

```typescript
import { createToolOrchestrator } from './tools';

const orchestrator = createToolOrchestrator();

// Register a custom executor
orchestrator.registerExecutor({
  toolName: 'get_weather',
  async execute(call) {
    const { location, units } = call.input as { location: string; units?: string };

    // Implement tool logic
    const weather = await fetchWeather(location, units);

    return {
      toolCallId: call.id,
      success: true,
      output: JSON.stringify(weather),
    };
  },
});
```

## Best Practices

### Skill Instructions

1. **Be specific**: Clearly explain when and how to use the skill
2. **Include examples**: Show command patterns and expected outputs
3. **Document limitations**: Note what the skill cannot do
4. **Handle errors**: Explain how to recover from common failures

### Tool Definitions

1. **Descriptive names**: Use `get_weather` not `gw`
2. **Clear descriptions**: Explain what the tool does and when to use it
3. **Validate inputs**: Mark required fields and use enums where appropriate
4. **Keep it simple**: Prefer flat structures over deep nesting

### Security

1. **Validate all inputs** in your executor before using them
2. **Don't expose secrets** in tool outputs
3. **Use safety gates** for destructive operations
4. **Log carefully** - don't log sensitive tool inputs

## Troubleshooting

### Skill Not Loading

1. Check YAML frontmatter syntax (use a YAML validator)
2. Verify `name` and `description` are present
3. Check file location is correct

### Skill Shows as Unavailable

1. Check required binaries are installed: `which binary-name`
2. Check environment variables: `echo $ENV_VAR`
3. Check OS restriction matches current platform

### Tool Not Being Called

1. Verify tool schema is valid JSON Schema
2. Check tool is registered with orchestrator
3. Look at trace output for tool call attempts
4. Ensure model supports native tool use

### Tool Execution Fails

1. Check executor is registered for the tool name
2. Verify input validation in executor
3. Look at error message in tool result
4. Check safety gates aren't blocking execution
