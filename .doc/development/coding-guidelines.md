# Coding guidelines

## Configuring Git's line ending handling

This configuration converts LF to CRLF when checking out on Windows systems and CRLF to LF when committing.

```sh
# Global Configuration: Applies the settings to all repositories on your system.
git config --global core.autocrlf true
```

```sh
# Local Configuration: Applies the settings only to the current repository.
git config core.autocrlf true
```

## Commit changes

It is recommended to use a linter for commit messages, which should follow the format below:

```sh
- [type] message
- [type] :icono: message
```

Example:

```sh
- commit -m [chore] add commitlinter
- commit -m [chore] :sparkles: add commitlinter (to commit with an icon, you can use [gitmoji](https://gitmoji.dev/))
```

The allowed standard types are:

```sh
- feat: A new feature for the user.
- fix: Fixes a bug that affects the user.
- perf: Changes that improve site performance.
- build: Changes in the build system, deployment tasks, or installation.
- ci: Changes in continuous integration.
- docs: Changes in documentation.
- refactor: Code refactoring such as renaming variables or functions.
- style: Changes in formatting, tabs, spaces, or semicolons, etc.; does not affect the user.
- test: Adds tests or refactors an existing one.
- chore: Other changes that don't modify src or test files.
- revert: Reverts a previous commit
```

## Example Icons to use in commit

Here’s the list formatted with the emoji codes to use in commits messages:

- 🎨 :art: Improve structure / format of the code.
- ⚡️ :zap: Improve performance.
- 🔥 :fire: Remove code or files.
- 🐛 :bug: Fix a bug.
- 🚑️ :ambulance: Critical hotfix.
- ✨ :sparkles: Introduce new features.
- 📝 :memo: Add or update documentation.
- 🚀 :rocket: Deploy stuff.
- 💄 :lipstick: Add or update the UI and style files.
- 🎉 :tada: Begin a project.
- ✅ :white_check_mark: Add, update, or pass tests.
- 🔒️ :lock: Fix security or privacy issues.
- 🔐 :closed_lock_with_key: Add or update secrets.
- 🔖 :bookmark: Release / Version tags.
- 🚨 :rotating_light: Fix compiler / linter warnings.
- 🚧 :construction: Work in progress.
- 💚 :green_heart: Fix CI Build.
- ⬇️ :arrow_down: Downgrade dependencies.
- ⬆️ :arrow_up: Upgrade dependencies.
- 📌 :pushpin: Pin dependencies to specific versions.
- 👷 :construction_worker: Add or update CI build system.
- 📈 :chart_with_upwards_trend: Add or update analytics or track code.
- ♻️ :recycle: Refactor code.
- ➕ :heavy_plus_sign: Add a dependency.
- ➖ :heavy_minus_sign: Remove a dependency.
- 🔧 :wrench: Add or update configuration files.
- 🔨 :hammer: Add or update development scripts.
- 🌐 :globe_with_meridians: Internationalization and localization.
- ✏️ :pencil2: Fix typos.
- 💩 :poop: Write bad code that needs to be improved.
- ⏪️ :rewind: Revert changes.
- 🔀 :twisted_rightwards_arrows: Merge branches.
- 📦️ :package: Add or update compiled files or packages.
- 👽️ :alien: Update code due to external API changes.
- 🚚 :truck: Move or rename resources (e.g.: files, paths, routes).
- 📄 :page_facing_up: Add or update license.
- 💥 :boom: Introduce breaking changes.
- 🍱 :bento: Add or update assets.
- ♿️ :wheelchair: Improve accessibility.
- 💡 :bulb: Add or update comments in source code.
- 🍻 :beers: Write code drunkenly.
- 💬 :speech_balloon: Add or update text and literals.
- 🗃️ :card_file_box: Perform database related changes.
- 🔊 :loud_sound: Add or update logs.
- 🔇 :mute: Remove logs.
- 👥 :busts_in_silhouette: Add or update contributor(s).
- 🚸 :children_crossing: Improve user experience / usability.
- 🏗️ :building_construction: Make architectural changes.
- 📱 :iphone: Work on responsive design.
- 🤡 :clown_face: Mock things.
- 🥚 :egg: Add or update an easter egg.
- 🙈 :see_no_evil: Add or update a .gitignore file.
- 📸 :camera_flash: Add or update snapshots.
- ⚗️ :alembic: Perform experiments.
- 🔍️ :mag: Improve SEO.
- 🏷️ :label: Add or update types.
- 🌱 :seedling: Add or update seed files.
- 🚩 :triangular_flag_on_post: Add, update, or remove feature flags.
- 🥅 :goal_net: Catch errors.
- 💫 :dizzy: Add or update animations and transitions.
- 🗑️ :wastebasket: Deprecate code that needs to be cleaned up.
- 🛂 :passport_control: Work on code related to authorization, roles and permissions.
- 🩹 :adhesive_bandage: Simple fix for a non-critical issue.
- 🧐 :monocle_face: Data exploration/inspection.
- ⚰️ :coffin: Remove dead code.
- 🧪 :test_tube: Add a failing test.
- 👔 :necktie: Add or update business logic.
- 🩺 :stethoscope: Add or update healthcheck.
- 🧱 :bricks: Infrastructure related changes.
- 🧑‍💻 :technologist: Improve developer experience.
- 💸 :money_with_wings: Add sponsorships or money related infrastructure.
- 🧵 :thread: Add or update code related to multithreading or concurrency.
- 🦺 :safety_vest: Add or update code related to validation.
