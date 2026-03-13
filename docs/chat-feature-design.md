# Technical Design Document: Real-Time Chat Feature

**Version:** 1.0  
**Status:** Draft  
**Date:** 2026-03-13

---

## Table of Contents

1. [Overview](#overview)
2. [Goals and Non-Goals](#goals-and-non-goals)
3. [Architecture Overview](#architecture-overview)
4. [WebSocket Communication](#websocket-communication)
5. [Message Persistence (PostgreSQL)](#message-persistence-postgresql)
6. [Scaling to 10,000 Concurrent Users](#scaling-to-10000-concurrent-users)
7. [End-to-End Encryption (E2EE)](#end-to-end-encryption-e2ee)
8. [API and Event Contracts](#api-and-event-contracts)
9. [Security Considerations](#security-considerations)
10. [Performance Considerations](#performance-considerations)
11. [Open Questions](#open-questions)

---

## Overview

This document describes the technical design for adding a real-time chat feature to the employee management system. The chat feature will allow employees to communicate in real time within the application, with messages stored durably in PostgreSQL and protected by end-to-end encryption. The system must support up to **10,000 concurrent users**.

---

## Goals and Non-Goals

### Goals
- Real-time, bidirectional messaging using WebSockets.
- Durable message storage and history retrieval via PostgreSQL.
- Support for at least 10,000 simultaneous connections without degradation.
- End-to-end encryption so that only the intended recipients can read message content.
- Integration with the existing employee authentication model.

### Non-Goals
- Voice or video calling.
- File/image transfer (future iteration).
- Federation with external chat systems.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                     Client (Browser)                     │
│   React UI  ◄──── WebSocket ────►  WS Connection Pool   │
└──────────────────────────────────────────────────────────┘
                            │
              Load Balancer (sticky sessions / IP hash)
                            │
          ┌─────────────────┴──────────────────┐
          │                                    │
   ┌──────▼──────┐                    ┌────────▼──────┐
   │  Chat Node 1 │                    │  Chat Node N  │
   │  (ws + HTTP) │                    │  (ws + HTTP)  │
   └──────┬───────┘                    └───────┬───────┘
          │                                    │
          └──────────────┬─────────────────────┘
                         │
              ┌──────────▼──────────┐
              │   Redis Pub/Sub     │  ← cross-node message fan-out
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │    PostgreSQL        │  ← durable message storage
              └─────────────────────┘
```

### Component Roles

| Component | Responsibility |
|-----------|---------------|
| React Client | Renders chat UI, manages WebSocket lifecycle, handles E2EE key material |
| Load Balancer | Distributes connections; sticky-session affinity keeps a connection on one node |
| Chat Server Node | Manages WebSocket upgrades, event routing, message validation, DB writes |
| Redis Pub/Sub | Fan-out channel so any node can deliver a message to a recipient on any other node |
| PostgreSQL | Authoritative store for rooms, memberships, and encrypted message history |

---

## WebSocket Communication

### Technology Choice

The server uses the **`ws`** library (Node.js) for lightweight, standards-compliant WebSocket support. Each Chat Server Node maintains an in-process map of open connections keyed by `userId`.

### Connection Lifecycle

```
Client                              Server
  │                                    │
  │── HTTP Upgrade (ws://) ──────────► │  Authentication middleware
  │                                    │  verifies JWT in query param / cookie
  │◄──── 101 Switching Protocols ──────│
  │                                    │
  │── { type: "join_room", roomId } ──►│  Validate membership
  │                                    │
  │◄── { type: "history", messages }───│  Last N messages
  │                                    │
  │── { type: "message", ... } ───────►│  Persist + fan-out
  │                                    │
  │◄── { type: "message", ... } ───────│  Delivered to all room members
  │                                    │
  │── { type: "leave_room", roomId } ─►│
  │                                    │
  │── TCP Close ───────────────────────│  Heartbeat miss or explicit disconnect
```

### Heartbeat / Keep-Alive

- Server sends a `ping` frame every **30 seconds**.
- If no `pong` is received within **10 seconds**, the connection is closed and the user is marked offline.
- Client reconnects automatically with exponential back-off (1 s, 2 s, 4 s … cap 60 s).

### Message Frame Schema

```json
{
  "type": "message",
  "roomId": "uuid",
  "clientMsgId": "uuid",
  "ciphertext": "<base64-encoded encrypted payload>",
  "senderPublicKey": "<base64 X25519 ephemeral public key>",
  "timestamp": "2026-03-13T09:00:00.000Z"
}
```

All payload content is encrypted client-side before being sent; the server stores and forwards `ciphertext` without decrypting it.

---

## Message Persistence (PostgreSQL)

### Rationale for PostgreSQL

PostgreSQL is chosen over the existing SQLite database because it offers:
- True concurrent write throughput.
- Row-level locking for fan-out safety.
- `LISTEN/NOTIFY` for potential future eventing.
- Mature replication and high-availability (HA) support.

### Schema

```sql
-- Rooms (direct messages or group chats)
CREATE TABLE chat_rooms (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT,                         -- NULL for DM rooms
    is_dm       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Room membership
CREATE TABLE chat_room_members (
    room_id     UUID NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL,             -- FK to employees.id
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    public_key  TEXT NOT NULL,               -- user's current X25519 public key
    PRIMARY KEY (room_id, user_id)
);

-- Messages (server stores only the encrypted blob)
CREATE TABLE chat_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id         UUID NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
    sender_id       INTEGER NOT NULL,         -- FK to employees.id
    ciphertext      TEXT NOT NULL,            -- base64-encoded encrypted payload
    sender_pub_key  TEXT NOT NULL,            -- ephemeral X25519 public key used for encryption
    client_msg_id   UUID NOT NULL,            -- idempotency key supplied by client
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (room_id, client_msg_id)           -- prevent duplicate delivery
);

-- Indexes for efficient pagination
CREATE INDEX idx_chat_messages_room_created
    ON chat_messages (room_id, created_at DESC);

CREATE INDEX idx_chat_room_members_user
    ON chat_room_members (user_id);
```

### Message Retrieval (Pagination)

```sql
-- Cursor-based pagination: fetch messages before a given timestamp
SELECT id, sender_id, ciphertext, sender_pub_key, created_at
  FROM chat_messages
 WHERE room_id = $1
   AND created_at < $2          -- cursor
 ORDER BY created_at DESC
 LIMIT 50;
```

### Retention Policy

- Messages older than **365 days** are archived to cold storage (e.g., S3) and deleted from the hot table via a nightly `pg_cron` job.

---

## Scaling to 10,000 Concurrent Users

### Capacity Model

| Resource | Assumption | Derivation |
|----------|-----------|------------|
| WebSocket connections | 1 per active user | 10,000 open sockets |
| Memory per connection | ~50 KB (node buffers + socket) | ~500 MB per node |
| Messages per second (peak) | 5 msg/user/min ≈ 833 msg/s at 10 k users | — |
| PostgreSQL write IOPS | 1 row per message | ~1,000 writes/s |

A single Node.js process can comfortably hold **3,000–5,000** WebSocket connections. Therefore **3–4 Chat Server Nodes** are required for 10,000 users with headroom.

### Load Balancing Strategy

- Use an **L4 load balancer** (e.g., AWS NLB or nginx `stream`) with **IP-hash** or **consistent-hash** sticky sessions so that a user's WebSocket upgrade lands on the same node as any subsequent HTTP requests.
- Alternatively, use **JWT-based connection tokens** and route all WebSocket traffic to any node, relying on Redis for cross-node fan-out.

### Redis Pub/Sub Fan-Out

Each Chat Server Node subscribes to a Redis channel named after each room it has active members in:

```
SUBSCRIBE room:<roomId>
PUBLISH  room:<roomId>  <serialized message JSON>
```

When Node 1 receives a message for `roomId`, it:
1. Persists the message to PostgreSQL.
2. Publishes to `room:<roomId>` on Redis.
3. Every node subscribed to that channel (including Node 1) delivers the message to its local WebSocket clients.

### Connection Limits and Back-Pressure

- **OS tuning:** Increase `ulimit -n` to at least `65535` per node.
- **TCP keep-alive:** Enabled to detect silent disconnects without holding stale entries.
- **Back-pressure:** If the write queue for a socket grows beyond a threshold (e.g., 1 MB), the server pauses accepting new messages from that client.

### Horizontal Scaling Checklist

- [ ] Chat nodes are stateless except for open WebSocket handles.
- [ ] Session/auth state stored in Redis (not in-process memory).
- [ ] Database connection pooling via **PgBouncer** (pool size: 20 per node).
- [ ] Redis cluster mode enabled for Pub/Sub HA.
- [ ] Auto-scaling group triggers at 70% CPU or 4,000 active connections per node.

---

## End-to-End Encryption (E2EE)

### Algorithm Selection

| Layer | Algorithm | Reason |
|-------|-----------|--------|
| Key agreement | X25519 (ECDH) | Fast, small keys, constant-time |
| Message encryption | XChaCha20-Poly1305 | Authenticated encryption, nonce safety |
| Key derivation | HKDF-SHA-256 | Deterministic per-session key derivation |
| Key storage | SubtleCrypto (browser) / OS Keychain | Never leaves device unencrypted |

### Key Management Flow

```
Alice (sender)                          Bob (recipient)
     │                                       │
     │  1. Generate ephemeral X25519 key pair (per-message)
     │                                       │
     │  2. Fetch Bob's identity public key from server
     │◄──────── GET /api/chat/keys/:userId ──│
     │                                       │
     │  3. DH(Alice_ephemeral_priv, Bob_identity_pub) → shared_secret
     │                                       │
     │  4. HKDF(shared_secret, salt=nonce||clientMsgId, info="chat-v1") → encryption_key
     │                                       │
     │  5. XChaCha20-Poly1305 encrypt(plaintext, encryption_key)
     │      → { ciphertext, nonce, Alice_ephemeral_pub }
     │                                       │
     │  6. Send to server (server stores ciphertext only)
     │                                       │
     │                     7. Bob fetches message
     │                     8. DH(Bob_identity_priv, Alice_ephemeral_pub) → shared_secret
     │                     9. HKDF → encryption_key
     │                    10. Decrypt → plaintext
```

### Group Chats (Multi-Recipient)

For group rooms with *N* members, the sender:
1. Generates a random **message key** (32 bytes).
2. Encrypts the plaintext once with XChaCha20-Poly1305 using the message key.
3. For each recipient, wraps (encrypts) the message key using that recipient's identity public key (X25519 + HKDF + XChaCha20-Poly1305).
4. Sends one ciphertext blob + N key-wrap envelopes to the server.

This is the **Sender Keys** / **Message Layer Security (MLS)** pattern and keeps server-side storage proportional to O(N) key wraps rather than O(N) full copies.

### Key Storage and Rotation

- Identity key pairs are generated once per device and stored in the browser's **IndexedDB** (non-extractable `CryptoKey` via SubtleCrypto).
- Users may register multiple devices; each device has its own identity key.
- Identity public keys are published to the server and signed with the employee's account credential.
- **Prekey bundles** (one-time prekeys) allow asynchronous session establishment without requiring the recipient to be online.
- Identity keys are rotated annually or on device loss; old sessions are re-keyed transparently.

---

## API and Event Contracts

### HTTP REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/chat/rooms` | List rooms the authenticated user belongs to |
| `POST` | `/api/chat/rooms` | Create a room (DM or group) |
| `GET` | `/api/chat/rooms/:roomId/messages` | Fetch paginated message history |
| `GET` | `/api/chat/keys/:userId` | Retrieve a user's current identity public key |
| `PUT` | `/api/chat/keys` | Upload / rotate this device's identity public key |

### WebSocket Event Types (Client → Server)

| `type` | Payload | Description |
|--------|---------|-------------|
| `join_room` | `{ roomId }` | Subscribe to room events |
| `leave_room` | `{ roomId }` | Unsubscribe from room events |
| `message` | `{ roomId, ciphertext, senderPublicKey, clientMsgId }` | Send an encrypted message |
| `typing` | `{ roomId, isTyping }` | Broadcast typing indicator |
| `read_receipt` | `{ roomId, messageId }` | Acknowledge message delivery |

### WebSocket Event Types (Server → Client)

| `type` | Payload | Description |
|--------|---------|-------------|
| `history` | `{ messages: [...] }` | Initial message batch on room join |
| `message` | `{ id, roomId, senderId, ciphertext, senderPublicKey, createdAt }` | Incoming message |
| `typing` | `{ roomId, userId, isTyping }` | Typing indicator from another user |
| `read_receipt` | `{ roomId, userId, messageId }` | Read receipt from another user |
| `error` | `{ code, message }` | Protocol or application error |

---

## Security Considerations

| Concern | Mitigation |
|---------|-----------|
| Authentication | WebSocket upgrade must include a valid JWT; rejected otherwise (HTTP 401) |
| Authorization | Room membership checked before any join/message operation |
| Replay attacks | `clientMsgId` (UUID v4) is unique per message; duplicates rejected at DB level |
| DoS / flooding | Per-connection rate limiting (max 10 messages/second); excess triggers disconnect |
| Man-in-the-middle | TLS required (WSS only) for all production connections; E2EE is an additional layer |
| Key impersonation | Identity public keys are signed at upload time with the user's session credential |
| Server-side data exposure | Server stores only ciphertext; plaintext is never transmitted to or stored on the server |
| Metadata exposure | Room membership and message timestamps are accessible to the server (unavoidable for delivery) |

---

## Performance Considerations

- **Connection pooling:** PgBouncer in transaction-mode pools DB connections; avoids the cost of a new connection per WebSocket message.
- **Write batching:** Messages are inserted individually for low latency; a background worker periodically vacuums delivered message receipts in bulk.
- **Caching:** Room membership lists are cached in Redis with a 60-second TTL to avoid per-message DB lookups.
- **Message fanout latency:** Target P99 end-to-end delivery latency ≤ 150 ms under steady-state 10,000-user load.
- **Index maintenance:** The `idx_chat_messages_room_created` index keeps pagination queries under 5 ms at 100 M rows.
- **Read replicas:** PostgreSQL read replica(s) serve history fetch queries, isolating write traffic.

---

## Open Questions

1. **Moderation / content scanning:** If E2EE is applied strictly, the server cannot scan messages for policy violations. Options include client-side reporting, abuse-report forwarding, or an opt-in scanning mode.
2. **Message search:** Full-text search is incompatible with E2EE on the server. Options include client-side local search (decrypted cache) or a trusted search enclave.
3. **Compliance / audit logging:** Legal hold requirements may conflict with E2EE. A key escrow or split-key approach may be required for regulated environments.
4. **Push notifications:** When a user is offline, push notifications (FCM / APNs) must carry only metadata (sender name, room) — not ciphertext — to avoid leaking message content via notification services.
5. **Multi-device decryption:** Determine the exact prekey/signed-prekey bundle design for Signal-like multi-device support.
