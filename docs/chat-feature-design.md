# Technical Design Document: Real-Time Chat Feature

**Project:** emplee11 – Enterprise Employee Management System  
**Feature:** Real-Time Chat  
**Date:** 2026-03-13  
**Status:** Draft

---

## Table of Contents

1. [Overview](#1-overview)
2. [Requirements](#2-requirements)
3. [System Architecture](#3-system-architecture)
4. [WebSocket-Based Communication](#4-websocket-based-communication)
5. [Message Persistence in PostgreSQL](#5-message-persistence-in-postgresql)
6. [Scalability: 10,000 Concurrent Users](#6-scalability-10000-concurrent-users)
7. [End-to-End Encryption](#7-end-to-end-encryption)
8. [API Reference](#8-api-reference)
9. [Security Considerations](#9-security-considerations)
10. [Open Questions & Future Work](#10-open-questions--future-work)

---

## 1. Overview

This document describes the technical design for adding a real-time chat capability to the emplee11 employee management platform. The chat feature will allow employees to communicate directly and in groups, with all messages persisted for audit and compliance purposes.

---

## 2. Requirements

| # | Requirement | Notes |
|---|-------------|-------|
| R1 | WebSocket-based, bidirectional communication | Low-latency message delivery |
| R2 | Message persistence in PostgreSQL | Full message history, audit trail |
| R3 | Support for 10,000 concurrent users | Horizontal scalability required |
| R4 | End-to-end encryption (E2EE) | Messages unreadable by server or infrastructure |

---

## 3. System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Clients (Browser / Mobile)           │
│   ┌──────────┐   ┌──────────┐        ┌──────────┐           │
│   │ Employee │   │ Employee │  ...   │ Employee │           │
│   │  App A   │   │  App B   │        │ App N    │           │
└───┴────┬─────┴───┴────┬─────┴────────┴────┬─────┘───────────┘
         │ WSS          │ WSS               │ WSS
┌────────▼──────────────▼───────────────────▼────────────────┐
│                   Load Balancer (L7, sticky sessions)       │
│              e.g. NGINX / AWS ALB with IP hash              │
└────────┬──────────────┬───────────────────┬────────────────┘
         │              │                   │
┌────────▼──┐   ┌───────▼──┐        ┌───────▼──┐
│ Chat Svc  │   │ Chat Svc │  ...   │ Chat Svc │   (Node.js, N replicas)
│ Instance 1│   │ Instance2│        │ Instance K│
└────────┬──┘   └───────┬──┘        └───────┬──┘
         │              │                   │
         └──────────────▼───────────────────┘
                        │  Pub/Sub (Redis)
                ┌───────▼───────┐
                │  Redis Cluster│  (message fan-out across instances)
                └───────┬───────┘
                        │
                ┌───────▼───────┐
                │  PostgreSQL   │  (persistent message store)
                │  (primary +   │
                │   read replica│
                └───────────────┘
```

### Component Responsibilities

| Component | Role |
|-----------|------|
| **Client** | Manages WebSocket lifecycle, performs local E2EE key operations, renders chat UI |
| **Load Balancer** | Distributes WebSocket connections; sticky sessions via IP hash to reduce cross-instance lookups |
| **Chat Service** | Handles WebSocket connections, message routing, token validation, and async DB writes |
| **Redis Cluster** | Pub/Sub bus for cross-instance message fan-out; presence tracking via Redis Sets |
| **PostgreSQL** | Durable message storage, conversation metadata, user key registry |

---

## 4. WebSocket-Based Communication

### 4.1 Protocol Choice

The feature uses the **WebSocket** protocol (RFC 6455) over TLS (`wss://`). WebSocket is chosen over SSE or long-polling because it is:

- **Bidirectional** – both server and client can push messages without a new HTTP request.
- **Low-overhead** – after the HTTP upgrade handshake, frames have only a 2–10 byte header.
- **Widely supported** – all modern browsers, React Native, and Electron support WebSocket natively.

### 4.2 Connection Lifecycle

```
Client                              Server
  │                                    │
  │──── HTTP GET /chat/ws ──────────── │  (Upgrade: websocket)
  │     Authorization: Bearer <jwt>    │
  │                                    │
  │◄─── 101 Switching Protocols ───────│
  │                                    │
  │──── {type:"join", roomId:"r1"} ────│  (subscribe to room)
  │◄─── {type:"joined", history:[…]} ──│  (last N messages)
  │                                    │
  │──── {type:"message", …} ───────────│  (send message)
  │◄─── {type:"message", …} ───────────│  (echo + fan-out)
  │                                    │
  │──── {type:"ping"} ─────────────────│  (keep-alive, every 30s)
  │◄─── {type:"pong"} ─────────────────│
  │                                    │
  │──── TCP FIN ───────────────────────│  (disconnect)
```

### 4.3 Message Frame Schema

All frames are UTF-8 JSON objects.

```jsonc
// Client → Server: send a message
{
  "type": "message",
  "roomId": "room_abc123",
  "clientMsgId": "c_uuid_v4",   // idempotency key
  "ciphertext": "<base64>",     // E2EE-encrypted payload
  "senderPublicKey": "<base64>" // ephemeral sender key for ECDH
}

// Server → Client: deliver a message
{
  "type": "message",
  "msgId": "m_uuid_v4",
  "roomId": "room_abc123",
  "senderId": "user_42",
  "ciphertext": "<base64>",
  "senderPublicKey": "<base64>",
  "timestamp": "2026-03-13T09:31:55Z"
}

// Server → Client: acknowledgment
{
  "type": "ack",
  "clientMsgId": "c_uuid_v4",
  "msgId": "m_uuid_v4",
  "timestamp": "2026-03-13T09:31:55Z"
}

// Bidirectional: keep-alive
{ "type": "ping" }
{ "type": "pong" }
```

### 4.4 Authentication

- The HTTP upgrade request carries a **JWT** in the `Authorization: Bearer` header (or as a query param `?token=` for environments that cannot set headers).
- The Chat Service validates the JWT on upgrade. Invalid tokens receive an HTTP `401` before the WebSocket handshake completes.
- Tokens are short-lived (15 min). Clients must reconnect with a refreshed token; the server sends `{type:"token_expiry"}` 60 s before expiry.

### 4.5 Rooms and Presence

- **Direct messages** use a deterministic room ID: `dm_<min(userId, userId2)>_<max(userId, userId2)>`.
- **Group rooms** use a UUID generated at room creation time.
- Presence (online/offline/away) is stored in a Redis Set per room and broadcast as `{type:"presence"}` frames.

---

## 5. Message Persistence in PostgreSQL

### 5.1 Schema

```sql
-- Users public key registry (for E2EE key distribution)
CREATE TABLE user_keys (
    user_id     BIGINT      PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
    public_key  TEXT        NOT NULL,           -- Base64-encoded X25519 public key
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    rotated_at  TIMESTAMPTZ
);

-- Chat rooms (direct or group)
CREATE TABLE chat_rooms (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    type        TEXT        NOT NULL CHECK (type IN ('direct', 'group')),
    name        TEXT,                           -- NULL for direct rooms
    created_by  BIGINT      REFERENCES employees(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Room membership
CREATE TABLE room_members (
    room_id     UUID        NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
    user_id     BIGINT      NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (room_id, user_id)
);

-- Messages
CREATE TABLE messages (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id         UUID        NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
    sender_id       BIGINT      NOT NULL REFERENCES employees(id),
    ciphertext      TEXT        NOT NULL,       -- Base64-encoded E2EE ciphertext
    sender_pub_key  TEXT        NOT NULL,       -- ephemeral sender public key
    client_msg_id   TEXT        UNIQUE,         -- idempotency key from client
    status          TEXT        NOT NULL DEFAULT 'delivered'
                                CHECK (status IN ('delivered', 'read', 'deleted')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-user read receipts
CREATE TABLE read_receipts (
    room_id     UUID        NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
    user_id     BIGINT      NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    last_read   TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (room_id, user_id)
);
```

### 5.2 Indexes

```sql
-- Fast message history pagination (most common query)
CREATE INDEX idx_messages_room_created
    ON messages (room_id, created_at DESC);

-- Idempotency lookup
CREATE UNIQUE INDEX idx_messages_client_msg_id
    ON messages (client_msg_id)
    WHERE client_msg_id IS NOT NULL;

-- Room membership lookup
CREATE INDEX idx_room_members_user
    ON room_members (user_id);
```

### 5.3 Write Path

To avoid blocking WebSocket handlers, message persistence uses an **async write pattern**:

1. Chat Service receives a message frame.
2. Message is immediately published to Redis Pub/Sub (fan-out to all subscribers).
3. Message is pushed to a **write queue** (in-process or a Redis list).
4. A pool of **writer workers** drains the queue and batch-inserts into PostgreSQL using `INSERT … ON CONFLICT (client_msg_id) DO NOTHING` for idempotency.
5. Acknowledgment (`type:"ack"`) is sent to the sender after the Redis publish succeeds (not after DB write) to keep latency low.

```
Client ──► Chat Svc ──► Redis Pub/Sub ──► Subscribers (instant)
                  └────► Write Queue ──► DB Writers ──► PostgreSQL (async)
```

### 5.4 Message History (REST fallback)

`GET /api/chat/rooms/:roomId/messages?before=<timestamp>&limit=50`

Used on initial room join and when scrolling back through history. Returns paginated results ordered by `created_at DESC`.

---

## 6. Scalability: 10,000 Concurrent Users

### 6.1 Resource Estimates

| Resource | Estimate |
|----------|----------|
| WebSocket connections | 10,000 |
| Memory per connection | ~50 KB |
| Total connection memory | ~500 MB |
| Messages/second (peak, 1% active) | ~100 msg/s |
| DB writes/second | ~100/s (burst ~500/s) |

### 6.2 Horizontal Scaling Strategy

**Multiple Chat Service instances** handle distinct subsets of WebSocket connections. Each instance:

- Maintains an in-process map of `connectionId → WebSocket`.
- Subscribes to Redis channels for every room whose members are connected to it.

**Redis Pub/Sub** enables cross-instance message delivery:

```
User A (on Instance 1) sends message to Room X
  → Instance 1 publishes to Redis channel "room:X"
  → Instance 2 & 3 (also subscribed to "room:X") receive the message
  → Each instance pushes the frame to its locally connected users in Room X
```

### 6.3 Connection Management

- **Heartbeat / keep-alive:** 30 s ping/pong. Connections silent for 90 s are terminated.
- **Reconnection:** Clients use exponential backoff (1 s → 2 s → 4 s … max 60 s) with jitter.
- **Graceful shutdown:** On SIGTERM, the Chat Service stops accepting new connections, waits up to 30 s for in-flight messages to flush, then closes.

### 6.4 Database Scaling

- **Connection pooling:** [PgBouncer](https://www.pgbouncer.org/) in transaction-pooling mode, limiting DB connections to ~100 regardless of Chat Service replica count.
- **Read replicas:** Message history queries are routed to read replicas via the pool configuration.
- **Partitioning:** The `messages` table can be range-partitioned by `created_at` (monthly partitions) once volume warrants it.

### 6.5 Load Balancer Configuration

```nginx
upstream chat_services {
    ip_hash;                     # sticky sessions for WebSocket
    server chat1:5001;
    server chat2:5001;
    server chat3:5001;
}

server {
    listen 443 ssl;
    location /chat/ws {
        proxy_pass          http://chat_services;
        proxy_http_version  1.1;
        proxy_set_header    Upgrade    $http_upgrade;
        proxy_set_header    Connection "Upgrade";
        proxy_read_timeout  3600s;
    }
}
```

### 6.6 Capacity Planning

| Scale | Instances | Redis nodes | PgBouncer | PostgreSQL |
|-------|-----------|-------------|-----------|------------|
| 10 K users | 3 × 2 vCPU / 4 GB | 1 primary + 1 replica | 1 | 1 primary + 1 read replica |
| 50 K users | 8 × 4 vCPU / 8 GB | 3-node cluster | 2 | 1 primary + 2 read replicas |
| 200 K users | 20 × 4 vCPU / 16 GB | 6-node cluster | 4 (HA pair) | 1 primary + 3 read replicas + Citus sharding |

---

## 7. End-to-End Encryption

### 7.1 Goals

- The server and any intermediary (load balancer, Redis, DB) must be **unable to decrypt message content**.
- The server only stores the encrypted ciphertext.
- Key management must support multiple recipients per group room.

### 7.2 Cryptographic Primitives

| Primitive | Algorithm | Purpose |
|-----------|-----------|---------|
| Asymmetric key pair | X25519 (ECDH) | Per-user identity key pair |
| Symmetric cipher | AES-256-GCM | Message encryption |
| Key derivation | HKDF-SHA-256 | Derive AES key from ECDH shared secret |
| Key agreement | Signal Double Ratchet (simplified) | Forward secrecy + break-in recovery |
| Signatures | Ed25519 | Message authenticity |

For the initial implementation, a simplified **ECIES** (Elliptic Curve Integrated Encryption Scheme) is used. The full Signal Double Ratchet can be added in a follow-up.

### 7.3 Key Registration

On first login, the client:

1. Generates an **X25519 identity key pair** (stored in the browser's `IndexedDB` / secure enclave on mobile).
2. Uploads the **public key** to `PUT /api/chat/keys` (authenticated endpoint).
3. The server stores the public key in the `user_keys` table.

```
Client                         Server
  │                               │
  │─── PUT /api/chat/keys ─────── │  { publicKey: "<base64>" }
  │◄── 200 OK ─────────────────── │
```

### 7.4 Sending a Message (Direct Room)

```
Sender                                   Recipient
  │                                           │
  │  1. Fetch recipient's public key          │
  │     GET /api/chat/keys/:userId            │
  │                                           │
  │  2. Generate ephemeral X25519 key pair    │
  │     (ephemeralPriv, ephemeralPub)         │
  │                                           │
  │  3. ECDH(ephemeralPriv, recipientPub)     │
  │     → sharedSecret                        │
  │                                           │
  │  4. HKDF(sharedSecret, salt, "chat-v1")  │
  │     → aesKey (32 bytes)                   │
  │                                           │
  │  5. AES-256-GCM encrypt(plaintext, aesKey)│
  │     → { ciphertext, iv, authTag }         │
  │                                           │
  │  6. Send via WebSocket:                   │
  │     { ciphertext, ephemeralPub }          │
  │                                           │
  │                          ┌────────────────▼
  │                          │  7. ECDH(recipientPriv, ephemeralPub)
  │                          │     → sharedSecret
  │                          │
  │                          │  8. HKDF → aesKey
  │                          │
  │                          │  9. AES-256-GCM decrypt
  │                          │     → plaintext
  │                          └────────────────
```

### 7.5 Group Room Encryption

Group rooms use a **symmetric group key** distributed to each member via individual ECIES encryption:

1. Room creator generates a random **group key** (AES-256-GCM, 32 bytes).
2. The group key is encrypted separately for each member using that member's public key (same ECIES flow as §7.4).
3. Each encrypted copy is stored in a `room_keys` table:

```sql
CREATE TABLE room_keys (
    room_id         UUID    NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
    user_id         BIGINT  NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    encrypted_key   TEXT    NOT NULL,   -- ECIES-encrypted AES group key (Base64)
    key_version     INT     NOT NULL DEFAULT 1,
    PRIMARY KEY (room_id, user_id, key_version)
);
```

4. When a new member joins, the admin re-encrypts and distributes the current group key to them.
5. When a member leaves, a **new group key is generated** and distributed to remaining members (key rotation).

### 7.6 Key Rotation Policy

| Event | Action |
|-------|--------|
| User logs out | Optionally generate new key pair for next session |
| Member leaves group room | Generate new group key, re-distribute |
| Suspected key compromise | User regenerates key pair; re-encrypts all group keys they own |
| Key pair age > 90 days | Prompt user to rotate; old key pair archived for decryption of historical messages |

### 7.7 Client-Side Key Storage

| Platform | Storage |
|----------|---------|
| Browser | `window.crypto.subtle` (non-exportable) + IndexedDB for public keys |
| React Native | SecureStore (Expo) / Android Keystore / iOS Secure Enclave |
| Electron | Node.js `crypto` module + OS keychain via `keytar` |

---

## 8. API Reference

### WebSocket Endpoint

| Endpoint | Description |
|----------|-------------|
| `WSS /chat/ws?token=<jwt>` | Establish WebSocket connection |

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/chat/rooms` | List rooms for authenticated user |
| `POST` | `/api/chat/rooms` | Create a new group room |
| `GET` | `/api/chat/rooms/:id/messages` | Paginated message history |
| `PUT` | `/api/chat/keys` | Register / rotate user public key |
| `GET` | `/api/chat/keys/:userId` | Fetch a user's public key |
| `GET` | `/api/chat/rooms/:id/keys` | Fetch encrypted group key for caller |

---

## 9. Security Considerations

| Concern | Mitigation |
|---------|-----------|
| **Transport security** | All connections use TLS 1.3 (`wss://`). HTTP Strict Transport Security (HSTS) enabled. |
| **Authentication** | JWT validated on every WebSocket upgrade. Short TTL (15 min) with refresh tokens. |
| **Authorization** | Room membership checked on every message send and history fetch. Non-members receive `{type:"error", code:403}`. |
| **Rate limiting** | Per-user message rate limit (e.g., 60 messages/min) enforced in the Chat Service before Redis publish. |
| **Input validation** | `ciphertext` and `senderPublicKey` validated as Base64 strings with max-length checks before storage. |
| **Idempotency** | `client_msg_id` unique constraint prevents duplicate messages on client retry. |
| **DoS / Large messages** | Maximum frame size: 64 KB. Larger frames are rejected with `{type:"error", code:413}`. |
| **Key authenticity** | Public keys are signed by the server-issued identity certificate on registration (TOFU model). |
| **Server-side plaintext** | Server never receives plaintext. Ciphertext is opaque bytes to all infrastructure. |
| **Audit logging** | Metadata (sender, room, timestamp, message ID) is logged. Ciphertext is not logged. |

---

## 10. Open Questions & Future Work

| Item | Priority | Notes |
|------|----------|-------|
| Signal Double Ratchet for forward secrecy | High | Replace simplified ECIES with full ratchet protocol |
| Push notifications (offline delivery) | High | Integrate APNs / FCM with encrypted payloads |
| File / media attachments | Medium | Store encrypted blobs in object storage (S3-compatible) |
| Message search | Medium | Searchable encryption or client-side index |
| Message threading | Medium | Add `parent_msg_id` foreign key to `messages` table |
| Cross-device key sync | High | Sealed sender + device-linked sub-keys |
| GDPR / Right to erasure | High | Soft-delete messages; cascade on user deletion |
| Monitoring & observability | High | Prometheus metrics: connected clients, msg/s, queue depth, DB write latency |
| Multi-region deployment | Low | CRDTs or Operational Transforms for conflict resolution |
