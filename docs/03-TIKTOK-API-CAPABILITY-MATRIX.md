# 03 — TIKTOK SHOP API CAPABILITY MATRIX

> Phase 0 deliverable. **No live API call was made.** There is no Partner Center
> app, no `app_key`, no `app_secret`, and no shop authorization on this machine.
> Everything below is documentation evidence, labelled by how it was obtained.

---

## 1. Verification Method and Its Limits

| Method | What it proves | What it does not prove |
|---|---|---|
| `curl` to `partner.tiktokshop.com` | Host is reachable (HTTP 200) | Nothing about API behaviour |
| `read_url` on Partner Center pages | Returned only the navigation shell (client-rendered SPA) | Page body **not** readable this way |
| Search-index extracts of the same official pages | Exact quoted endpoint paths, scopes, parameter names, error codes as published by TikTok | That the text is current beyond its snippet, and nothing about live behaviour |
| Third-party engineering blogs | Corroboration only | Never the basis of a decision |

**Therefore:** every row below is at best **DOCUMENTED**. No row is
**VERIFIED-LIVE**. Any statement in this repo that a capability "works" must be
read as "documented and not contradicted by a live test", unless a live test
record is cited.

**Blanket blocker for all live capability:** Affiliate API access is inactive by
default and requires application + approval from an account manager or partner
manager (official *Affiliate integration* page). No application has been
submitted. Every affiliate capability is therefore `BLOCKED (approval)` even
where the endpoint itself is well documented.

---

## 2. Status Legend

| Status | Meaning |
|---|---|
| `DOCUMENTED` | Official page states path/method/scope/behaviour; no live call |
| `PARTIALLY DOCUMENTED` | Some attributes known, others absent from accessible text |
| `UNVERIFIED` | Only third-party sources; **must not** be implemented |
| `BLOCKED (approval)` | Requires Partner Center category/scope approval we do not have |
| `BLOCKED (credential)` | Requires app credentials or an authorized shop |
| `NOT AVAILABLE` | Not supported in the target market |
| `SUNSET` | Removed by TikTok; must not be used |

---

## 3. Account, Category and Market Prerequisites

| Item | Requirement (documented) | Our state |
|---|---|---|
| Developer account | TikTok Shop Partner Center partner account | Not created |
| Business guide | "For app developers (ISVs)" | Not selected |
| Category | `App Developer > Customer Engagement > Creator collaborations` (a.k.a. Affiliate) | Not applied |
| App types | `Affiliate (public)` for App Store listing; `Affiliate (custom)` for testing; `Connector (custom)` for non-affiliate APIs | None created |
| Affiliate API activation | Inactive by default; requires approval from Account Manager / Partner Manager | **BLOCKED** |
| Compliance review | Public apps need app testing, review, listing, and compliance review | N/A |
| Market availability | Affiliate APIs are explicitly **not** available in the UK and EU. The Indonesia/Tokopedia one-pager states "All existing APIs in the online API reference list will be available in the Indonesian market, unless otherwise specified." Exact per-endpoint ID availability requires the "View app categories" panel in Partner Center. | **PARTIALLY VERIFIED** |

> **Indonesia conclusion (honest form):** no official source found states that
> affiliate APIs are unavailable in Indonesia, and one official Indonesia page
> implies availability. This is *not* confirmation for our app category. It must be
> confirmed in Partner Center with the actual account, or in writing from the
> partner manager, before Phase 2 commits to live integration.

---

## 4. Authorization Capabilities

### AUTH-1 — Seller authorization (ROW)
- **Feature:** obtain seller consent and an `auth_code`
- **Authorization URL (ROW):** `services.tiktokshop.com/open/authorize?service_id={service_id}`
- **US URL:** `services.us.tiktokshop.com/open/authorize?service_id={service_id}`
- **Required:** `service_id` from the app detail page; registered redirect URL
- **Market:** ROW incl. Indonesia (Indonesia uses the ROW domain)
- **Scope:** the scopes requested by the app, returned in `granted_scopes`
- **Callback:** `{redirect_url}?code=…&state=…`; rejection → `code=null&error=auth_denied`
- **`auth_code` lifetime:** 30 minutes, single use
- **Status:** `DOCUMENTED`
- **Evidence:** *Authorization overview* (authorization-overview-202407), *Authorization*,
  *Seller authorization guide*, *Partner authorization guide* tables.

