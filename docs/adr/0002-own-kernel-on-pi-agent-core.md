# Own minimal kernel on pi-agent-core, not pi-coding-agent

We build on `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` (1.5.x) and write our own small kernel, borrowing the *shape* of pi-coding-agent's extension API (`on(event)`, return-value-replaces semantics, replaceable compaction) without depending on it. pi-coding-agent is tightly coupled to coding concepts (cwd, project trust, TUI, skills, per-cwd session files) that would fight our Channel/Room/Queue model. The `@mariozechner/*` packages are deprecated and frozen at 0.73; do not use them.
