## Pull Request Title
merge {source_branch} into {target_branch}

---

## Description
This pull request includes the following changes:

> Replace the example below with the actual list of commits included in this PR.

- [docs] 📝 update doc with backend calls to manteca
- [build] 🐛 fix Cloud Build error caused by '.' instead of ','
- [build] 🐛 fix Cloud Build manteca_api_key defined more than once
- [feat] ✨ add support routes

> **Note:** Task IDs should not be included in commit messages.

---

## Checklist
- [ ] **Code Formatting**: Ran `yarn format` to ensure code follows the project's style guide.
- [ ] **Linting**: Fixed linting issues locally using `yarn lint:fix`.
- [ ] **Tests**: Executed all tests and ensured they pass locally using `yarn test`.
- [ ] **Docker Build**: Verified the Docker image compiles successfully using `yarn docker:build`.
- [ ] **Task Linking**: Confirmed the associated tasks/issues have the branch linked under the **"Development"** section in the right sidebar of the issue.
- [ ] **Configuration Updates**:
  - If environment variables were added, modified, or removed:
    - [ ] Updated the GCP environments accordingly.
    - [ ] Notified the development team in Discord about the changes.
- [ ] **Documentation**: Updated documentation if applicable.
- [ ] **Breaking Changes**: Confirmed no breaking changes were introduced.
