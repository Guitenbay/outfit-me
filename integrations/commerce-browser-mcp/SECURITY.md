# Security notes

- Keep `ALLOW_STATE_CHANGING_ACTIONS=false`.
- Do not provide account passwords, SMS codes, payment passwords, bank card data, or identity numbers to the MCP client.
- Complete login and CAPTCHA challenges directly in the visible browser window.
- The browser profile directory contains login state. Do not commit, upload, or share it.
- Do not point `BROWSER_PROFILE_DIR` at your normal Chrome or Edge profile.
- Keep the server local. If Streamable HTTP mode is used, bind and firewall it as a local-only service unless authentication is added.
- Review MCP tool calls in the client. The supplied Codex example uses `default_tools_approval_mode = "prompt"`.

## Authorized-tab extension mode

- The bridge binds only to a loopback address and requires a random token of at least 32 characters.
- The user must explicitly select the active tab in the extension. The MCP cannot enumerate or silently adopt unrelated tabs.
- The extension has no Cookie permission and does not export, copy, or return cookies or browser-profile data.
- Only exact HTTPS public-shopping hosts/routes listed in the extension policy are eligible (not arbitrary subdomains or 360buy). Credentials, non-default ports and nonempty fragments remain forbidden. Python, worker and isolated-world guards check independently before authorization/navigation and on results.
- Ordinary query parameters are accepted by default, including unknown tracking keys, duplicates, JD `a` and Taobao `tab`. A small explicit action-key denylist (`action`, `act`, `method`, `command`, `cmd`, `operation`, `op`, `buy`, `buynow`, `addtocart`, `checkout`, `pay`, `submit`) is matched case-insensitively with hyphens/underscores removed. Values of ordinary search/tracking keys are not treated as actions.
- Routing keys (`redirect`, `redirecturl`, `redirecturi`, `return`, `returnurl`, `returnuri`, `next`, `nexturl`, `url`, `target`, `targeturl`, `destination`, `dest`, `callback`, `callbackurl`, normalized as above) are checked only for URL-like values beginning with a scheme, `/`, `.` or `?`. Such targets resolve against the current URL and must satisfy the same public-route policy, with at most three nested routing targets; external/sensitive targets fail closed. Plain labels and ordinary `from`/`source` parameters are not blocked. This is not a general redirect detector: actual navigation remains independently scoped and revokes grants when leaving public shopping routes. Popup diagnostics expose only bounded parameter names, never values or full URLs.
- Leaving the allowed hosts, closing the tab, disconnecting, or losing the bridge heartbeat revokes usable authorization.
- Element references are bound to one document generation and one element-list generation. Stale references fail closed.
- Password, verification, payment, bank-card, identity, and OTP inputs remain manual. Sensitive field values are redacted from element listings.
- `ALLOW_STATE_CHANGING_ACTIONS=true` is rejected in extension mode. Purchase, cart, checkout, payment, favorite, follow, delete, address, order, and account mutations remain blocked.
- Independent JD and Taobao grants share one loopback bridge. `browser_close(platform=...)` revokes only that grant; without a platform it revokes both and stops the bridge. It never closes Chrome or tabs.
- Grants live only in worker memory. Extension reload/worker restart requires explicit reauthorization; no automatic tab adoption. Optional host permissions are requested from the popup click for exact public-shopping hosts only; Chrome grants host-wide access, so strict route checks in Python, the worker, and the isolated-world operation enforce the narrower scope.
- DOM click/type/submit and browser-history navigation are disabled, including SKU selection. Use explicit public shopping URLs and manual SKU selection. Login/account routes are excluded; login and CAPTCHA remain manual.
- Commands bind immutable client ID, platform, request ID and absolute expiry. Claim is one-shot; expired/replaced grants, late/duplicate/unknown results are rejected. Pending commands/results share an eight-entry bound and are removed on cancellation, timeout or revocation. HTTP bodies are capped at 1 MB; bearer comparison uses constant-time comparison.
- Navigation uses the configured navigation timeout, an independently running heartbeat, and observer cleanup on completion/failure/timeout/revocation. A timeout cannot undo a navigation already sent to Chrome; it prevents subsequent command steps, never reports that navigation as successful.
- Extension-origin cross-origin fetch uses the declared loopback host permission (no web-page CORS access is enabled). No token is exposed in CORS headers or logs.
- Keep the bridge token private. It is local authorization material and should not be committed or shared.
