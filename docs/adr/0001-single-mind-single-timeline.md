# One mind, one Timeline, one Run at a time

All Channels and Rooms feed a single persona with a single shared, never-ending Timeline, and at most one Run executes at a time. We chose this over one-agent-per-Room (better concurrency, isolated contexts) because the product goal is that the companion feels like *one* continuous person who remembers in a group chat what the Owner just told it privately. The accepted cost is cross-Room context leakage (mitigated only by prompt instructions) and serialized latency when several Rooms are active.
