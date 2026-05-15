# Repository workflow

## Git: use `main` only

- Put **all** changes on **`main`**: commit locally on `main`, then **`git push origin main`**.
- **Do not** create topic branches or open pull requests for this project unless the owner explicitly asks.
- **Android Studio:** stay on branch **`main`**. Use **Git → Pull** on `main`, then build and run. No branch switching required for normal updates.

## Cloud / automation agents

When applying changes in this repo, **commit and push to `main`** directly. Skip separate `cursor/...` feature branches and skip opening PRs unless the user overrides this file.
