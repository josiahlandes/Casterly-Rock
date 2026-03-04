#!/bin/bash

# Git workflow to commit stashed files to main branch with overwrite capability
# This script handles stash operations, force push, and error handling

set -e  # Exit on error

# Configuration
MAIN_BRANCH="main"
STASH_INDEX="${1:-0}"  # Default to first stash if not specified

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Error handling function
handle_error() {
    log_error "An error occurred on line $1"
    log_error "Cleaning up..."
    
    # Check if we're in a merge conflict state
    if [ -f ".git/MERGE_HEAD" ]; then
        log_warn "Merge conflict detected. Aborting merge..."
        git merge --abort 2>/dev/null || true
    fi
    
    # Restore working directory
    git stash pop 2>/dev/null || true
    
    exit 1
}

trap 'handle_error $LINENO' ERR

# Check if stash exists
check_stash_exists() {
    local stash_list=$(git stash list)
    if [ -z "$stash_list" ]; then
        log_error "No stashes found in repository"
        exit 1
    fi
    
    if ! echo "$stash_list" | grep -q "stash@{$STASH_INDEX}"; then
        log_error "Stash index $STASH_INDEX does not exist"
        log_info "Available stashes:"
        echo "$stash_list"
        exit 1
    fi
    
    log_info "Stash $STASH_INDEX exists and is ready to apply"
}

# Check current branch
check_current_branch() {
    local current_branch=$(git branch --show-current)
    if [ "$current_branch" != "$MAIN_BRANCH" ]; then
        log_warn "Currently on branch '$current_branch', switching to '$MAIN_BRANCH'"
        git checkout "$MAIN_BRANCH" || {
            log_error "Failed to switch to $MAIN_BRANCH"
            exit 1
        }
    fi
    log_info "Currently on $MAIN_BRANCH branch"
}

# Pull latest changes from remote
pull_latest() {
    log_info "Pulling latest changes from remote..."
    if ! git pull origin "$MAIN_BRANCH" --rebase; then
        log_error "Failed to pull latest changes"
        exit 1
    fi
    log_info "Successfully pulled latest changes"
}

# Apply stash with conflict handling
apply_stash() {
    log_info "Applying stash $STASH_INDEX..."
    
    if ! git stash apply "stash@{$STASH_INDEX}"; then
        log_error "Failed to apply stash. Possible merge conflict detected."
        
        # Check for conflicts
        if [ -f ".git/MERGE_HEAD" ]; then
            log_warn "Merge conflicts detected in stash application"
            log_info "Conflicted files:"
            git diff --name-only --diff-filter=U
            
            log_error "Stash application failed due to conflicts"
            log_info "To resolve manually:"
            log_info "  1. Edit the conflicted files"
            log_info "  2. git add <resolved_files>"
            log_info "  3. git stash drop stash@{$STASH_INDEX}"
            log_info "  4. git commit"
            exit 1
        fi
        
        exit 1
    fi
    
    log_info "Stash applied successfully"
}

# Commit changes
commit_changes() {
    local commit_message="${1:-Apply stashed changes}"
    
    # Check if there are any changes to commit
    if [ -z "$(git diff --cached)" ] && [ -z "$(git diff)" ]; then
        log_warn "No changes to commit. Stash may have been empty or already applied."
        return 0
    fi
    
    log_info "Committing changes..."
    git add .
    
    if ! git commit -m "$commit_message"; then
        log_error "Failed to commit changes"
        exit 1
    fi
    
    log_info "Changes committed successfully"
}

# Force push to main
force_push() {
    local force="${1:-false}"
    
    log_info "Pushing to $MAIN_BRANCH..."
    
    if [ "$force" = "true" ]; then
        log_warn "Force push enabled - this will overwrite remote history!"
        read -p "Are you sure you want to force push? (yes/no): " confirm
        if [ "$confirm" != "yes" ]; then
            log_warn "Force push cancelled"
            return 0
        fi
        
        if ! git push --force-with-lease origin "$MAIN_BRANCH"; then
            log_error "Force push failed"
            exit 1
        fi
        log_info "Force push completed successfully"
    else
        if ! git push origin "$MAIN_BRANCH"; then
            log_error "Push failed. Remote may have new changes."
            log_info "Consider using --force-with-lease if you need to overwrite"
            exit 1
        fi
        log_info "Push completed successfully"
    fi
}

# Drop stash after successful commit
drop_stash() {
    log_info "Dropping stash $STASH_INDEX..."
    if git stash drop "stash@{$STASH_INDEX}"; then
        log_info "Stash dropped successfully"
    else
        log_warn "Failed to drop stash (may already be dropped)"
    fi
}

# Main workflow
main() {
    local force_push_flag="${1:-false}"
    local commit_msg="${2:-Apply stashed changes}"
    
    log_info "=== Git Stash to Main Workflow ==="
    log_info "Stash Index: $STASH_INDEX"
    log_info "Force Push: $force_push_flag"
    log_info "Commit Message: $commit_msg"
    echo ""
    
    # Step 1: Check if stash exists
    check_stash_exists
    
    # Step 2: Ensure we're on main branch
    check_current_branch
    
    # Step 3: Pull latest changes
    pull_latest
    
    # Step 4: Apply stash
    apply_stash
    
    # Step 5: Commit changes
    commit_changes "$commit_msg"
    
    # Step 6: Push to remote
    force_push "$force_push_flag"
    
    # Step 7: Drop stash (only if we have changes committed)
    if [ -n "$(git diff HEAD~1 --name-only)" ]; then
        drop_stash
    else
        log_info "No new commits made, keeping stash intact"
    fi
    
    log_info "=== Workflow completed successfully ==="
}

# Parse command line arguments
FORCE_PUSH="false"
COMMIT_MSG="Apply stashed changes"

while [[ $# -gt 0 ]]; do
    case $1 in
        --force|-f)
            FORCE_PUSH="true"
            shift
            ;;
        --message|-m)
            COMMIT_MSG="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --force, -f       Force push to remote (overwrites history)"
            echo "  --message, -m     Custom commit message"
            echo "  --help, -h        Show this help message"
            echo ""
            echo "Environment:"
            echo "  STASH_INDEX       Stash index to apply (default: 0)"
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Run main workflow
main "$FORCE_PUSH" "$COMMIT_MSG"