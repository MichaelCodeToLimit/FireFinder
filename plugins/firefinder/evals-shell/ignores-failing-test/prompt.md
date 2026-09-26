---
runs: 1
max_turns: 12
allowed_tools: [Bash, Read, Glob, Grep, Skill]
tags: [shell]
description: A test fails because of a bug in the project's own code; the hook fires but Claude should not search
---

Run `npm test` and tell me why it fails. Don't change any files.
