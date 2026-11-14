# Security Specification: M-Channel PMS Sync Service

## 1. Data Invariants
1. **Strict Tenant Ownership**: Every `/properties/{propertyId}` document and all its subcollections (`mappings`, `inventory`, `outbox`, `bookings`, `webhookEvents`, `stopSales`, `syncLogs`) must carry `ownerUid == request.auth.uid`.
2. **Server-Only Credential Isolation**: `/properties/{propertyId}/secrets/{secretId}` stores AES-256-GCM encrypted `api_key` and `webhook_secret` values and is completely inaccessible (`allow read, write: if false;`) to client SDKs. Only the Node.js backend via Firebase Admin SDK may access credentials.
3. **Immutable Ownership & Timestamps**: `ownerUid`, `propertyId`, and `createdAt` cannot be modified after creation. Server time (`request.time`) is enforced on client writes.
4. **Verified Email Requirement**: Unverified accounts (`email_verified != true`) are denied all read/write access.
5. **Bounded Strings & Safe Identifiers**: All document path IDs match `^[a-zA-Z0-9_\-]+$` and length `<= 128`. All strings enforce explicit `.size()` upper bounds.

## 2. The "Dirty Dozen" Payloads (Expected: PERMISSION_DENIED)
1. **Unauthenticated Property Read**: `get /properties/prop-1` with `auth = null` -> DENIED.
2. **Cross-Tenant Property Read**: `get /properties/prop-1` owned by `userA` while signed in as `userB` -> DENIED.
3. **Secret Exfiltration**: `get /properties/prop-1/secrets/credentials` by authenticated owner `userA` -> DENIED (`secrets` is server-only).
4. **Secret Write Injection**: `create /properties/prop-1/secrets/credentials` by authenticated owner `userA` -> DENIED.
5. **Unverified Email Write**: `create /users/userA` with `token.email_verified = false` -> DENIED.
6. **Identity Spoofing on Property Create**: `create /properties/prop-2` as `userB` with `ownerUid = "userA"` -> DENIED.
7. **Shadow Field Injection**: `create /properties/prop-2` with extra field `isAdmin: true` -> DENIED (`hasOnly` check).
8. **ID Poisoning**: `get /properties/` + 300-char ID -> DENIED (`isValidId`).
9. **Blanket List Query**: `list /properties` without matching `resource.data.ownerUid == request.auth.uid` -> DENIED.
10. **Owner Reassignment on Update**: `update /properties/prop-1` changing `ownerUid` from `userA` to `userB` -> DENIED.
11. **Value Poisoning on Status**: `update /properties/prop-1` setting `status: "hacked_status"` -> DENIED (enum check).
12. **Client Subcollection Spoofing**: `create /properties/prop-1/outbox/batch-1` by `userB` on `userA`'s property -> DENIED (Master Gate `get()` check on parent property).
