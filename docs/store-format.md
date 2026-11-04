# A2UI Pane Store Format

This document is the on-disk contract for the A2UI pane store. Any process that writes pane surfaces must follow it. The writers today are the a2ui-pane MCP server, the a2ui-pane sidecar, and the Python `/monitor` and `/monitor-cls` daemons in `cheats`.

The TypeScript implementation lives in [`packages/protocol/src/store-fs/`](../packages/protocol/src/store-fs/) and is exported as `@a2ui-pane/protocol/store-fs`. When this document and that code disagree, file a bug: both are meant to say the same thing.

The key words MUST, MUST NOT, SHOULD, and MAY are used as described in RFC 2119.

## Layout

```text
${PLUGIN_DATA}/conversations/
  <convId>/                   # one directory per conversation, mode 0700
    .lock                     # writer lock, present only while a writer commits
    _seq                      # decimal high-water seq for the conversation
    <surfaceId>.jsonl         # exactly 1 StoreLine holding the surface's full snapshot
    ...
  <convId>.jsonl              # legacy flat log (before migration)
  <convId>.jsonl.migrated     # legacy flat log after migration
```

- `<convId>` and `<surfaceId>` match `^[A-Za-z0-9_-]{1,128}$`.
- Surface ids MUST NOT start with `_` or `.`. Those names are reserved for store files.
- Directories are created with mode `0700`. Files are created with mode `0600`.
- Each live surface has exactly one file. A surface with no file does not exist.

### Reserved names

These names inside `<convId>/` are never surfaces. Readers MUST ignore them:

| Name                     | Purpose                                                  |
| :----------------------- | :------------------------------------------------------- |
| `_seq`                   | Conversation high-water seq.                             |
| `.lock`                  | Writer lock.                                             |
| `.lock.steal`            | Guard held by a waiter while it removes a stale `.lock`. |
| `.<surfaceId>.tmp-<pid>` | Temporary file for a surface write before `rename`.      |
| `._seq.tmp-<pid>`        | Temporary file for a `_seq` write before `rename`.       |

Readers MUST only treat files matching `^[A-Za-z0-9-][A-Za-z0-9_-]*\.jsonl$` as surface files.

## Surface files

