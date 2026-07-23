# WebRTC Signaling Server

A production-ready, highly reliable WebRTC Signaling Server built with Node.js, Express, and Socket.IO. Specially designed to handle real-time audio and video call signaling for high-quality Android, iOS, and Web clients.

## Features

- **Full WebRTC Call Lifecycle**: Events for `Call`, `Ringing`, `Accept`, `Reject`, `Cancel`, `Busy`, `End Call`.
- **ICE Configuration Sharing**: Secure dynamic delivery of configurable STUN/TURN servers to clients.
- **Socket Authentication**: Hands-on validation of users connecting to signaling channels.
- **State Preservation**: Tracks online/busy states for all participants with auto-reconnect logic.
- **Sudden Disconnect Cleanups**: Instantly clears busy/active states of both participants if a peer goes offline or drops connection mid-call.
- **Production Logs**: Configured with Morgan HTTP logger and Winston for leveled, environment-specific logging.
- **Zero Configuration Deployments**: Ready-to-deploy configs with `render.yaml` for Render and any serverless cloud engines.

---

## Project Structure

```text
signaling-server/
├── config/
│   └── iceServers.js       # STUN/TURN list parsing and defaults
├── middleware/
│   └── auth.js             # Client handshake socket authentication
├── socket/
│   └── index.js            # Main signaling logic and status trackers
├── utils/
│   └── logger.js           # Winston logging system
├── .env.example            # Environment variables blueprint
├── package.json            # Node.js dependencies & scripts
├── render.yaml             # Render deployment configuration
├── server.js               # Application main entry point
└── README.md               # Setup and API documentation
```

---

## Configuration & Environment Variables

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

| Environment Variable | Description | Default |
|---|---|---|
| `PORT` | Port number on which the server will listen | `3000` |
| `NODE_ENV` | Environment mode (`production` or `development`) | `production` |
| `CORS_ORIGIN` | Authorized origins (comma-separated or `*` for all) | `*` |
| `JWT_SECRET` | Secret key used to verify client JWT handshake tokens (optional) | |
| `STUN_SERVERS` | Comma-separated list of STUN servers to serve | Public Google STUNs |
| `TURN_SERVERS` | JSON string array of TURN server configs with auth credentials | `[]` |

### Example TURN_SERVERS Configuration string:
```env
TURN_SERVERS=[{"urls":"turn:your-turn-server.com:3478","username":"caller_user","credential":"securepassword"}]
```

---

## Installation & Running

Ensure you have [Node.js](https://nodejs.org) (v18+) installed.

### 1. Install Dependencies
```bash
npm install
```

### 2. Run in Development Mode (with hot-reloading)
```bash
npm run dev
```

### 3. Run in Production Mode
```bash
npm start
```

---

## WebRTC Signaling Protocol Flow

Connecting clients must authenticate and exchange messages using the following events over Socket.IO:

### 1. Client Handshake Configuration
When connecting, pass `userId` and `fullName` in handshake auth or query:
```javascript
const socket = io("https://your-signaling-url.com", {
  auth: {
    userId: "firebase_uid_abc123",
    fullName: "John Doe",
    token: "optional_jwt_token"
  }
});
```

### 2. Incoming Connections & System States
- **`ice_servers`**: Emitted by server immediately upon valid connection. Contains parsed STUN/TURN server objects.
- **`online_users_list`**: Emitted by server to the connecting client.
- **`user_online`**: Broadcasted to other clients when a user connects.
- **`user_offline`**: Broadcasted when a user disconnects.

---

### 3. Call Lifecycle Event Payloads

#### **Initiating a Call (`call_user`)**
Client emits to start a call:
```json
// Event: "call_user"
{
  "targetUserId": "recipient_user_id",
  "isVideo": true
}
```

#### **Incoming Call Notification (`incoming_call`)**
Server relays call request to target user:
```json
// Event: "incoming_call" (Received by target client)
{
  "callerId": "caller_user_id",
  "callerName": "Caller Full Name",
  "isVideo": true
}
```

#### **Ringing Signal (`ringing`)**
Target client signals back that device is ringing:
```json
// Event: "ringing" (Emitted by target, received by caller)
{
  "receiverId": "recipient_user_id"
}
```

#### **Accepting Call (`accept_call`)**
Target accepts and initiates peer connection:
```json
// Event: "accept_call" (Emitted by target, relays "call_accepted" to caller)
{
  "callerId": "caller_user_id"
}
```

#### **Rejecting Call (`reject_call`)**
Target declines the call (relays `call_rejected` to caller):
```json
// Event: "reject_call"
{
  "callerId": "caller_user_id",
  "reason": "declined" // or "busy"
}
```

#### **Cancelling Call (`cancel_call`)**
Caller ends connection attempt before target answers (relays `call_cancelled` to target):
```json
// Event: "cancel_call"
{
  "targetUserId": "recipient_user_id"
}
```

#### **Ending Call (`end_call`)**
Either user finishes an ongoing connected call session (relays `call_ended` to other party):
```json
// Event: "end_call"
{
  "targetUserId": "peer_user_id"
}
```

---

### 4. WebRTC Connection Peer Negotiation

Once a call is **Accepted**, clients exchange WebRTC credentials directly through these relay channels:

#### **Offer Relay (`offer`)**
```json
// Event: "offer" (Relayed to target user)
{
  "targetUserId": "peer_user_id",
  "sdp": { "type": "offer", "sdp": "v=0\r\no=..." }
}
```

#### **Answer Relay (`answer`)**
```json
// Event: "answer" (Relayed to caller user)
{
  "targetUserId": "peer_user_id",
  "sdp": { "type": "answer", "sdp": "v=0\r\no=..." }
}
```

#### **ICE Candidate Relay (`ice_candidate`)**
```json
// Event: "ice_candidate" (Relayed to peer user)
{
  "targetUserId": "peer_user_id",
  "candidate": { "candidate": "candidate:84216...", "sdpMid": "0", "sdpMLineIndex": 0 }
}
```

---

## Deployment Guide

### Deploying on Render (Recommended)

1. Push this `/signaling-server` project folder into a new repository on **GitHub** or **GitLab**.
2. Log into your **[Render Dashboard](https://dashboard.render.com/)**.
3. Click **New** > **Blueprint**.
4. Connect your GitHub repository. Render will automatically detect the `render.yaml` configuration and provision the service with:
   - Dynamic port binding
   - Auto-configured environment variables
   - Built-in health checks (`/health`)
   - Free plan compatibility
5. Once deployed, change your Android app signaling server address configuration to use your new Render URL: `https://<your-service>.onrender.com`.
