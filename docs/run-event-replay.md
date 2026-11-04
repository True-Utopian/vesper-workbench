# Durable run-update replay

By **true-utopian**. This describes an **unreleased source candidate**. The accepted installed release is Browser 0.4.12 / Workbench 0.5.17; its public inventory remains 82/106 until the changed packages, installed pair and matching CI pass.

Workbench exposes authenticated server-sent events at `GET /api/v1/events` and the compatible `/api/events` alias. Each `run` frame contains a complete changed run record and an `id` shaped as `journal-uuid:sequence`. The ID is sent only after an atomic journal replacement and filesystem synchronization. A reconnect supplies that ID in `Last-Event-ID`; retained frames after it are replayed in order, followed by live commits. Clients may deduplicate by ID.

This is notification replay. It never submits, resumes, repeats or rolls back a browser action. The canonical run/coordinator journals remain authoritative. Their writes and notification commits are separate transactions: a notification is not proof that a remote action completed or that the run journal committed. Startup reconciles current canonical run snapshots into the notification history, including recovery states.

## Refresh and failure contract

- A new stream, an expired cursor, another journal's cursor or a cursor ahead of history receives an `event: reset` frame. Its ID is the current watermark; its data identifies `GET /api/v1/runs` as the full refresh route. Fetch canonical state and continue consuming updates. Workbench buffers newer received records while that refresh is pending, so the older response cannot overwrite them.
- Malformed cursors return HTTP 400. Missing authentication returns 401; unrelated origins return 403. Cookie logout immediately closes that session's streams. After a service restart, sign in again because cookie sessions are intentionally held in memory. Bearer clients can reconnect using the same journal cursor.
- Retention is bounded by 512 snapshots and an 8 MiB serialized journal. A single run notification is limited to 1 MiB; queued notifications are bounded at 8 MiB. An excessively slow stream is closed when its output buffer would exceed 2 MiB; reconnect with the last consumed ID, or handle `reset` if its history expired.
- The UI buffers at most 512 changed runs or 4 MiB during refresh. Overflow requests another full refresh. Responses started before logout cannot populate a newly signed-in workspace.
- If history persistence fails or capacity is exceeded, existing streams close and new streams return 503 until service restart. Run-state reads remain available. No failed write advertises a committed ID. Corrupt history refuses startup and is preserved for inspection rather than silently replacing its epoch.

The private `run-events.json` file lives inside Workbench's data directory with the same run snapshots available to authenticated API clients. It is created with owner-only file permissions where the operating system supports them. Include it in private backup handling; do not publish it. It is bounded notification history, not an audit archive or an action-recovery log.

## Client example

Use a numeric loopback origin and the locally generated access token. The following request resumes from an ID previously consumed by the client:

```http
GET /api/v1/events HTTP/1.1
Authorization: Bearer <local-access-token>
Last-Event-ID: <journal-uuid>:<sequence>
```

```text
id: <journal-uuid>:<next-sequence>
event: run
data: {"id":"<run-id>","state":"saved", "...":"remaining run fields"}

```

The normal browser `EventSource` handles `Last-Event-ID` automatically on reconnect while the same object remains active. On `reset`, refresh from the run-list route. Do not store bearer credentials in query parameters.

## Qualification boundary

The source tests cover ordered disconnected replay, ordinary restart, committed history after abrupt termination of an owned test service, retained cursor continuity, bounded retention, malformed/foreign/future cursors, corrupted history preservation, failed writes, authentication/origin restrictions, logout and normal stream shutdown. Real Workbench-page checks use synthetic owned records and the existing local Chromium executable; they cover reconnection feedback, cursor use, refresh races, failure recovery, sign-out races and desktop/narrow layouts.

These source/owned-fixture results do not qualify the installed add-on, standalone application, real script/managed-flow lifecycle replay matrix or full product crash recovery. Those checks remain necessary before this milestone advances. No native kernel or user profile is changed by these tests.
