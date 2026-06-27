# Squirrel (鼠鬚管) + Boshiamy (嘸蝦米) Setup

End-to-end guide to install the **Rime** input method engine's macOS front-end
**Squirrel (鼠鬚管)** and mount the **Boshiamy (嘸蝦米)** input schema using the
community **rime-liur** package on a fresh Mac.

> Schema choice: **rime-liur** — full-featured (Boshiamy + English vocabulary +
> symbol table + Lua filters + opencc simplified/traditional conversion).
> Reference: <https://github.com/ryanwuson/rime-liur>

## Prerequisites

- macOS ≥ 13 (Apple Silicon verified)
- [Homebrew](https://brew.sh/) installed
- No prior Rime config to preserve (fresh install). If you have existing config
  in `~/Library/Rime/`, back it up first.

## Key Paths

| Purpose | Path |
| --- | --- |
| Squirrel app (after cask install) | `/Library/Input Methods/Squirrel.app` |
| Rime user data folder | `~/Library/Rime/` |
| liur main schema | `~/Library/Rime/liur.schema.yaml` |
| Squirrel look-and-feel custom (bundled) | `~/Library/Rime/squirrel.custom.yaml` |
| Required fonts land in | `~/Library/Fonts/` |

## Steps

### 1. Install Squirrel

```bash
brew install --cask squirrel-app
```

The cask installs `Squirrel-<ver>.pkg`; the system `installer` prompts for an
admin password.

### 2. Add Rime as a system input source

System Settings → Keyboard → Text Input / Input Sources → Edit → `+` → choose
**鼠鬚管 (Squirrel / Rime)**. If it does not appear, log out and back in (or
reboot) so macOS registers the new input method.

### 3. Install the Boshiamy schema (rime-liur)

```bash
curl -fsSL https://raw.githubusercontent.com/ryanwuson/rime-liur/main/rime_liur_installer.sh | bash
```

The script is **interactive** — it prompts for a version:

1. **完整版（中打含英文詞庫版）(recommended)** — Chinese input plus English
   vocabulary, auto-completion, case conversion. Best for daily use + coding.
2. 基礎版（中打不含英文詞庫） — pure Chinese, no English candidates.

It then: downloads schema files to `~/Library/Rime/`, installs required fonts to
`~/Library/Fonts/`, and deploys Rime.

### 4. Redeploy and select the schema

The installer usually deploys automatically. If not: click the menu-bar Rime
icon → **重新部署 / Redeploy** (or `Ctrl+Option+~`). After deployment, the schema
list shows **liur (嘸蝦米)** — select it as the active input method.

## Non-interactive installer (repo script)

The repo ships a deterministic, prompt-free equivalent of the upstream
interactive installer at [`scripts/install-squirrel-boshiamy.sh`](../scripts/install-squirrel-boshiamy.sh).
Use it inside a non-interactive shell (CI, agent sandbox) where the upstream
`read ... </dev/tty` prompts cannot be answered:

```bash
# Full version (with English vocabulary) — default
chmod +x scripts/install-squirrel-boshiamy.sh
VERSION=mixed ./scripts/install-squirrel-boshiamy.sh

# Pure-Chinese version
VERSION=chinese-only ./scripts/install-squirrel-boshiamy.sh
```

It downloads schema/lua/opencc/configs + the three fonts, writes
`liur.schema.yaml`, and relaunches Squirrel to deploy. Env overrides:
`RIME_FOLDER`, `FONT_FOLDER`, `VERSION`.

## Manual (file-by-file) alternative

If you prefer to copy by hand:

```bash
git clone https://github.com/ryanwuson/rime-liur /tmp/rime-liur
mkdir -p ~/Library/Rime
# Copy everything except docs/fonts/installers into ~/Library/Rime/
# Full version:   cp /tmp/rime-liur/configs/liur.schema.yaml           ~/Library/Rime/liur.schema.yaml
# Chinese-only:   cp /tmp/rime-liur/configs/liur.chinese-only.schema.yaml ~/Library/Rime/liur.schema.yaml
# Install fonts:  cp /tmp/rime-liur/fonts/macos/*.ttf ~/Library/Fonts/
```

Then redeploy as in step 4.

## Verification

```bash
# 1. Squirrel installed
ls -d "/Library/Input Methods/Squirrel.app" && echo OK

# 2. Rime folder has liur schema + lua + opencc + fonts installed
ls ~/Library/Rime/liur.schema.yaml ~/Library/Rime/rime.lua ~/Library/Rime/opencc 2>/dev/null
ls ~/Library/Fonts/ | grep -E 'MapleMonoNormal|PlangothicP[12]'

# 3. Schema registered after deployment (build/ contains compiled schema)
ls ~/Library/Rime/build/*.schema.yaml 2>/dev/null | grep -i liur
```

Final smoke test: switch to Rime in any text field → type Boshiamy codes (e.g.
`a` → 對) and press Space to commit; type `,,h` for the hotkey cheat-sheet; type
`` ` `` to open the categorized symbol menu. Characters commit → done.

## Common hotkeys (liur)

| Feature | Trigger | Note |
| --- | --- | --- |
| English input (temporary) | `Ctrl + /` | one-off English |
| Word-coining mode | `;` | temporary phrase |
| Homophone selection | `'` | after highlighting a candidate |
| Reading lookup | `;;` | type code → reading |
| Bopomofo input | `';` | 注音 |
| Pinyin input | `;'` | 漢語拼音 |
| Symbol menu | `` ` `` | 50+ categories |
| Quick-type hints | `,,sp` | show short codes |
| Wildcard lookup | `,,wc` + `?` | fuzzy code search |
| Code-lookup mode | `Ctrl + '` | show codes to learn decomposition |
| Hotkey help | `,,h` | all shortcuts |

## Notes

- The default candidate window uses a macOS-native-look theme bundled as
  `squirrel.custom.yaml`. To tweak appearance or force ASCII in specific apps,
  edit that file and redeploy.
- For simplified output, enable the opencc `simplifier` in `default.custom.yaml`
  (traditional is the default).
- The official Boshiamy root table is a commercial product; rime-liur is a
  community open-source schema intended for personal use.