### AUTH-2 — Creator authorization
- **Authorization URL:** `shop.tiktok.com/alliance/creator/auth?app_key={app_key}&state={state}`
- **Required:** creator identity (`user_type = 1`), creator scopes
- **Status:** `DOCUMENTED`; `BLOCKED (approval)` if creator capability is allowlisted
- **Note:** creator tokens and seller tokens are not interchangeable.

### AUTH-3 — Partner (TAP) authorization
- **Authorization URL (ROW):** `partner.tiktokshop.com/open/authorize?service_id={service_id}`
- **User type:** `3` (current partner type; `2` is legacy)
- **Status:** `DOCUMENTED`; only relevant if we operate as a TAP. Not in initial scope.

### AUTH-4 — Token exchange
- `GET https://auth.tiktok-shops.com/api/v2/token/get`
- Params: `app_key`, `app_secret`, `auth_code`, `grant_type=authorized_code`
- **Trap explicitly documented:** `grant_type` is `authorized_code`, **not** the
  standard OAuth `authorization_code`.
- Response: `access_token`, `access_token_expire_in` (epoch seconds),
  `refresh_token`, `refresh_token_expire_in` (epoch seconds), `open_id`,
  optionally `seller_name`, `seller_base_region`, `user_type`, `granted_scopes`
- Default access-token validity: **7 days** (official test-token page)
- **Status:** `DOCUMENTED`
- **Security note:** this endpoint takes `app_secret` in the query string. It must be
  called server-to-server only, with the URL never logged. Our client will pass
  credentials in the query as the API requires but will redact the full URL in logs,
  storing only host + path + status.

### AUTH-5 — Token refresh
- `GET https://auth.tiktok-shops.com/api/v2/token/refresh`
- Params: `app_key`, `app_secret`, `refresh_token`, `grant_type=refresh_token`
- **Status:** `DOCUMENTED`
- Refresh token expiry is bound to the authorization duration; when it lapses the
  seller must re-authorize.

### AUTH-6 — Revocation / deauthorization
- `SELLER_DEAUTHORIZATION` webhook topic exists (documented under Update Shop Webhook)
- Explicit revoke endpoint: **not confirmed** in accessible text → `UNVERIFIED`
- Handling requirement: on deauthorization, mark connection `REVOKED`, stop jobs for
  that shop, notify tenant admins. Implemented on webhook, not on a guessed endpoint.

---

## 5. Core / Shop Capabilities

### CORE-1 — Get Authorized Shops
- `GET /authorization/202309/shops`
- Query: `app_key`, `timestamp`, `sign`; Header: `x-tts-access-token`
- Response: authorized shop list (shop id, cipher, name, region, type)
- **Status:** `DOCUMENTED`
- **Use:** verify a connection after OAuth; populate `shops`.
- **Evidence:** *Sign your API request*, *Call Get Authorized Shops*.

### CORE-2 — Request signing
- **Algorithm:** HMAC-SHA256, key = `app_secret`
- **Canonical string:** request path + alphabetically sorted `{key}{value}` for all
  query params **excluding** `sign` and `access_token` (and `x-tts-access-token`,
  which is a header and never signed) + raw request body (unless
  `multipart/form-data`), wrapped as `app_secret + string + app_secret`
- **`timestamp`:** 10-digit Unix seconds, valid window `[now − 5 min, now + 30 s]`;
  invalid → `36009004`
- **202309+:** token goes in `x-tts-access-token`, **not** in the query string, and is
  not signed
- **Status:** `DOCUMENTED`
- **Implementation rule:** sign the exact bytes sent; never re-serialize JSON after
  signing.

### CORE-3 — Webhooks
- Configure: `PUT open-api.tiktokglobalshop.com/event/202309/webhooks` with
  `app_key`, `timestamp`, `sign`, `shop_cipher`, `x-tts-access-token`; body
  `{ address, event_type }`, or via Partner Center
