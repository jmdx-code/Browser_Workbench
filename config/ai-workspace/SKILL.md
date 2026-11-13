---
name: workbench-operator
description: >-
  Operate Browser Workbench and controlled Chrome / BlueStacks browsers via MCP tools (`wb_*`).
  Activate whenever the user asks to run or schedule active-accounts task combinations (Reels/Feed/Marketplace browsing, friend requests, posting) or inspect execution records,
  schedule or run Facebook group posting (including reading Excel/CSV tables of Pages and Groups),
  run Chrome or BlueStacks group/page bumping (including sound toggle, comment pools, and settings),
  invite friends to groups, control browser/BlueStacks lifecycles, diagnose stuck tasks,
  or automate any external website using their logged-in Chrome profiles.
---

# Browser Workbench Operator Runbook

You have direct access to the Browser Workbench MCP server (`wb_*` tools, registered under `browser-workbench` / `browser_workbench` / `workbench`) connected to the live `Browser Workbench` desktop controller (`127.0.0.1:18767`). Follow these operational rules to execute tasks accurately, save tokens, and report 100% ground-truth results.

## 1. Three-Tier Execution Strategy (Always Prefer Native Capabilities First)

1. **Tier 1 — Native Workbench Modules (Zero LLM Tokens During Execution)**
   - Active Accounts Task Combinations & Unified Execution Records (`活跃账号` + `执行记录`: query saved combinations & active plans via `action="state"`, start immediate or scheduled/time-window combinations via `action="start"`, `pause` / `resume` / `stop`, `save_settings`, or query paginated `records`, monitored via `wb_wait_for_task(module="active-accounts")`): `wb_active_accounts_control`.
   - Facebook Group Posting (immediate & scheduled, with offline browser auto-launch when `accountMode="selected"`): `wb_poster_save_material` -> `wb_poster_dispatch` -> `wb_wait_for_task` -> `wb_poster_logs`.
   - Chrome Group Bumping / Page Bumping (immediate & scheduled via `action="start" | "scan_only" | "schedule" | "cancel_task" | "delete_task"`, auto-adding missing Group/Page URLs/IDs and auto-launching offline browsers): `wb_bumper_control`.
   - Group Friend Inviter (manage inviter groups via `list_groups` / `add_groups` / `delete_groups` / `refresh_groups`, configure `save_settings`, and `start` / `stop` with Group URL extraction & offline browser auto-launch): `wb_inviter_control`.
   - Registered Browser Lifecycle, Tab Cleanup & Window Layout (`open` / `close` / `restart` / `status` / `cleanup_tabs` / `show_window` / `arrange_windows` / `restore_windows`, strictly for extension-registered profiles using normal launch args with zero automation flags): `wb_browser_lifecycle`.
   - BlueStacks Multi-Instance & FB Lite Group + Page Bumper (`state` / `refresh` / `launch` / `close` / `inspect` / `rename_instance` / `save_paths` / `save_settings` / `save_page_settings` including `enableSound` sound toggle / `save_comments` / `logs` / `start_bumper` / `stop_bumper` / `start_page_bumper` / `stop_page_bumper`; `instanceIds` accepts friendly window names like `"p023"`, FB account names like `"Mawi Lee"`, ADB ports like `"5565"`, or UUIDs; monitored via `wb_wait_for_task(module="bluestacks-group-bumper" | "bluestacks-page-bumper")`): `wb_bluestacks_control`.
   - Local `.xlsx` / `.csv` / `.tsv` / `.json` Spreadsheets: `wb_read_table` (built-in parser, no Python needed).
2. **Tier 2 — Zero-Token Natural Browsing (`browseSeconds`)**
   - When the user asks to _"open a group/page and browse naturally for 3 minutes"_, call `wb_browser_open(profileId, url, browseSeconds=180)` and then `wb_browser_close(profileId)`. Node executes randomized human-like scrolling and reading pauses locally with **0 token consumption**.