A surface file holds exactly one JSON line, followed by a single `\n`. Writers MUST NOT append to a surface file. Every change replaces the whole file (see [Atomic writes](#atomic-writes)).

The line is a `StoreLine`:

```json
{
  "seq": 42,
  "callId": "call_monitor_42",
  "ts": "2026-11-04T18:40:00.000Z",
  "message": {
    "version": "1.0",
    "createSurface": {
      "surfaceId": "monitor",
      "catalogId": "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json",
      "sendDataModel": true,
      "components": [{ "id": "root", "component": "Column", "children": [] }],
      "dataModel": { "items": [] }
    }
  }
}
```

| Field                              | Type    | Rules                                                                                                                        |
| :--------------------------------- | :------ | :--------------------------------------------------------------------------------------------------------------------------- |
| `seq`                              | integer | Positive. Unique within the conversation. Greater than the `_seq` value that was current before the write.                   |
| `callId`                           | string  | Matches `^[A-Za-z0-9_-]{1,128}$`. Names the write, for example `call_monitor_42`.                                            |
| `ts`                               | string  | ISO 8601 UTC time of the write.                                                                                              |
| `message.version`                  | string  | Protocol version of the surface. Readers MUST accept `"1.0"`, `"v1.0"`, and `"v0.9"`. New v1.0 writers SHOULD write `"1.0"`. |
| `message.createSurface`            | object  | The complete current state of the surface.                                                                                   |
| `message.createSurface.surfaceId`  | string  | MUST equal the file name without `.jsonl`.                                                                                   |
| `message.createSurface.components` | array   | Every component of the surface, each with its `id` and `component` type.                                                     |
| `message.createSurface.dataModel`  | any     | The complete data model. Omit it for an empty model.                                                                         |

The other `createSurface` fields (`catalogId`, `theme`, `sendDataModel`, `rootId`, `metadata`) are copied from the surface's original `createSurface` message.

A reader rebuilds a surface by sending the stored `createSurface` to a fresh A2UI message processor. Snapshots never contain `updateComponents` or `updateDataModel` messages: writers fold those into the snapshot before writing.

## `_seq`

`_seq` holds one decimal integer, optionally followed by `\n`. A missing `_seq` reads as `0`.

- Every write that changes the conversation increases `_seq`. A write that creates, replaces, or deletes `n` surfaces assigns them the seqs `_seq + 1` through `_seq + n` and then sets `_seq` to `_seq + n`.
- Deleting a surface consumes a seq even though no file holds it. Readers use that seq for the delete event they emit.
- Writers SHOULD use `max(_seq, seq of the file being replaced)` as the base, so a damaged `_seq` never makes a seq go backward.
- Writers MUST write `_seq` last, after every surface file write and unlink of the commit.
- Readers MAY use `_seq` as a cheap change detector: if it has not changed, nothing has.

A reader that diffs the directory against an earlier read MUST read `_seq` before listing the directory. A surface re-created after that read then has a seq above the delete event's seq.

## Atomic writes

Every file write, surface or `_seq`, uses write-then-rename:

1. Write the full content to the temporary name (`.<surfaceId>.tmp-<pid>` or `._seq.tmp-<pid>`) in the same directory, with mode `0600`.
2. `rename` the temporary file over the final name (`os.replace` in Python).

Deleting a surface is a plain `unlink` of its file. Because `rename` and `unlink` are atomic, readers never take the lock and never see a partial file.

## Lock protocol

All writes to a conversation happen while holding `<convId>/.lock`. Hold the lock only for the commit itself: read `_seq`, read the affected surface files, write them, write `_seq`, release.

### Acquire

1. Create the directory if it is missing (mode `0700`).
2. Create the lock with `O_CREAT | O_EXCL | O_WRONLY` and mode `0600`. On success, write `<pid> <iso-timestamp> <token>\n`, where `<token>` is a random string, close the file, and hold the lock.
3. If the create fails with `EEXIST`, `stat` the lock. A lock is stale when its file **mtime** is more than 10 seconds old.
   - Missing or not stale: sleep 5 ms and go back to step 2.
   - Stale: steal it as described below. Go back to step 2 without sleeping only if the steal removed the stale lock. Otherwise sleep 5 ms first.
4. Give up after 2 seconds of retries and report a lock timeout. The TypeScript code throws `StoreLockError`. The Python writers return `"unavailable"`.

### Steal a stale lock

Only the holder of the steal guard, `.lock.steal`, may remove `.lock`:

1. Create `.lock.steal` with `O_CREAT | O_EXCL | O_WRONLY` and mode `0600`, and close it.
   - If that fails with `EEXIST`, another waiter is stealing. If the guard's mtime is more than 10 seconds old, its owner died mid-steal: `unlink` the guard. Either way, sleep 5 ms and go back to step 2 of [Acquire](#acquire).
2. While holding the guard, `stat` `.lock` again. If it is missing or no longer stale, `unlink` the guard, sleep 5 ms, and go back to step 2 of Acquire.
3. Otherwise `unlink` `.lock`, then `unlink` the guard, and go back to step 2 of Acquire at once.

The re-check under the guard is what makes stealing safe. Holders never touch the lock's mtime after creating it, so a `.lock` that is stale while you hold the guard is the abandoned one: nobody can create a fresh `.lock` until it is gone, and no other waiter can remove it while you hold the guard.

Do not steal by renaming `.lock` out of the way. A waiter whose staleness check is out of date then moves a fresh lock, and while it puts the lock back another writer can take it, so two writers hold the lock at once.

#### Known limit

The guard closes the race between live waiters, but not every race after a crash. If a waiter dies while holding `.lock.steal`, two waiters can both see the dead guard as stale. One removes it, a third creates a fresh guard, and the second, acting on its earlier check, removes that fresh guard too. Two waiters then hold a guard, and one of them may remove a lock the other has just taken. This needs a crash inside a window of a few system calls, followed by contention within the next 10 seconds. The store accepts that risk rather than adding a second level of guards.

If writing the lock contents fails after the create, the writer unlinks its own `.lock` before reporting the error, so no tokenless lock is left behind.

### Release

Read `.lock` and `unlink` it only if it still holds your token. A lock can only lose its token if the holder kept it past the 10 second stale limit, which a correct writer never does.

## Writer rules

- Never append to a surface file. Always replace it.
- Never leave more than one line in a surface file.
- Write files only under the lock, and write `_seq` last.
- Never write a surface id that starts with `_` or `.`.
- A surface is deleted by unlinking its file and increasing `_seq` by 1.

## Legacy flat files

Before this layout, each conversation was one append-only file, `conversations/<convId>.jsonl`, holding every `createSurface`, `updateComponents`, `updateDataModel`, and `deleteSurface` message in order.

Only the TypeScript `migrateLegacyStore` folds legacy files. It runs on the first read or commit of a conversation that has `<convId>.jsonl` and no `<convId>/_seq`. Under the lock it:

1. Folds every legacy line into per-surface snapshots, skipping lines that fail to fold.
2. Writes one file per surviving surface. Each file's seq is the seq of the last legacy line that touched the surface.
3. Writes `_seq` as the last legacy seq.
4. Renames the legacy file to `<convId>.jsonl.migrated`.

If a migration stops after writing `_seq` but before the rename, the next migration attempt finds `_seq` and the legacy file together. It only renames the legacy file to `.migrated`, because the per-surface files already hold its state.

Other writers MUST NOT fold or migrate legacy files. When `<convId>.jsonl` exists and `<convId>/_seq` does not, a non-TypeScript writer waits up to 2 seconds for `_seq` to appear, polling **without** holding the lock so it cannot deadlock with the migrator. If `_seq` does not appear, it gives up and lets a TypeScript writer (for example a `render_a2ui` call) trigger the migration.

The sidecar's cleanup sweep deletes `.jsonl.migrated` files after 30 days.

## Stream events

The sidecar streams the store to the pane over Server-Sent Events:

- `snapshot`: `{"lines": [StoreLine, ...]}`, the complete set of live surfaces, sorted by seq. Sent once per connection.
- `line`: one `StoreLine`. A line whose message is `createSurface` replaces the surface. A line whose message is `deleteSurface` means the surface's file is gone.
- `reset`: kept for one release so a pane built before this layout reconnects.
