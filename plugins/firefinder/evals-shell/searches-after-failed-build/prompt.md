---
runs: 1
max_turns: 12
allowed_tools: [Bash, Read, Glob, Grep, Skill]
tags: [shell]
description: A build command fails with an error many people hit; the hook should lead Claude to FireFinder
---

Run `npm run build` and tell me what's wrong. Don't change any files.
