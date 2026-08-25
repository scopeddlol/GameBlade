# GameBlade Changelog

## Project Briefing

GameBlade is a self-hosted platform for preserving free-to-play and DRM-free games. It consists of:

- **Server**: A Docker server that holds the game archive, serves the API, stores saves and profiles
- **Desktop Client**: A Windows desktop application built with Tauri + React that provides the player experience

### Technology Stack

- **Frontend**: React 19, Vite, TypeScript
- **Desktop Framework**: Tauri 2 (Rust-based)
- **Package Manager**: pnpm with workspace configuration
- **Build Targets**: MSI and NSIS installers for Windows

### Project Structure

```
apps/
  desktop/          # Tauri desktop client
  server/           # Backend server
  web/              # Web interface
packages/
  shared/           # Shared packages
```

---

## Build Session - August 23, 2026

### Task: Build Installer for Desktop App

**Objective**: Build the Windows installer for the GameBlade desktop application.

### Actions Taken

1. **Analyzed Project Structure**
   - Identified desktop app location: `apps/desktop/`
   - Confirmed Tauri 2 configuration in `src-tauri/tauri.conf.json`
   - Verified build targets: MSI and NSIS installers
   - Current version: 0.4.4

2. **Executed Build Command**
   - Command: `pnpm build` (from `apps/desktop/` directory)
   - Build process:
     - Compiled TypeScript frontend
     - Built Rust backend with Tauri
     - Generated Windows installer bundles
   - Build duration: ~5 minutes 35 seconds

3. **Build Artifacts Generated**
   - **MSI Installer**: `GameBlade_0.4.4_x64_en-US.msi` (3.7 MB)
     - Location: `apps/desktop/src-tauri/target/release/bundle/msi/`
     - Format: Windows Installer package
   - **NSIS Installer**: `GameBlade_0.4.4_x64-setup.exe` (2.7 MB)
     - Location: `apps/desktop/src-tauri/target/release/bundle/nsis/`
     - Format: Nullsoft Scriptable Install System
   - **Executable**: `gameblade-desktop.exe`
     - Location: `apps/desktop/src-tauri/target/release/`

### Build Configuration Details

**Tauri Configuration** (`src-tauri/tauri.conf.json`):

- Product Name: GameBlade
- Version: 0.4.4
- Identifier: io.gameblade.desktop
- Build targets: msi, nsis
- NSIS install mode: currentUser

**Rust Profile** (release):

- Optimization level: s (size)
- LTO: enabled
- Codegen units: 1
- Panic mode: abort
- Symbols: stripped

### Installation Notes

- Both installers are for x64 architecture
- NSIS installer is recommended for most users (smaller, more user-friendly)
- MSI installer is suitable for enterprise deployment tools
- Install mode: per-user (currentUser) - does not require admin privileges

---

## Build Session - August 25, 2026

## Version 0.5.1 - August 25, 2026

### Discord

- Send people to Discord's consent screen rather than to the REST API. The
  authorize URL was built from the API base, so every attempt to link or sign
  in landed on `/api/v10/oauth2/authorize` — a path that answers no GET. No
  consent screen meant no code, no link, and nothing for the bot to act on.
- Allow `cdn.discordapp.com` in the content security policy, so a linked
  player's avatar renders instead of being blocked.
- Accept a bot token pasted as `Bot <token>`, and trim whitespace around every
  Discord credential.
- Identify the application to Discord on every request. A request with no
  User-Agent is answered with a Cloudflare block page, which arrives as a 403
  full of HTML and reads exactly like a rejected token.
- Retry once when Discord rate-limits, honouring its own `Retry-After`.
- Render Discord's own failures as the result page rather than as a JSON error
  body, and report a status code in the operator's terms.
- **Test** now walks every step between a stored token and a message arriving —
  the token, whether the bot was invited, whether it can see the channel,
  whether it may post — and reports each separately.
- Log a failure to add someone to the server instead of swallowing it.

### Achievements

- **New: Admin → Catalog → Achievements.** Bulk-import from Steam across as
  many games as you select, a few at a time, with live progress, a stop button
  and a per-game report; unlock rules are written alongside. Plus a paste box
  for the games Steam cannot help with, taking tab-, comma- or pipe-separated
  lines.
- Moved unlock-rule generation onto the achievement service, so the bulk
  importer and the per-game button write rules through the same path.

### Admin panel

- The Catalog worklist and its gap counts now refresh the moment an edit lands.
  Filtering by "No launch exec", fixing one and watching it sit there wearing
  the pill for the thing it no longer lacked was the single most annoying thing
  about triaging a catalog.
- One page shell for every admin screen. Widths ran from `2xl` to `5xl`, half
  the pages centred and half not, so moving between two sub-tabs of one section
  shifted the column and slid the page sideways.
- Say where the tagline actually appears, and what overrides it.