3. **Tier 3 — Step-by-Step General Web Automation (`wb_browser_*`)**
   - Use ONLY for custom web tasks not covered by Tier 1/2 (e.g., creating/editing a Google Sheet in Google Drive, filling forms, extracting data on external sites).
   - Workflow: `wb_browser_open` -> `wb_browser_observe` (reads `[e1..eN]` refs & visible text, saving ~90% tokens vs screenshots) -> `wb_browser_act(ref="e...")` -> `wb_browser_close`.
   - Call `wb_browser_screenshot` only when inspecting Canvas UIs (such as Google Sheets grid cells) or ambiguous visual layouts.
   - **Always** call `wb_browser_close` when finished so the temporary tab closes and the browser returns to `PAUSED / synced: true` without touching the user's own tabs.

## 2. End-to-End Playbook: "Post According to Spreadsheet at Scheduled Time"

When the user says e.g. _"按照表格里的专页和小组几点开始发帖"_:

1. **Read the Spreadsheet**:
   - Call `wb_read_table(filePath=...)` to inspect `sheetNames`, `headers`, and `rows` (`_rowNumber`, Page name/ID, Group name/URL/ID, Caption, Media path/Google Drive link, Scheduled time). Numeric Excel `.xlsx` date/time cells are automatically converted to `"HH:mm"` / `"YYYY-MM-DD HH:mm"`.
2. **Match Pages to Registered Browsers (Online or Offline)**:
   - Call `wb_get_overview` or `wb_list_profiles(onlineOnly=false)` (Workbench strictly exposes ONLY browser profiles that have installed our extension and paired; uninstalled local profiles are never scanned or exposed). Each profile exposes `profileId`, `browserName` (e.g. `"用户8"`), `displayName`, `alias`, `online`, and `account` (`name`, `id`, `identityType`, `state`).
   - If a matched registered browser is currently **offline**, you do NOT need the user to open it manually: `wb_active_accounts_control` (`start`), `wb_poster_dispatch` (`accountMode="selected"`), `wb_bumper_control` (`start` / `schedule`), `wb_inviter_control` (`start`), and `wb_browser_open` will automatically launch it with normal parameters (`--profile-directory`, `--user-data-dir`, `--window-name`) and wait for extension sync, or you can pre-launch it explicitly via `wb_browser_lifecycle(action="open", profileIds=[...])`.
   - If any online browser has `account.state === "unknown"`, missing `account.name`, or no Facebook tab open, call `wb_inspect_profiles(mode="auto")` first — when passive inspection has no Facebook tab (`INSPECTION_DOCUMENT_NOT_READY`), Workbench silently opens a temporary background Facebook tab, reads & caches the active Page/Account identity, and closes the temporary tab without touching user tabs or window focus.
   - Match each row's Page name or numeric ID to `profile.account.name` / `profile.account.id` (or `profile.browserName` / `profile.alias`). Note: all `profileId` / `profileIds` tool parameters accept UUID, `browserName`, `alias`, Page `name`, or numeric FB ID directly (and refuse with `AMBIGUOUS_PROFILE_IDENTIFIER` if multiple registered browsers share the same label). Similarly, `wb_bluestacks_control` `instanceIds` / `instanceId` accept window name (`"p023"`), alias, FB account name, ADB port (`"5565"`), or UUID directly.
   - If a required Page is not found among registered profiles, or its account is `restricted` / `verification` / `logged-out`, explicitly report which Page is unavailable instead of guessing another account.
3. **Match or Add Target Facebook Groups / Pages**:
   - Call `wb_manage_targets(action="list", kind="groups" | "pages")` to match group/page names or numeric IDs.
   - If Group or Page URLs / numeric IDs are not yet in the library, `wb_poster_dispatch`, `wb_bumper_control`, `wb_inviter_control`, and `wb_bluestacks_control` (`autoAddMissingTargets=true` / `autoAddMissingGroups=true`) or `wb_manage_targets(action="add")` will register them automatically. If a spreadsheet only has a fuzzy group name that doesn't exist in the library, ask the user for the group link/ID rather than guessing.
