# Codex JetBrains Integration Guide

> Background: this adapter was built from analysis of leaked `Claude Code v2.1.88` source code, with the goal of giving `Codex` similar awareness of the current selection inside JetBrains IDEs.
>
> Author: `nealzhi`

This guide only explains how to connect `Codex` to the current selection in JetBrains IDEs.

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

## 3. Connect the MCP server to Codex

From the repository root:

```bash
codex mcp add jetbrains-selection -- node codex-jetbrains-mcp/src/index.mjs
```

Notes:

- You do **not** need to run `npm start` first
- Codex will start this MCP server automatically when needed
- The adapter uses the current Codex working directory to match the active JetBrains project

## 4. Enable the HUD

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

The HUD should show:

```text
JetBrains ● PyCharm · ws · connected
Selection: tender_gen_service.py:2140-2147 (8 lines)
```

## 5. Add the global prompt

Put this into your global Codex prompt:

```text
For every user request, first call the MCP tool `jetbrains-selection.jetbrains_get_selection` to get the current JetBrains selection.
If a valid `filePath` is returned, prioritize the returned `filePath`, `lineStart`, `lineEnd`, and `text`, where `lineStart`, `lineEnd`, and `text` may be empty.
The user may have selected only a file, only several lines, or only a few characters inside one line, so treat `filePath` as the base context and use any available line range and `text` to determine the real selection.
If no valid selection is available, tell the user to reselect code in the JetBrains IDE first.
```

## 6. Verify

1. Open your JetBrains IDE
2. Start `codex`
3. Go back to the IDE and select some code
4. Confirm that the HUD updates with the file and line range
5. Ask Codex a question

If the HUD does not refresh, click the file again or reselect the code in the IDE.