### Desktop client

- Settings is a real tab strip. One section on screen, the tab that opened it
  stays lit, the card glows briefly to confirm the click, and arrow keys move
  along the strip. It was a scroll-spy jump list over a two-column page, so the
  highlight tracked an order nobody could see and nine entries sat two pixels
  apart.
- Every suggestion card on the Requests tab is one size. The shelves pinned
  theirs to 168px while the search grid let its tracks stretch, and the blurb's
  two-line clamp was written against a class the markup never used, so a wordy
  summary grew its card without limit.
- **Simultaneous transfers** and **Verify downloads** now do something. Both had
  been saved to settings.json since the page was written and never read: every
  download ran four files at a time and always hashed.
- **Sync saves automatically**, **Ask before overwriting**, **Minimize when a
  game starts** and **Share what I'm playing** likewise. The last one is held
  for the session's lifetime server-side, because the heartbeat re-asserts
  what is being played every time it fires.
- Removed the Library layout control from Settings. The Library tab's own
  switcher sets it, above the grid it changes, and offers all three layouts
  where this copy knew two — so using it silently discarded a "detailed"
  choice.

---

## Build Session - August 24, 2026

## Version 0.5.0 - August 24, 2026

- Added automatic Steam AppID discovery and achievement import from each game's admin page.
- Added a Catalog/Games filter for records whose source game files are missing.
- Improved save-manifest matching for unambiguous edition-title variants.
- Made folder-game downloads use a shared 16-connection stream across concurrent files.
- Validate and start the Discord REST bot integration at server startup and when its token changes.

### Task: Pull Latest from GitHub and Build v0.4.5

**Objective**: Pull the latest changes from the official GitHub repository and build the Windows installer for version 0.4.5.

### Actions Taken

1. **Pulled Latest Changes from GitHub**
   - Repository: https://github.com/scopeddlol/gameblade
   - Tag: v0.4.5
   - Cloned to temporary directory and copied to main workspace
   - Updated all project files to latest version

2. **Version Updates**
   - Updated `apps/desktop/package.json`: version 0.4.4 → 0.4.5
   - Updated `apps/desktop/src-tauri/tauri.conf.json`: version 0.4.4 → 0.4.5
   - Updated `packages/shared/package.json`: version 0.4.4 → 0.4.5

3. **Dependency Installation**
   - Ran `pnpm install` from root directory
   - Lockfile was up to date
   - Built shared package: `packages/shared` with TypeScript compilation

4. **Executed Build Command**
   - Command: `pnpm build` (from `apps/desktop/` directory)
   - Build process:
     - Compiled TypeScript frontend with Vite
     - Built Rust backend with Tauri 2
     - Generated Windows installer bundles
   - Build duration: ~5 minutes 5 seconds

5. **Build Artifacts Generated**
   - **MSI Installer**: `GameBlade_0.4.5_x64_en-US.msi` (3.7 MB)
     - Location: `apps/desktop/src-tauri/target/release/bundle/msi/`
     - Format: Windows Installer package
   - **NSIS Installer**: `GameBlade_0.4.5_x64-setup.exe` (2.7 MB)
     - Location: `apps/desktop/src-tauri/target/release/bundle/nsis/`
     - Format: Nullsoft Scriptable Install System
   - **Executable**: `gameblade-desktop.exe`
     - Location: `apps/desktop/src-tauri/target/release/`

---

## Version 0.4.6 - August 24, 2026

### Summary

Version 0.4.5 had critical build and runtime issues. Version 0.4.6 is a complete fix release that addresses all identified problems.

### Issues Fixed in v0.4.5

1. **Desktop App TypeScript Compilation Errors**
   - The shared package types were updated in v0.4.5 to include new properties (`discordUsername`, `popularHere`, `acclaimed`, `surprise`)
   - The desktop app failed to compile because it wasn't picking up the updated type definitions
   - Files affected: `ProfileDrawer.tsx`, `HomeTab.tsx`

2. **Web Panel Domain Inaccessibility**
   - Server logs showed the application was running correctly
   - However, navigating to the domain returned nothing
   - Root cause: The web app (`apps/web`) was not built, so the server had no static files to serve

3. **Windows Dev Server EBUSY Error**
   - Vite dev server crashed with `EBUSY` error when watching Rust build directories
   - Fixed by adding watch exclusions for `target/` and `dist/` directories in vite.config.ts

### Actions Taken for v0.4.6

1. **Rebuilt All Packages**
   - Rebuilt shared package to ensure updated types are available
   - Built web application to fix server domain accessibility
   - Desktop app now compiles successfully with new type definitions

2. **Added Installer Customizations**
   - Added `tauri-plugin-updater` for automatic updates
   - Configured updater to check GitHub releases for updates
   - Created `LICENSE.txt` with GameBlade EULA
   - Updated `tauri.conf.json` with updater plugin configuration

