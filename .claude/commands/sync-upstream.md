Sync upstream HyperDX changes from hyperdxio/hyperdx main into the main-custom-msm branch.

## Steps

1. **Fetch upstream**: Run `git fetch hyperdxio main` to get latest changes from https://github.com/hyperdxio/hyperdx main branch.

2. **Ensure correct branch**: Verify we're on `main-custom-msm`. If not, check out `main-custom-msm`.

3. **Show incoming changes**: Run `git log --oneline main-custom-msm..hyperdxio/main | head -30` to preview what's coming in. Show this to the user.

4. **Merge**: Run `git merge hyperdxio/main --no-edit` to merge upstream main into main-custom-msm.

5. **Handle conflicts**: If merge conflicts occur:
   - List conflicted files with `git diff --name-only --diff-filter=U`
   - Show each conflict to the user
   - Follow the merge conflict resolution rules from AGENTS.md: never blindly pick a side, read both sides, verify result compiles
   - After resolving, run `make ci-lint` and `make ci-unit` to verify

6. **Report**: Show a summary of what was merged (commit count, files changed).