- **Verification:** signature is in the `Authorization` header (no `Bearer`), and is
  a lowercase-hex HMAC-SHA256 over `app_key + raw request body` keyed with
  `app_secret`. Must verify the **raw bytes** before JSON parsing, with a
  constant-time comparison.
- **Acknowledgement:** HTTP 200 with empty body within **3 seconds**; 401 on
  signature failure
- **Delivery:** at-least-once; dedupe by `tts_notification_id`
- **Documented topics include:** `ORDER_STATUS_CHANGE`, `RECIPIENT_ADDRESS_UPDATE`,
  `PACKAGE_UPDATE`, `PRODUCT_STATUS_CHANGE`, `SELLER_DEAUTHORIZATION`
- **Status:** `DOCUMENTED` (retry schedule — 2 min / 30 min / 3 h / 12 h — is
  **third-party sourced**, treat as unverified)
- **Endpoint requirements:** HTTPS on a domain, TLS 1.2+ (third-party sourced)

### CORE-4 — Rate limits
- **Mechanism:** dynamic QPS allocation; no single published fixed QPS; isolation
  unit is `app × authorized shop` for many endpoints
- **Sandbox:** 1000 requests/hour per sandbox user; HTTP 429 with code `36009037`
- **Client obligations:** adaptive throttling, batching, caching, exponential
  backoff with jitter, no blind retries on quota errors
- **Status:** `DOCUMENTED` for the mechanism and sandbox limit; per-endpoint limits
  `NOT PUBLISHED` in accessible text

---

## 6. Affiliate Seller API Capabilities

> All of these require seller authorization (`user_type = 0`) **and** the
> `seller.affiliate_collaboration.read` / `.write` scopes **and** category approval.
> All are `BLOCKED (approval)` today.

### AFS-1 — Create Open Collaboration
- `POST /affiliate_seller/202412/open_collaborations`
- Scope: `seller.affiliate_collaboration.write` (scope group 890884 *Manage Seller
  Affiliate Collaboration*)
- Body: products + commission rate; one product per open collaboration
- **Status:** `DOCUMENTED`; version `202405` is `SUNSET` (see §9)

### AFS-2 — Create Target Collaboration
- `POST /affiliate_seller/202508/target_collaborations`
- Scope: `.write`
- Semantics: private invitation to specific creators with selected products and terms
- **Status:** `DOCUMENTED`; version `202405` is `SUNSET`
- **Critical operational constraint:** invitations consume a weekly quota; when a
  creator's level is exhausted the API rejects with **`16024049`** — do not retry
  (see AFS-9)

### AFS-3 — Search Target Collaborations
- `POST /affiliate_seller/202508/target_collaborations/search`
- Scope: `.read`
- Body filters: invitation name/id, product name/id, creator name,
  `creator_accept_status` (`ACCEPT` | `ALL`), pagination
- **Status:** `DOCUMENTED`

### AFS-4 — Query Target Collaboration Detail
- `GET /affiliate_seller/202508/target_collaborations/{target_collaboration_id}`
- Scope: `.read`
- **Status:** `DOCUMENTED`

### AFS-5 — Search Open Collaboration Products (marketplace)
- `POST /affiliate_seller/202405/open_collaborations/products/search`
- Scope: `.read`
- Filters: category id, title keywords, sales price range, commission rate range;
  pagination via page token
- **Status:** `DOCUMENTED` (this version is not in the published sunset list; verify
  before implementation)

### AFS-6 — Seller Search Creator on Marketplace
- `POST /affiliate_seller/202508/marketplace_creators/search`
- Scope: `.read`
- Filters: keyword (username/nickname), GMV, follower demographics, `search_key`
  caching token, `creator_level` filter (added in the 2026-10 quota change)
- Data window: **last 30 days**
- **Status:** `DOCUMENTED`
- **Note:** a third-party article cites `202412` for this path — the official page
  says `202508`. Official wins; confirm at implementation time.