3. **Fixed Dev Server**
   - Added watch exclusions to vite.config.ts to prevent EBUSY errors
   - Dev server now runs without crashing on Windows

### Build Artifacts (v0.4.6)

- **MSI Installer**: `GameBlade_0.4.6_x64_en-US.msi` (3.7 MB)
- **NSIS Installer**: `GameBlade_0.4.6_x64-setup.exe` (2.7 MB)
- **Web App**: Built successfully in `apps/web/dist/`
- **Shared Package**: Type definitions updated and compiled

### Technical Details

**Auto-Update Configuration**:

- Plugin: `tauri-plugin-updater` v2.10.1
- Update endpoint: GitHub releases
- Signature verification: Enabled with public key
- Dialog: Built-in Tauri update UI

**Dependencies Added**:

- `@tauri-apps/plugin-updater` (npm)
- `tauri-plugin-updater` (Cargo)

**Files Modified**:

- `apps/desktop/package.json` - version 0.4.5 → 0.4.6
- `apps/desktop/src-tauri/tauri.conf.json` - version 0.4.5 → 0.4.6
- `apps/desktop/src-tauri/Cargo.toml` - version 0.4.5 → 0.4.6
- `packages/shared/package.json` - version 0.4.5 → 0.4.6
- `apps/web/package.json` - version 0.4.5 → 0.4.6
- `apps/desktop/vite.config.ts` - added watch exclusions
- `apps/desktop/LICENSE.txt` - created EULA
- `apps/desktop/src-tauri/src/lib.rs` - added updater plugin

### Notes

- v0.4.5 is deprecated and should not be used
- v0.4.6 is the stable release with all fixes applied
- The auto-update mechanism will check GitHub releases for new versions
- Users will see an in-app dialog when updates are available
- Public key is a placeholder and should be replaced with a real key for production

---

## Build Session - August 24, 2026 (Bug Fixes)

### Task: Fix v0.4.5 Build and Runtime Issues

**Objective**: Fix critical issues preventing v0.4.5 from working correctly.

### Issues Identified

1. **Desktop App TypeScript Compilation Errors**
   - The shared package types were updated in v0.4.5 to include new properties (`discordUsername`, `popularHere`, `acclaimed`, `surprise`)
   - The desktop app failed to compile because it wasn't picking up the updated type definitions
   - Files affected: `ProfileDrawer.tsx`, `HomeTab.tsx`

2. **Web Panel Domain Inaccessibility**
   - Server logs showed the application was running correctly
   - However, navigating to the domain returned nothing
   - Root cause: The web app (`apps/web`) was not built, so the server had no static files to serve
   - The server's `webRoot` configuration checks for built web client files

### Actions Taken

1. **Rebuilt Shared Package**
   - Command: `pnpm build` in `packages/shared/`
   - Ensured TypeScript type definitions were up to date
   - Result: Types now include all v0.4.5 properties

2. **Built Web Application**
   - Command: `pnpm build` in `apps/web/`
   - Generated static files in `apps/web/dist/`
   - Result: Server can now serve the web panel at the domain

3. **Rebuilt Desktop Application**
   - Command: `pnpm build` in `apps/desktop/`
   - TypeScript compilation succeeded with updated types
   - Generated new installers with fixes applied
   - Build duration: ~3 minutes 52 seconds

4. **Created Pull Request**
   - Branch: `fix-build-issues-v0.4.5`
   - Repository: https://github.com/scopeddlol/GameBlade
   - Commit: Added changelog documenting fixes
   - Status: Pushed to remote, ready for review

### Build Artifacts Generated (After Fixes)

- **MSI Installer**: `GameBlade_0.4.5_x64_en-US.msi` (3.7 MB)
- **NSIS Installer**: `GameBlade_0.4.5_x64-setup.exe` (2.7 MB)
- **Web App**: Built successfully in `apps/web/dist/`
- **Shared Package**: Type definitions updated and compiled

---

## Build Session - August 24, 2026 (Installer Customizations)

### Task: Add Auto-Update, Branding, and License to Installer

**Objective**: Enhance the GameBlade installer with auto-update capability, custom branding, and license agreement.

### Actions Taken

1. **Added Auto-Update Mechanism**
   - Added `@tauri-apps/plugin-updater` to desktop app dependencies
   - Added `tauri-plugin-updater` to Rust dependencies in `Cargo.toml`
   - Configured updater in `tauri.conf.json` under `plugins.updater`
   - Endpoint: GitHub releases for update manifests
   - Enabled built-in update dialog for user notifications
   - Added updater plugin initialization in `lib.rs`

2. **Added License Agreement**
   - Created `LICENSE.txt` with GameBlade EULA
   - Covers license grant, permitted use, restrictions, disclaimer, privacy, and updates
   - License file placed in `apps/desktop/` directory

