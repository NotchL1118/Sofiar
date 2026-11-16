# Channels normalize, the kernel renders

Channels convert platform messages into a structured Signal (sender, isOwner, Room, time, content, notes); the kernel alone turns Signals into model-facing text. The structured fields are needed downstream by scheduling, memory, Trace and the admin UI (dependency inversion: the kernel owns the shape, Channels conform), and one renderer keeps every Room looking the same to the model. Owner identification remains the Channel's job; the kernel holds no identity config. There is intentionally no custom-renderer hook in v1.