### AFS-7 — Search Seller Affiliate Orders
- `POST /affiliate_seller/202410/orders/search`
- Scope: `.read`
- Returns affiliate-commission-eligible orders: order id + product id per documented
  description; to be used with order search for conversion tracking
- **Status:** `DOCUMENTED` (full response schema not captured)

### AFS-8 — Generate Affiliate Product Promotion Link
- `POST /affiliate_seller/202405/products/{product_id}/promotion_link/generate`
- Scope: `.write`
- Response field seen in official example: `product_promotion_link`
- **Status:** `PARTIALLY DOCUMENTED` — path and version come from the official
  *Affiliate integration* guide example; the standalone endpoint page was not read.
  Do not implement until the endpoint page is confirmed.

### AFS-9 — Creator Outreach Quota
- `GET /affiliate_seller/202607/creator_outreach/quota`
- Scope: `.read`
- Returns: current GMV tier, max reachable creator follower count, consumed and
  remaining quota; `quota_detail[]` per creator level (added 2026-10)
- **Status:** `DOCUMENTED`
- **Behavioural change (2026-10):** quota moved from one shared weekly pool per shop
  to **one pool per creator level** (seller tier × creator level), bonus capacity
  consumed first, refresh Sunday. Rollout started US 2026-10-15, more markets
  following → **Indonesian rollout state UNVERIFIED**.

### AFS-10 — Check Creator Outreach Eligibility
- `POST /affiliate_seller/202610/creator_outreach/eligibility/check`
- Scope: `.read`
- Purpose: batch (up to 100) pre-check of `is_blocked` / `is_conform_to_threshold`
  before inviting
- **Status:** `DOCUMENTED` on the US domain page; global availability `UNVERIFIED`

### AFS-11 — Edit Open Collaboration Settings / Remove Creator from Collaboration
- Listed as APIs under scope group 890884 in the official scope mapping
- Exact paths **not captured** → `UNVERIFIED`

---

## 7. Affiliate Creator API Capabilities

Only relevant if creators authorize our app (assumption A3 says they will not,
initially).

### AFC-1 — Search Creator Target Collaborations
- `POST /affiliate_creator/202405/target_collaborations/search`
- Scope: `creator.affiliate_collaboration.read`
- Header: `x-tts-access-token` with a **creator** token
- Body: `shop_id`, keyword + keyword type, pagination
- **Status:** `DOCUMENTED`; `BLOCKED (approval)`
- Other creator capabilities (showcase, promotion link, shoppable video): `UNVERIFIED`

---

## 8. Affiliate Partner API (TAP) Capabilities