4. **Save & Preflight Materials**:
   - Call `wb_poster_save_material(action="save", prepareNow=true, items=[...])`.
   - Verify every material's `prepareResults[].ready === true` and `cacheStatus === "ready"`. If a local video/image path is missing or a Google Drive link fails download, report the exact `cacheError` immediately before scheduling.
5. **Dispatch Immediate or Scheduled Tasks**:
   - Call `wb_poster_dispatch(action="create_tasks", tasks=[{ materialId, groupIds, accountMode: "selected", profileIds: [matchedProfileId], scheduledAt }])`.
   - `scheduledAt` accepts `"20:30"`, `"明天 09:00"`, `"2026-11-11 20:30"`, ISO strings, epoch ms, or `null` (immediate). Check `rolledToNextDay` in the response to confirm `"HH:mm"` landed on the intended date!
6. **Monitor & Verify Ground Truth**:
   - For immediate tasks (or scheduled tasks due within 90s), call `wb_wait_for_task(module="group-poster", taskIds=[...])`.
   - Verify actual `newVerifiedPosts` (`postId`, `postUrl`, `groupId`, `accountName`, `identityType`) via `wb_wait_for_task` or `wb_poster_logs`.

## 3. Ground-Truth State & Fault Handling Rules

- **Never equate dispatch with completion**:
  - `status: "scheduled"` means queued for future timer trigger; `status: "running"` means workers are executing; only `postedCount > 0` with persisted `PosterLog.postUrl` proves posts were published.
  - Report `postedCount`, `skippedCount` (groups skipped because the same material was already posted there), and exact `statusReason`.
- **Handle Restrictions & Unsettled Operations Safely**:
  - If `wakeReason === "account_restricted_detected"` or `profileCounts[id].restricted === true`, that account hit Facebook restriction/checkpoint. Never keep retrying that browser; inform the user which browser/Page was restricted and how many groups remain.
  - If `pendingReviewOperations` is non-empty (`ENDED_UNKNOWN` / `PENDING_REVIEW`), warn the user that submission outcome was uncertain on that browser/group — **never** blindly re-send the same post to that group before human check.
- **First-Response Diagnostics & Stuck-Browser Self-Healing**:
  - Whenever a task hangs, fails, or misses a button, call `wb_diagnose(action="inspect", levels=["WARN", "ERROR", "WAIT"])` (and `action="tail_log_file"` if deeper history is needed) to inspect `dev-diagnostics.jsonl` and bridge `unresolved` state before reporting root cause.
  - If a specific registered browser window or webpage is frozen/unresponsive (e.g. repeated command timeouts on one `profileId` while other browsers run fine), call `wb_browser_lifecycle(action="restart", profileId=...)` to safely stop that profile's runner, close only that profile's windows (without killing shared Chrome/Brave/Edge processes or touching other windows), and relaunch it cleanly with normal arguments (`PENDING_REVIEW` unsettled records remain protected and will not double-post).
  - If `wb_get_overview` or `wb_browser_open` reports `supportsAgentBrowser: false` / `EXTENSION_RELOAD_REQUIRED`, call `wb_diagnose(action="reload_extensions")` once while browsers are idle.

## 4. Security & Human-Handoff Guardrails

- **Strict CAPTCHA / 2FA Prohibition**:
  - Never attempt to click, solve, compute, or bypass any CAPTCHA (`reCAPTCHA`, `hCaptcha`, `Cloudflare Turnstile`, `Altcha`) or 2FA/Checkpoint challenge.
  - When `humanGate.required === true` or `CAPTCHA_HUMAN_REQUIRED` is returned, call `wb_browser_act(profileId, action="bring_to_front")` and ask the user to complete verification manually in the browser window.
- **Destructive Action Confirmation**:
  - Ask the user before deleting profiles, bulk-deleting materials/targets/logs, or launching large live campaigns when target scope was not explicitly specified.
