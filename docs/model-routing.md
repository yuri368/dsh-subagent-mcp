# Codex worker model routing

`codex_delegate` selects its model locally without a classifier request. Omit
`task_kind` for ordinary work. New ordinary, complex and uncertain tasks use
`gpt-6.1-sol` with medium effort; `task_kind: simple` selects `gpt-6-luna` with
medium effort. Use simple only for clear mechanical, repetitive tasks.
`ambiguous` behaves as normal. An explicit available `model` overrides the
selection, except Astra, which is forbidden for DSH-to-Codex requests.
`DSH_CODEX_MODEL` and `DSH_CODEX_EFFORT` remain explicit installation defaults
for backward compatibility. Remove an old global Luna default or change it to
Sol to get the normal policy; the simple route still selects Luna/medium.

Luna permits medium, high, xhigh and max. Sol permits those levels and ultra.
New explicit none/minimal/low requests are rejected before a worker is launched.
Older installation or conversation defaults below medium are raised to medium
on the next invocation without editing their historical records. Safe saved
efforts are retained; missing effort is always explicitly sent as medium.

Follow-ups without classification retain the previous ordinary model and effort.
An explicit normal/ambiguous classification promotes a previous simple worker to
the normal default. Each result contains `routing` with task kind, model, effort
and reason. Owner-scoped persisted records keep `routing_history` on every
accepted invocation. Model directory availability is checked before work; that
directory check alone does not prove paid account access or successful inference.

`codex_delegate` accepts Sol and Luna workers. Any DSH-to-Codex request selecting
Astra is rejected with `ASTRA_DELEGATION_FORBIDDEN` before dispatch. This rule
applies to the bridge's DSH delegation interface; it does not manage or restrict
Codex's built-in subagents. Astra tool isolation is outside this project's
current scope.