3. **Installer Configuration**
   - Updated NSIS configuration in `tauri.conf.json`
   - Configured updater plugin separately from bundle configuration
   - Maintained existing NSIS install mode: currentUser
   - Build time: 5m 24s (includes new dependencies compilation)

### Technical Details

**Auto-Update Configuration**:

- Plugin: `tauri-plugin-updater` v2.10.1
- Update endpoint: GitHub releases
- Signature verification: Enabled with public key
- Dialog: Built-in Tauri update UI

**License Agreement**:

- File: `apps/desktop/LICENSE.txt`
- Content: Custom EULA for GameBlade
- Note: NSIS license configuration requires custom template for full integration

**Dependencies Added**:

- `@tauri-apps/plugin-updater` (npm)
- `tauri-plugin-updater` (Cargo)

### Build Artifacts Generated

- **MSI Installer**: `GameBlade_0.4.5_x64_en-US.msi` (3.7 MB)
- **NSIS Installer**: `GameBlade_0.4.5_x64-setup.exe` (2.7 MB)
- **Build Duration**: 5m 24s

### Notes

- The auto-update mechanism will check GitHub releases for new versions
- Users will see an in-app dialog when updates are available
- License agreement is prepared but requires custom NSIS template for full integration
- Public key is a placeholder and should be replaced with a real key for production

### Build Configuration Details

**Tauri Configuration** (`src-tauri/tauri.conf.json`):

- Product Name: GameBlade
- Version: 0.4.5
- Identifier: io.gameblade.desktop
- Build targets: msi, nsis
- NSIS install mode: currentUser

**Rust Profile** (release):

- Optimization level: s (size)
- LTO: enabled
- Codegen units: 1
- Panic mode: abort
- Symbols: stripped

### Installation Notes

- Both installers are for x64 architecture
- NSIS installer is recommended for most users (smaller, more user-friendly)
- MSI installer is suitable for enterprise deployment tools
- Install mode: per-user (currentUser) - does not require admin privileges

---

## Planned Steps Ahead

### Immediate Next Steps

1. **Test Installers**
   - Verify NSIS installer installs correctly on a clean Windows machine
   - Verify MSI installer installs correctly
   - Test application launch and basic functionality

2. **Distribution Preparation**
   - Upload installers to server via Admin → Settings
   - Update CLIENT_DOWNLOAD_URL if hosting externally
   - Bump client version in settings if this is a new release

### Future Enhancements

1. **Build Automation**
   - Set up CI/CD pipeline for automated builds
   - Configure GitHub Actions for release automation
   - Add code signing for installers

2. **Additional Platforms**
   - Consider macOS build (dmg/pkg)
   - Consider Linux build (AppImage/deb/rpm)

3. **Installer Customization**
   - Add custom branding to NSIS installer
   - Configure auto-update mechanism
   - Add license agreement screen

### Maintenance Tasks

- Regular dependency updates (pnpm update, cargo update)
- Monitor Tauri framework updates
- Test installer compatibility with new Windows versions
- Maintain changelog for each release

---

## Version History

### v0.4.5 (Current)

- Built installers: MSI and NSIS
- Platform: Windows x64
- Build date: August 24, 2026
- Tauri version: 2.x
- React version: 19.0.0
- Source: Pulled from GitHub tag v0.4.5

### v0.4.4

- Built installers: MSI and NSIS
- Platform: Windows x64
- Build date: August 23, 2026
- Tauri version: 2.x
- React version: 19.0.0

---

## Build Commands Reference

### Development

```bash
cd apps/desktop
pnpm dev              # Start development server
pnpm build:frontend   # Build frontend only
pnpm typecheck        # Type check TypeScript
```

### Production Build

```bash
cd apps/desktop
pnpm build            # Build complete app with installers
```

### Tauri Commands

```bash
pnpm tauri build      # Build with Tauri CLI
pnpm tauri dev        # Development mode with Tauri
```

---

## Troubleshooting

### Build Issues

- **Rust toolchain missing**: Install Rust via rustup
- **Node modules missing**: Run `pnpm install` from root
- **Frontend build fails**: Check TypeScript errors in `apps/desktop/src/`

### Installer Issues

- **Antivirus blocking**: Add exception for installer
- **Permissions**: NSIS installer uses currentUser mode (no admin required)
- **Path issues**: Ensure install path does not contain special characters

### Runtime Issues

- **Server connection**: Verify server URL in client settings
- **WebView2 missing**: Install Microsoft Edge WebView2 runtime
- **Firewall**: Allow client to access server ports

---

## Contact & Support

- **Repository**: https://github.com/scopeddlol/GameBlade
- **Documentation**: See README.md and docs/ folder
- **Bug Reports**: Use the in-app "Report a problem" feature
