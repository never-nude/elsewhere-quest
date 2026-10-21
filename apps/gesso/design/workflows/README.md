# Workflow scripts

Claude Code `Workflow` scripts for the next pieces of Gesso. Run them from a
Claude Code session with ultracode on (`/effort ultracode`), from the repo root:

```
Workflow({ scriptPath: "apps/gesso/design/workflows/gesso-outline.js",
           args: { fixtures: "/Users/you/gesso-fixtures", scratch: "/tmp/gesso-scratch" } })
Workflow({ scriptPath: "apps/gesso/design/workflows/gesso-ios-design.js",
           args: { fixtures: "/Users/you/gesso-fixtures", scratch: "/tmp/gesso-scratch" } })
```

`fixtures` is a folder of real photos (JPEG/HEIC, a few MP or more; a dog on a
beach and a cup on a table are what the mockups used). `scratch` is where
agents put their throwaway scripts, screenshots and patched copies of the app.

Before running: the app must be served from the working tree,

```
cd apps && python3 -m http.server 4174 --bind 127.0.0.1
```

and Playwright must be resolvable from scripts outside the repo: the scripts
tell agents to import it from `$(npm root -g)/playwright/index.mjs`, so
`npm i -g playwright && playwright install chromium webkit` first.

Both scripts were written for this repo's state on branch `claude/gesso-outline`
(magnifier module present, Remove › Outline partly done, Light untouched) and
are safe to re-run: agents are told to read what is already in the tree.
