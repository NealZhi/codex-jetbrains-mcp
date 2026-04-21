<p align="center">
  <a href="./README.md"><img src="https://img.shields.io/badge/lang-中文-red.svg" alt="中文"></a>
  <a href="./README.en.md"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
</p>

# Codex JetBrains HUD + Hooks Guide

> Background: this adapter was built from analysis of leaked `Claude Code v2.1.88` source code, with the goal of giving `Codex` similar awareness of the current selection inside JetBrains IDEs.
>
> Author: `nealzhi`

This guide keeps only one integration path: **HUD + hooks**.

The old "local MCP server + global prompt" path has been removed from this repository and is no longer documented or supported.

![Successful setup](./screenshot.png)

## 1. Prerequisites

Before anything else:

1. Use a JetBrains IDE  
   For example: `IntelliJ IDEA`, `PyCharm`, `WebStorm`, `GoLand`, `Android Studio`
2. Install the **official Claude Code JetBrains plugin** in that IDE  
   This is required. Without the plugin, there will be no local `~/.claude/ide/*.lock` files or local endpoint for Codex to read.

## 2. Install dependencies

From the repository root:

```bash
cd codex-jetbrains-mcp
npm install
brew install tmux
```

## 3. Enable the HUD

From the repository root:

```bash
chmod +x codex-jetbrains-mcp/bin/codex-jetbrains-hud
```

Add this line to `~/.zshrc` or `~/.bashrc`:

```bash
alias codex='$(pwd)/codex-jetbrains-mcp/bin/codex-jetbrains-hud'
```

Reload your shell:

```bash
source ~/.zshrc
```

If you use `bash`:

```bash
source ~/.bashrc
```

If mouse scrolling does not work for the Codex window in macOS Terminal or Warp, enable `tmux` mouse support with:

```bash
tmux set -g mouse on
```

The HUD should show a single line:

```text
JetBrains PyCharm 已连接 | test_main.py:2140-2147 (8 lines)
```

## 4. Configure hooks

This flow is now the only supported path:

1. Start `codex` through the HUD wrapper
2. Let the HUD update `.codex/jetbrains-selection-state.json`
3. Let a `UserPromptSubmit` hook read that file when you send a message
4. Inject only `filePath` or `filePath + line range`
5. Do not inject code text; let Codex read the file on demand

### 4.1 Recommended startup path

From the repository root:

```bash
chmod +x codex-jetbrains-mcp/bin/codex-jetbrains-hud
alias codex='$(pwd)/codex-jetbrains-mcp/bin/codex-jetbrains-hud'
```

After that, start `codex` normally.

`codex-jetbrains-hud` now renders the HUD and also keeps the hook state file updated. This is the only recommended path, and there is no separate sync process to start anymore.

The state file is:

```text
.codex/jetbrains-selection-state.json
```

### 4.2 Configure hooks

This repository now ships with:

- `.codex/config.toml`
- `.codex/hooks/selection-state.mjs`
- `.codex/hooks.json`
- `.codex/hooks/user-prompt-submit-jetbrains-selection.mjs`

There are two integration paths:

1. If you run `codex` inside this repository, Codex will pick up the repo-local `.codex/config.toml` and `.codex/hooks.json` automatically.
2. If you already have a global `~/.codex/hooks.json`, do not replace it. Merge the `UserPromptSubmit` entry from this repository into your existing file.
   If you copy the hook into `~/.codex/hooks/`, copy the whole `.codex/hooks/` directory instead of only the entry file.

`.codex/config.toml` exists to enable the official hooks feature flag:

```toml
[features]
codex_hooks = true
```

Per the official docs, hooks are off by default. You must enable them in `config.toml`, or start Codex with `codex --enable codex_hooks`. Codex reads both `~/.codex/config.toml` and repo-local `.codex/config.toml`; if the project is not trusted, repo-local config will be ignored.

The shipped config is:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$(git rev-parse --show-toplevel)/.codex/hooks/user-prompt-submit-jetbrains-selection.mjs\"",
            "statusMessage": "Loading JetBrains selection"
          }
        ]
      }
    ]
  }
}
```

On every `UserPromptSubmit`, the hook reads the local state file:

- if only a file is selected, it injects the file path
- if a code range is selected, it injects the file path and line range
- if there is no valid JetBrains context, or the state is stale, it injects nothing

It does not inject selected code text. It only gives Codex a location hint.

### 4.3 Remove old config

If you used the previous setup, delete both parts below:

1. Remove the old local MCP entry

```bash
codex mcp remove jetbrains-selection
```

2. Remove any global prompt text like:

```text
For every user request, first call the MCP tool jetbrains-selection.jetbrains_get_selection to get the current JetBrains selection
```

This cleanup matters. Otherwise the model may still try to call a tool that no longer exists.

### 4.4 What the hook injects

File only:

```text
JetBrains 当前选中文件：/path/to/file.ts
这只是文件指引，没有附带文件内容。
如果本轮问题和这个文件相关，请先自行读取该文件；如果无关，请忽略这条上下文。
```

File and line range:

```text
JetBrains 当前选中位置：/path/to/file.ts:120-146
这只是位置指引，没有附带代码内容。
如果本轮问题和这个位置相关，请先自行读取对应文件和行号；如果无关，请忽略这条上下文。
```

The default freshness window is `20s`. While the HUD is running it refreshes the state every `5s`; if the HUD exits, the hook will stop injecting stale state shortly after. You can change this via `CODEX_JB_HOOK_MAX_AGE_MS`.

## 5. Why the local MCP path was removed

The old path had a few recurring problems:

- it required an extra `codex mcp add` setup step
- it usually depended on a global prompt that forced "call MCP first" on every request
- that behavior was too mechanical, even when the current question had nothing to do with the JetBrains selection
- the local MCP server was only a relay layer on top of the Claude Code JetBrains plugin, so the added complexity was not paying for itself
- old MCP config and old prompt text were easy to leave behind during migration

The HUD + hooks path is simpler and more direct:

- state is read only when the user submits a prompt
- injected context is limited to file path or line range, so the model can decide whether it actually needs to read code
- state is isolated per project root via `.codex/jetbrains-selection-state.json`
- liveness is handled by a heartbeat, and stale state expires automatically after timeout
- there is only one path to maintain instead of separate HUD, MCP, and prompt layers

## 6. How the current flow works

The data flow is:

1. The official Claude Code JetBrains plugin exposes local connection info and selection events
2. The HUD matches the correct JetBrains project using the current working directory
3. The HUD writes file path, line range, and heartbeat time into the current project's `.codex/jetbrains-selection-state.json`
4. The `UserPromptSubmit` hook reads that state when you send a message
5. If the state is still fresh, Codex gets a lightweight hint for the current file or file range

There is no local MCP server in this path, and no extra global prompt is required.

## 7. Verify

1. Open your JetBrains IDE
2. Start `codex`
3. If you use the HUD wrapper, the hook state is synced automatically
4. Go back to the IDE and select a file or some code
5. Confirm that the HUD updates with the file and line range
6. Ask Codex a question

If the HUD does not refresh, click the file again or reselect the code in the IDE.

With hooks enabled:

- file-only selection gives Codex a file hint
- code selection gives Codex a file + line-range hint
- no JetBrains context means no hook injection