Out of initial scope (we are the seller's agency, not a TAP). Documented for
completeness; requires `partner.tap_campaign.write` and partner authorization
(`user_type = 3`).

| Capability | Endpoint | Status |
|---|---|---|
| Create Affiliate Partner Campaign | `POST /affiliate_partner/202405/campaigns` | `DOCUMENTED` |
| Publish Affiliate Partner Campaign | `POST /affiliate_partner/202405/campaigns/{campaign_id}/publish` | `DOCUMENTED` |
| Partially Edit Campaign | `POST /affiliate_partner/202405/campaigns/{campaign_id}/partial_edit` | `DOCUMENTED` |
| CAP / TAP order search | `POST /affiliate_partner/202405/{cap|tap}/orders/search` | `UNVERIFIED` (third-party only — do not implement) |

---

## 9. Deprecations and Version Policy

**Official sunset:** migration date **2026-10-12 10:00 (UTC+8)**. That date is in the
past relative to this baseline (2026-11-16), so the deprecated versions are assumed
already removed.

| API | Deprecated | Target |
|---|---|---|
| Create Open Collaboration | `202405` | `202412` |
| Create Target Collaboration | `202405` | `202508` |
| (other 2024 historical versions and 2022 legacy affiliate endpoints) | see sunset page | latest version / replacement; some have no replacement |

**Policy:** pin each endpoint's version explicitly in code, record the source URL and
date in the endpoint module, and re-check the Changelog page at the start of every
phase. No endpoint path is composed from a variable like `latest`.

---

## 10. Error Codes Worth Handling Explicitly

| Code | Meaning | Handling |
|---|---|---|
| `36009004` | Invalid timestamp (outside ±window) | Fix clock; regenerate timestamp **and** signature together; never silently retry with the same sign |
| `36009037` | Sandbox QPH exceeded (429) | Back off; sandbox only |
| `16024049` | Creator outreach quota exhausted for that level | **Do not retry**; drop the level for the run, refresh quota next Sunday |
| `36004004` | Auth code already used/expired (third-party sourced) | Treat as unrecoverable → restart authorization |
| unknown | Unmapped | Log `code` + `message` only; surface `upstream` error without payload |

---

## 11. What Must Be Confirmed Before Phase 2

1. Partner Center account exists and is eligible for the Indonesian market.
2. The **exact** category and app type needed, and whether a custom app suffices for
   internal use.
3. Affiliate API activation approval status and date.
4. Approved scopes list, as shown in Partner Center (not as guessed from docs).
5. Whether `affiliate_seller/202405/open_collaborations/products/search` and the
   promotion-link endpoint remain current post-sunset.
6. Indonesian rollout state of the 2026-10 outreach quota change.
7. Sandbox availability for affiliate APIs (sandbox shops exist; affiliate support in
   sandbox is unconfirmed).
8. Whether `SELLER_DEAUTHORIZATION` is enabled for our app and its payload shape.

Until 1–4 are satisfied, Phase 2 delivers: typed client, signing (unit-tested
against the documented worked example), OAuth with encrypted storage, capability
registry, and **mocks**. It will not claim live integration.

---

## 12. Evidence Index (official pages cited)

| Ref | Page |
|---|---|
| E1 | *Affiliate integration* — `/docv2/page/affiliate-integration` |
| E2 | *Affiliate Seller API overview* — `/docv2/page/affiliate-seller-api-overview` |
| E3 | *Affiliate Creator API overview* / *Affiliate Partner API overview* |
| E4 | *TikTok Shop developer guide* — `/docv2/page/tts-developer-guide` |
| E5 | *Authorization overview* — `/docv2/page/authorization-overview-202407` |
| E6 | *Authorization* (domains, `user_type` table) — `/docv2/page/authorization` |
| E7 | *Seller authorization guide*, *Creator authorization guide*, *Partner authorization guide* |
| E8 | *Sign your API request* — `/docv2/page/sign-your-api-request` |
| E9 | *Connecting and managing TikTok shops* (token response fields) |
| E10 | *Generate a test access token* |
| E11 | *Rate limits* — `/docv2/page/64f1991d64ed2e0295f3d2c0` |
| E12 | *Sandbox Shops Rate Limiting & Inactive Seller Access Control* — `/docv2/page/p9x5je85` |
| E13 | *Affiliate API — Legacy Versions and Endpoints Sunset* — `/docv2/page/1wqfoc2s` |
| E14 | *Create Open Collaboration* `202412`, *Create Target Collaboration* `202508`, *Search Target Collaborations* `202508`, *Query Target Collaboration Detail* `202508` |
| E15 | *Seller Search Open Collaboration Products* `202405` |
| E16 | *Seller Search Creator on Marketplace* `202508` |
| E17 | *Search Seller Affiliate Orders* `202410` |
| E18 | *Get Weekly Creator Outreach Quota* `202607` |
| E19 | *Check Creator Outreach Eligibility* `202610` |
| E20 | *Creator Outreach Quota Rule Adjustment* — `/docv2/page/vzfn7sdc` |
| E21 | *Webhooks overview*, *Webhook configuration overview*, *Update Shop Webhook* |
| E22 | *Affiliate (Creator Collaboration) Developer onboarding & termination rules* |
| E23 | *"Tokopedia & Shop" Open API Integration One Pager* (Indonesia market) |

**Not accessed / not obtained:** the Partner Center API reference export, the
"Download Markdown" versions of these pages, sandbox environment, and any page
requiring login. Those remain the gap between `DOCUMENTED` and `VERIFIED`.
