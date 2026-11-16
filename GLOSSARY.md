# Sofia

A long-lived personal companion agent: one persona that lives across many chat surfaces and talks with its Owner and other people as a single, continuous self.

## Identity

**Owner**:
The one person the companion belongs to. Each Channel decides whether a given sender is the Owner.
_Avoid_: Master, admin, user

**Contact**:
Anyone other than the Owner whom the companion talks with, identified per Channel (no cross-Channel merging).
_Avoid_: User, member, friend

## Surfaces

**Channel**:
An integration that connects the companion to one kind of surface (e.g. `desktop`, `telegram`), contributing its own tools and prompt fragments.
_Avoid_: Platform, adapter, connector

**Room**:
One specific conversation place inside a Channel (a group chat, a private chat, the desktop window).
_Avoid_: Chat, conversation, thread, session

**Delivery**:
Sending the companion's reply text out to its Focus Room through that Room's Channel.
_Avoid_: Send, dispatch, output

## Mind

**Signal**:
Anything that asks for the companion's attention: either something said in a Room, or an internal prompt raised by an extension (e.g. "you haven't talked to the Owner today").
_Avoid_: Message, event, input, nudge, trigger

**Queue**:
Where Signals wait until the companion attends to them.
_Avoid_: Inbox, mailbox, buffer

**Timeline**:
The single, never-ending, persisted record of everything the companion has experienced and said, shared by all Rooms.
_Avoid_: Session, history, conversation

**Run**:
One uninterrupted stretch of the companion thinking and acting, from being woken by input until it goes idle; at most one Run exists at a time.
_Avoid_: Loop, job, task

**Turn**:
One model response within a Run, plus the tool calls it made and their results.
_Avoid_: Step, round, iteration

**Notice**:
A narration the kernel writes into the Timeline about something that happened to the companion (a failed or interrupted Run), so it can react later.
_Avoid_: Error message, system event

**Section**:
A named, rarely-changing part of the companion's standing instructions (persona, memory, a Channel's description).
_Avoid_: Prompt fragment, block, segment

**Recall**:
Memories surfaced into the Timeline just before the companion attends to new Signals, so it "remembers" while reading them.
_Avoid_: Retrieval, RAG, context injection

**Compaction**:
Replacing the oldest part of the Timeline's working context with a summary so it fits the model's window; the Timeline itself is never deleted.
_Avoid_: Truncation, summarization, pruning

**Focus Room**:
The one Room a Run is attending to, where its replies go by default; a Run may have none.
_Avoid_: Current chat, active room, source

**Trace**:
The optional observability record of how the companion behaved (scheduling, requests, tool calls, recalls), separate from the Timeline.
_Avoid_: Log, history, audit

**Silence Token**:
A reserved reply (`[[NO_REPLY]]`) that, when it is the whole of the companion's reply, means it chooses not to speak.
_Avoid_: NO_REPLY flag, skip

## Building blocks

**Extension**:
The single plug-in unit of Sofia; Channels, persona, memory, compaction and tooling are all Extensions.
_Avoid_: Plugin, module, addon

**Model Role**:
A named purpose (e.g. `main`, `cheap`) bound in configuration to a concrete model on a concrete provider.
_Avoid_: Model alias, tier
