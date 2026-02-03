# Install Casterly On Host

## One-time setup

1. Build and install:
   - `npm run install:host`

2. Ensure the binary directory is on your PATH:
   - Add `~/.local/bin` to your shell PATH if it is not already.

## Run

- `casterly "your request here"`
- For provider execution: `casterly "your request here" --execute`

## Uninstall

- Remove the symlink: `rm ~/.local/bin/casterly`
