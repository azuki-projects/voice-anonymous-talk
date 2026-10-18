import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Parse port from CLI argument or environment variable
const args = process.argv.slice(2);
let port = 3000;
const portIdx = args.indexOf('--port');
if (portIdx !== -1 && args[portIdx + 1]) {
  port = parseInt(args[portIdx + 1], 10);
} else if (process.env.PORT) {
  port = parseInt(process.env.PORT, 10);
}

// -------------------------------------------------------------
// STATE MANAGEMENT & MATCHMAKING
// -------------------------------------------------------------
// 100% REAL LIVE ONLINE USERS ONLY - NO BOTS, NO FAKE USERS EVER
const connectedSockets = new Map(); // socket.id -> { socketId, userId, username, avatar, inCall, roomId, searching }
const matchmakingQueue = []; // array of socketIds in order
const activeRooms = new Map(); // roomId -> { id, userA: socketId, userB: socketId, startedAt }
// 4-Code Group Voice Rooms (Max 10 users per group)
const groupRooms = new Map(); // 4-code -> { code, hostSocketId, hostPermanentId, started, startedAt, members: Map<socketId, memberData> }
const MAX_GROUP_USERS = 10;

function generateGroupCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  let attempts = 0;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    attempts++;
  } while (groupRooms.has(code) && attempts < 100);
  return code;
}

function broadcastStats() {
  const onlineCount = connectedSockets.size;
  let inCallCount = 0;
  for (const user of connectedSockets.values()) {
    if (user.inCall) inCallCount++;
  }
  const queueCount = matchmakingQueue.length;
  io.emit('stats:update', {
    onlineCount,
    inCallCount,
    queueCount,
    activeRoomsCount: activeRooms.size
  });
}

function attemptMatchmaking() {
  if (matchmakingQueue.length < 2) return;

  for (let i = 0; i < matchmakingQueue.length; i++) {
    const socketIdA = matchmakingQueue[i];
    const userA = connectedSockets.get(socketIdA);
    if (!userA || userA.inCall || !userA.searching) continue;

    for (let j = i + 1; j < matchmakingQueue.length; j++) {
      const socketIdB = matchmakingQueue[j];
      const userB = connectedSockets.get(socketIdB);
      if (!userB || userB.inCall || !userB.searching) continue;

      // Must be different users
      if (userA.userId === userB.userId) continue;

      // Match found!
      matchmakingQueue.splice(j, 1);
      matchmakingQueue.splice(i, 1);

      userA.searching = false;
      userA.inCall = true;
      userB.searching = false;
      userB.inCall = true;

      const roomId = 'zuki_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now();
      userA.roomId = roomId;
      userB.roomId = roomId;

      activeRooms.set(roomId, {
        id: roomId,
        userA: { socketId: socketIdA, userId: userA.userId, username: userA.username, avatar: userA.avatar },
        userB: { socketId: socketIdB, userId: userB.userId, username: userB.username, avatar: userB.avatar },
        startedAt: Date.now()
      });

      const socketA = io.sockets.sockets.get(socketIdA);
      const socketB = io.sockets.sockets.get(socketIdB);

      if (socketA) socketA.join(roomId);
      if (socketB) socketB.join(roomId);

      // userA is designated initiator
      if (socketA) {
        socketA.emit('match:found', {
          roomId,
          isInitiator: true,
          partner: {
            username: userB.username,
            avatar: userB.avatar,
            userId: userB.userId
          }
        });
      }

      if (socketB) {
        socketB.emit('match:found', {
          roomId,
          isInitiator: false,
          partner: {
            username: userA.username,
            avatar: userA.avatar,
            userId: userA.userId
          }
        });
      }

      broadcastStats();
      // Try finding more matches
      attemptMatchmaking();
      return;
    }
  }
}

// -------------------------------------------------------------
// SOCKET.IO SIGNALING & EVENTS
// -------------------------------------------------------------
io.on('connection', (socket) => {
  // Client registers with username, avatar, and persistent client-generated userId, permanentId & groupPermanentId
  socket.on('user:register', ({ userId, permanentId, groupPermanentId, username, avatar }) => {
    const cleanPermId = (permanentId || userId || ('ZK-' + socket.id.slice(0, 6).toUpperCase())).trim().toUpperCase();
    const cleanGroupPermId = (groupPermanentId || cleanPermId.replace('ZK-', '').slice(0, 4) || '8A4F').trim().toUpperCase();
    connectedSockets.set(socket.id, {
      socketId: socket.id,
      userId: userId || ('user_' + socket.id),
      permanentId: cleanPermId,
      groupPermanentId: cleanGroupPermId,
      username: (username || 'Anonymous').trim().slice(0, 24),
      avatar: avatar || '🦊',
      inCall: false,
      roomId: null,
      searching: false
    });
    socket.emit('user:registered', { permanentId: cleanPermId, groupPermanentId: cleanGroupPermId });
    broadcastStats();
  });

  // Check online status of target Permanent ID
  socket.on('direct:check', ({ targetId }) => {
    if (!targetId) {
      return socket.emit('direct:status', { targetId, status: 'invalid', message: 'Please enter a Permanent ID' });
    }
    const cleanTargetId = targetId.trim().toUpperCase();
    const caller = connectedSockets.get(socket.id);
    if (caller && (caller.permanentId === cleanTargetId || caller.userId === cleanTargetId)) {
      return socket.emit('direct:status', { targetId: cleanTargetId, status: 'self', message: 'You cannot call your own Permanent ID.' });
    }

    let foundUser = null;
    for (const u of connectedSockets.values()) {
      if (u.permanentId === cleanTargetId || u.userId === cleanTargetId) {
        foundUser = u;
        break;
      }
    }

    if (!foundUser) {
      return socket.emit('direct:status', {
        targetId: cleanTargetId,
        status: 'offline',
        message: `🔴 User ${cleanTargetId} is currently OFFLINE.`
      });
    }

    if (foundUser.inCall) {
      return socket.emit('direct:status', {
        targetId: cleanTargetId,
        status: 'busy',
        username: foundUser.username,
        avatar: foundUser.avatar,
        message: `🟡 ${foundUser.username} (${cleanTargetId}) is currently in another voice call.`
      });
    }

    return socket.emit('direct:status', {
      targetId: cleanTargetId,
      status: 'online',
      username: foundUser.username,
      avatar: foundUser.avatar,
      message: `🟢 ${foundUser.username} (${cleanTargetId}) is ONLINE & READY!`
    });
  });

  // Request direct call to target Permanent ID
  socket.on('direct:call_request', ({ targetId }) => {
    const caller = connectedSockets.get(socket.id);
    if (!caller || caller.inCall) return;

    const cleanTargetId = (targetId || '').trim().toUpperCase();
    if (caller.permanentId === cleanTargetId || caller.userId === cleanTargetId) {
      return socket.emit('direct:call_failed', { reason: 'self', message: 'You cannot call yourself.' });
    }

    let targetUser = null;
    for (const u of connectedSockets.values()) {
      if (u.permanentId === cleanTargetId || u.userId === cleanTargetId) {
        targetUser = u;
        break;
      }
    }

    if (!targetUser) {
      return socket.emit('direct:call_failed', { reason: 'offline', message: `User ${cleanTargetId} is currently offline.` });
    }

    if (targetUser.inCall) {
      return socket.emit('direct:call_failed', { reason: 'busy', message: `${targetUser.username} is currently in another call.` });
    }

    const callSessionId = 'direct_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now();

    // Notify caller that call is ringing
    socket.emit('direct:calling', {
      targetId: cleanTargetId,
      targetUsername: targetUser.username,
      targetAvatar: targetUser.avatar,
      callSessionId
    });

    // Notify target about incoming call
    io.to(targetUser.socketId).emit('direct:incoming_call', {
      callerSocketId: socket.id,
      callerId: caller.permanentId,
      callerUsername: caller.username,
      callerAvatar: caller.avatar,
      callSessionId
    });
  });

  // Accept direct call
  socket.on('direct:call_accept', ({ callerSocketId, callSessionId }) => {
    const targetUser = connectedSockets.get(socket.id);
    const callerUser = connectedSockets.get(callerSocketId);

    if (!targetUser || !callerUser || targetUser.inCall || callerUser.inCall) {
      return socket.emit('direct:call_failed', { reason: 'expired', message: 'Call is no longer available.' });
    }

    targetUser.inCall = true;
    callerUser.inCall = true;
    targetUser.searching = false;
    callerUser.searching = false;

    // Remove from matchmaking queue if present
    const q1 = matchmakingQueue.indexOf(targetUser.socketId);
    if (q1 !== -1) matchmakingQueue.splice(q1, 1);
    const q2 = matchmakingQueue.indexOf(callerUser.socketId);
    if (q2 !== -1) matchmakingQueue.splice(q2, 1);

    const roomId = 'room_' + callSessionId;
    targetUser.roomId = roomId;
    callerUser.roomId = roomId;

    activeRooms.set(roomId, {
      id: roomId,
      userA: { socketId: callerUser.socketId, userId: callerUser.permanentId, username: callerUser.username, avatar: callerUser.avatar },
      userB: { socketId: targetUser.socketId, userId: targetUser.permanentId, username: targetUser.username, avatar: targetUser.avatar },
      startedAt: Date.now()
    });

    const socketA = io.sockets.sockets.get(callerUser.socketId);
    const socketB = io.sockets.sockets.get(targetUser.socketId);

    if (socketA) socketA.join(roomId);
    if (socketB) socketB.join(roomId);

    // Caller is initiator
    if (socketA) {
      socketA.emit('match:found', {
        roomId,
        isInitiator: true,
        partner: {
          username: targetUser.username,
          avatar: targetUser.avatar,
          userId: targetUser.permanentId
        }
      });
    }

    // Target is receiver
    if (socketB) {
      socketB.emit('match:found', {
        roomId,
        isInitiator: false,
        partner: {
          username: callerUser.username,
          avatar: callerUser.avatar,
          userId: callerUser.permanentId
        }
      });
    }

    broadcastStats();
  });

  // Decline direct call
  socket.on('direct:call_decline', ({ callerSocketId }) => {
    const callerUser = connectedSockets.get(callerSocketId);
    if (callerUser) {
      io.to(callerSocketId).emit('direct:call_declined', {
        message: 'The user declined your direct voice call.'
      });
    }
  });

  // Cancel direct call by caller
  socket.on('direct:call_cancel', ({ targetId }) => {
    const cleanTargetId = (targetId || '').trim().toUpperCase();
    for (const u of connectedSockets.values()) {
      if (u.permanentId === cleanTargetId) {
        io.to(u.socketId).emit('direct:call_cancelled');
        break;
      }
    }
  });

  // Start matchmaking search
  socket.on('match:start', () => {
    const user = connectedSockets.get(socket.id);
    if (!user || user.inCall) return;

    user.searching = true;
    if (!matchmakingQueue.includes(socket.id)) {
      matchmakingQueue.push(socket.id);
    }
    broadcastStats();
    attemptMatchmaking();
  });

  // Cancel matchmaking search
  socket.on('match:cancel', () => {
    const user = connectedSockets.get(socket.id);
    if (user) {
      user.searching = false;
    }
    const idx = matchmakingQueue.indexOf(socket.id);
    if (idx !== -1) {
      matchmakingQueue.splice(idx, 1);
    }
    socket.emit('match:cancelled');
    broadcastStats();
  });

  // WebRTC Signaling: Offer
  socket.on('signal:offer', ({ roomId, offer }) => {
    socket.to(roomId).emit('signal:offer', { offer });
  });

  // WebRTC Signaling: Answer
  socket.on('signal:answer', ({ roomId, answer }) => {
    socket.to(roomId).emit('signal:answer', { answer });
  });

  // WebRTC Signaling: ICE Candidate
  socket.on('signal:ice-candidate', ({ roomId, candidate }) => {
    socket.to(roomId).emit('signal:ice-candidate', { candidate });
  });

  // End Call anytime
  socket.on('call:end', () => {
    const user = connectedSockets.get(socket.id);
    if (!user || !user.roomId) return;

    const roomId = user.roomId;
    const room = activeRooms.get(roomId);
    const duration = room ? Math.floor((Date.now() - room.startedAt) / 1000) : 0;

    // Notify other user that partner ended the call
    socket.to(roomId).emit('call:ended_by_partner', {
      reason: 'stranger_ended',
      duration,
      endedAt: new Date().toISOString()
    });

    // Notify the user who clicked End Call
    socket.emit('call:ended_by_you', {
      duration,
      endedAt: new Date().toISOString()
    });

    // Cleanup room state
    if (room) {
      activeRooms.delete(roomId);
      const userA = connectedSockets.get(room.userA.socketId);
      const userB = connectedSockets.get(room.userB.socketId);
      if (userA) { userA.inCall = false; userA.roomId = null; }
      if (userB) { userB.inCall = false; userB.roomId = null; }
    } else {
      user.inCall = false;
      user.roomId = null;
    }

    broadcastStats();
  });

  // -------------------------------------------------------------
  // GROUP VOICE CALL (4-CODE ROOMS, MAX 10 USERS)
  // -------------------------------------------------------------
  function handleUserLeaveGroup(socketId) {
    const user = connectedSockets.get(socketId);
    if (!user || !user.groupCode) return;
    const code = user.groupCode;
    const room = groupRooms.get(code);
    if (room) {
      room.members.delete(socketId);
      const remaining = Array.from(room.members.values());
      if (remaining.length === 0) {
        groupRooms.delete(code);
      } else {
        if (room.hostSocketId === socketId && remaining[0]) {
          room.hostSocketId = remaining[0].socketId;
          room.hostPermanentId = remaining[0].permanentId;
          remaining[0].isHost = true;
        }
        io.to('group_' + code).emit('group:member_left', {
          leftSocketId: socketId,
          totalCount: remaining.length,
          allMembers: remaining
        });
      }
    }
    user.inCall = false;
    user.groupCode = null;
    broadcastStats();
  }

  // Check group status
  socket.on('group:check', ({ code }) => {
    const cleanCode = (code || '').trim().toUpperCase();
    if (!cleanCode || cleanCode.length !== 4) {
      return socket.emit('group:status', { code: cleanCode, status: 'invalid', message: 'Group code must be exactly 4 characters.' });
    }
    const room = groupRooms.get(cleanCode);
    if (!room || !room.started) {
      return socket.emit('group:status', {
        code: cleanCode,
        status: 'not_started',
        message: ': this group hasn\'t started by user'
      });
    }
    if (room.members.size >= MAX_GROUP_USERS) {
      return socket.emit('group:status', {
        code: cleanCode,
        status: 'full',
        message: ': this group is full (10)'
      });
    }
    return socket.emit('group:status', {
      code: cleanCode,
      status: 'available',
      memberCount: room.members.size,
      message: `Group ${cleanCode} is ACTIVE (${room.members.size}/10 members). Ready to join!`
    });
  });

  // Create group room (Starts user's 4-code group room)
  socket.on('group:create', ({ customCode }) => {
    const user = connectedSockets.get(socket.id);
    if (!user) return;

    let code = (customCode || user.groupPermanentId || '').trim().toUpperCase();
    if (code && code.length === 4) {
      if (groupRooms.has(code)) {
        const existing = groupRooms.get(code);
        if (existing && existing.started) {
          // If already inside
          if (existing.members.has(socket.id)) return;
          // If room is full (10)
          if (existing.members.size >= MAX_GROUP_USERS) {
            return socket.emit('group:error', {
              code,
              reason: 'full',
              message: ': this group is full (10)'
            });
          }
          // If this user is returning host or room is active, join existing or take over host
          if (existing.hostPermanentId === user.permanentId) {
            existing.hostSocketId = socket.id;
          }
        }
      }
    } else {
      code = generateGroupCode();
    }

    if (user.roomId) socket.emit('call:end');
    if (user.groupCode) handleUserLeaveGroup(socket.id);

    const newGroup = {
      code,
      hostSocketId: socket.id,
      hostPermanentId: user.permanentId,
      started: true,
      startedAt: Date.now(),
      members: new Map()
    };
    const hostMember = {
      socketId: socket.id,
      userId: user.userId,
      permanentId: user.permanentId,
      username: user.username,
      avatar: user.avatar,
      isHost: true
    };
    newGroup.members.set(socket.id, hostMember);
    groupRooms.set(code, newGroup);
    socket.join('group_' + code);

    user.inCall = true;
    user.groupCode = code;

    socket.emit('group:joined_success', {
      groupCode: code,
      isHost: true,
      myMember: hostMember,
      existingMembers: [],
      allMembers: [hostMember]
    });
    broadcastStats();
  });

  // Join group room
  socket.on('group:join', ({ code }) => {
    const user = connectedSockets.get(socket.id);
    if (!user) return;

    const cleanCode = (code || '').trim().toUpperCase();
    if (!cleanCode || cleanCode.length !== 4) {
      return socket.emit('group:error', { message: 'Group code must be 4 characters.' });
    }

    const room = groupRooms.get(cleanCode);
    if (!room || !room.started) {
      return socket.emit('group:error', {
        code: cleanCode,
        reason: 'not_started',
        message: ': this group hasn\'t started by user'
      });
    }

    if (room.members.size >= MAX_GROUP_USERS) {
      return socket.emit('group:error', {
        code: cleanCode,
        reason: 'full',
        message: ': this group is full (10)'
      });
    }

    if (user.roomId) socket.emit('call:end');
    if (user.groupCode && user.groupCode !== cleanCode) handleUserLeaveGroup(socket.id);

    const memberData = {
      socketId: socket.id,
      userId: user.userId,
      permanentId: user.permanentId,
      username: user.username,
      avatar: user.avatar,
      isHost: false
    };

    const existingMembers = Array.from(room.members.values());
    room.members.set(socket.id, memberData);
    socket.join('group_' + cleanCode);

    user.inCall = true;
    user.groupCode = cleanCode;

    socket.emit('group:joined_success', {
      groupCode: cleanCode,
      isHost: false,
      myMember: memberData,
      existingMembers: existingMembers,
      allMembers: Array.from(room.members.values())
    });

    socket.to('group_' + cleanCode).emit('group:member_joined', {
      newMember: memberData,
      totalCount: room.members.size,
      allMembers: Array.from(room.members.values())
    });
    broadcastStats();
  });

  // Leave group room
  socket.on('group:leave', () => {
    handleUserLeaveGroup(socket.id);
    socket.emit('group:left');
  });

  // Group WebRTC mesh signaling
  socket.on('group:signal:offer', ({ toSocketId, offer }) => {
    io.to(toSocketId).emit('group:signal:offer', { fromSocketId: socket.id, offer });
  });

  socket.on('group:signal:answer', ({ toSocketId, answer }) => {
    io.to(toSocketId).emit('group:signal:answer', { fromSocketId: socket.id, answer });
  });

  socket.on('group:signal:candidate', ({ toSocketId, candidate }) => {
    io.to(toSocketId).emit('group:signal:candidate', { fromSocketId: socket.id, candidate });
  });

  // Disconnect handler
  socket.on('disconnect', () => {
    const user = connectedSockets.get(socket.id);
    // Remove from queue
    const qIdx = matchmakingQueue.indexOf(socket.id);
    if (qIdx !== -1) {
      matchmakingQueue.splice(qIdx, 1);
    }

    // If was in an active call, notify stranger so they stay in room to view session info
    if (user && user.roomId) {
      const room = activeRooms.get(user.roomId);
      const duration = room ? Math.floor((Date.now() - room.startedAt) / 1000) : 0;
      socket.to(user.roomId).emit('call:ended_by_partner', {
        reason: 'stranger_disconnected',
        duration,
        endedAt: new Date().toISOString()
      });
      activeRooms.delete(user.roomId);
    }

    // If was in a group call, leave and notify group members
    handleUserLeaveGroup(socket.id);

    connectedSockets.delete(socket.id);
    broadcastStats();
  });
});

// REST API for stats
app.get('/api/stats', (req, res) => {
  res.json({
    online: connectedSockets.size,
    queue: matchmakingQueue.length,
    activeCalls: activeRooms.size
  });
});

// -------------------------------------------------------------
// SERVE EMBEDDED SINGLE-FILE WEB APP FRONTEND
// -------------------------------------------------------------
app.get('*', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Zuki Voice Talk — Real 1-on-1 Random Voice Chat</title>
  <meta name="description" content="Dynamic 1-on-1 random WebRTC voice talk with real live people. 100% real online humans, zero bots.">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Space+Grotesk:wght@600;700&display=swap" rel="stylesheet">
  <script src="/socket.io/socket.io.js"></script>
  <style>
    :root {
      --bg-main: #0b0c10;
      --bg-card: rgba(18, 20, 29, 0.82);
      --bg-card-border: rgba(255, 42, 95, 0.22);
      --accent: #ff2a5f;
      --accent-glow: rgba(255, 42, 95, 0.45);
      --accent-subtle: rgba(255, 42, 95, 0.12);
      --accent-secondary: #f59e0b;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --surface-hover: rgba(255, 255, 255, 0.06);
      --danger: #ef4444;
      --success: #10b981;
      --radius-sm: 8px;
      --radius-md: 14px;
      --radius-lg: 20px;
    }

    [data-theme="cyberpunk"] {
      --bg-main: #070913;
      --bg-card: rgba(12, 17, 33, 0.85);
      --bg-card-border: rgba(0, 240, 255, 0.28);
      --accent: #00f0ff;
      --accent-glow: rgba(0, 240, 255, 0.45);
      --accent-subtle: rgba(0, 240, 255, 0.12);
      --accent-secondary: #ff007f;
      --text-main: #ffffff;
      --text-muted: #8ba2c4;
    }

    [data-theme="stealth"] {
      --bg-main: #000000;
      --bg-card: rgba(18, 18, 18, 0.9);
      --bg-card-border: rgba(255, 255, 255, 0.15);
      --accent: #f97316;
      --accent-glow: rgba(249, 115, 22, 0.45);
      --accent-subtle: rgba(249, 115, 22, 0.12);
      --accent-secondary: #e2e8f0;
      --text-main: #ffffff;
      --text-muted: #a1a1aa;
    }

    [data-theme="sunset"] {
      --bg-main: #110d1c;
      --bg-card: rgba(26, 19, 41, 0.85);
      --bg-card-border: rgba(244, 63, 94, 0.25);
      --accent: #f43f5e;
      --accent-glow: rgba(244, 63, 94, 0.45);
      --accent-subtle: rgba(244, 63, 94, 0.12);
      --accent-secondary: #fbbf24;
      --text-main: #fdf2f8;
      --text-muted: #a78bfa;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      -webkit-tap-highlight-color: transparent;
    }

    body {
      font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
      background-color: var(--bg-main);
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      overflow-x: hidden;
      position: relative;
    }

    /* Subtle background grid & ambient light */
    body::before {
      content: "";
      position: fixed;
      top: 0; left: 0; width: 100%; height: 100%;
      background-image: 
        radial-gradient(circle at 50% 0%, var(--accent-subtle) 0%, transparent 60%),
        radial-gradient(circle at 100% 100%, rgba(245, 158, 11, 0.05) 0%, transparent 50%),
        linear-gradient(to right, rgba(255, 255, 255, 0.02) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(255, 255, 255, 0.02) 1px, transparent 1px);
      background-size: 100% 100%, 100% 100%, 48px 48px, 48px 48px;
      pointer-events: none;
      z-index: 0;
    }

    /* Kanji Watermark */
    .kanji-bg {
      position: fixed;
      bottom: 2%;
      right: 3%;
      font-family: serif;
      font-size: 14rem;
      font-weight: 900;
      color: var(--accent);
      opacity: 0.035;
      pointer-events: none;
      user-select: none;
      z-index: 0;
      line-height: 1;
    }

    .container {
      width: 100%;
      max-width: 900px;
      margin: 0 auto;
      padding: 1.25rem;
      position: relative;
      z-index: 10;
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }

    /* HEADER */
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 0 1.25rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.07);
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      text-decoration: none;
      color: inherit;
      cursor: pointer;
    }

    .brand-icon {
      width: 38px;
      height: 38px;
      border-radius: 10px;
      background: linear-gradient(135deg, var(--accent) 0%, #a21caf 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 18px var(--accent-glow);
    }

    .brand-text h1 {
      font-family: 'Space Grotesk', sans-serif;
      font-size: 1.2rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .brand-text .azuki-badge {
      font-size: 0.65rem;
      padding: 2px 6px;
      background: var(--accent-subtle);
      border: 1px solid var(--accent);
      color: var(--accent);
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-weight: 800;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 0.6rem;
    }

    .pill-btn {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: var(--text-main);
      padding: 0.45rem 0.85rem;
      border-radius: 30px;
      font-size: 0.85rem;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .pill-btn:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.25);
      transform: translateY(-1px);
    }

    .live-status-pill {
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.3);
      color: #34d399;
      padding: 0.4rem 0.75rem;
      border-radius: 30px;
      font-size: 0.8rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }

    .live-dot {
      width: 7px;
      height: 7px;
      background-color: #10b981;
      border-radius: 50%;
      box-shadow: 0 0 10px #10b981;
      animation: pulse 1.8s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.85); }
    }

    /* SCREEN CONTAINERS */
    .screen {
      display: none;
      flex-direction: column;
      flex: 1;
      justify-content: center;
      align-items: center;
      padding: 1.5rem 0;
      animation: fadeIn 0.3s ease-out forwards;
    }

    .screen.active {
      display: flex;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* LOADING SCREEN */
    #loadingScreen {
      position: fixed;
      top: 0; left: 0; width: 100vw; height: 100vh;
      background: var(--bg-main);
      z-index: 9999;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      transition: opacity 0.5s ease, visibility 0.5s ease;
    }

    .mic-loader-wrapper {
      position: relative;
      width: 140px;
      height: 140px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 2rem;
    }

    .sonic-ring {
      position: absolute;
      border-radius: 50%;
      border: 2px solid var(--accent);
      opacity: 0;
      animation: ripple 2.2s cubic-bezier(0.2, 0.8, 0.2, 1) infinite;
    }

    .sonic-ring:nth-child(1) { width: 80px; height: 80px; animation-delay: 0s; }
    .sonic-ring:nth-child(2) { width: 110px; height: 110px; animation-delay: 0.5s; }
    .sonic-ring:nth-child(3) { width: 140px; height: 140px; animation-delay: 1.0s; }

    @keyframes ripple {
      0% { transform: scale(0.6); opacity: 0.8; }
      100% { transform: scale(1.4); opacity: 0; }
    }

    .mic-core {
      width: 72px;
      height: 72px;
      border-radius: 20px;
      background: linear-gradient(135deg, var(--accent) 0%, #9333ea 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 35px var(--accent-glow);
      z-index: 2;
      animation: float 2.5s ease-in-out infinite;
    }

    @keyframes float {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-5px); }
    }

    .loading-title {
      font-family: 'Space Grotesk', sans-serif;
      font-size: 1.75rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: 0.35rem;
    }

    .loading-sub {
      color: var(--text-muted);
      font-size: 0.95rem;
      margin-bottom: 1.5rem;
    }

    .azuki-made-tag {
      font-size: 0.9rem;
      font-weight: 700;
      background: linear-gradient(90deg, #ff2a5f, #fbbf24, #ff2a5f);
      background-size: 200% auto;
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      animation: shine 2.5s linear infinite;
      letter-spacing: 0.04em;
    }

    @keyframes shine {
      to { background-position: 200% center; }
    }

    /* HOME SCREEN */
    .home-hero {
      text-align: center;
      margin: auto 0;
      max-width: 620px;
    }

    .hero-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      background: var(--accent-subtle);
      border: 1px solid var(--bg-card-border);
      color: var(--accent);
      padding: 0.35rem 0.85rem;
      border-radius: 30px;
      font-size: 0.8rem;
      font-weight: 700;
      margin-bottom: 1.25rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .hero-headline {
      font-family: 'Space Grotesk', sans-serif;
      font-size: 3rem;
      font-weight: 800;
      line-height: 1.08;
      letter-spacing: -0.03em;
      margin-bottom: 1rem;
    }

    .hero-headline span {
      color: var(--accent);
      text-shadow: 0 0 24px var(--accent-glow);
    }

    .hero-desc {
      color: var(--text-muted);
      font-size: 1.08rem;
      line-height: 1.55;
      margin-bottom: 2rem;
    }

    .profile-card-preview {
      display: inline-flex;
      align-items: center;
      gap: 0.75rem;
      background: var(--bg-card);
      border: 1px solid rgba(255, 255, 255, 0.1);
      padding: 0.6rem 1.2rem;
      border-radius: 40px;
      margin-bottom: 2rem;
      cursor: pointer;
      transition: all 0.2s;
    }

    .profile-card-preview:hover {
      border-color: var(--accent);
      background: rgba(255, 255, 255, 0.08);
    }

    .avatar-circle {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: var(--accent-subtle);
      border: 1px solid var(--accent);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.1rem;
    }

    .permanent-id-chip {
      display: inline-flex;
      align-items: center;
      gap: 0.75rem;
      background: var(--bg-card);
      border: 1px solid var(--bg-card-border);
      padding: 0.6rem 1.2rem;
      border-radius: 40px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .permanent-id-chip:hover {
      border-color: var(--accent);
      background: rgba(255, 255, 255, 0.08);
      box-shadow: 0 0 15px var(--accent-subtle);
    }

    .copy-badge {
      font-size: 0.75rem;
      font-weight: 700;
      background: var(--accent-subtle);
      border: 1px solid var(--accent);
      color: var(--accent);
      padding: 3px 8px;
      border-radius: 20px;
    }

    .direct-call-box {
      background: var(--bg-card);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: var(--radius-md);
      padding: 1.25rem;
      margin: 1.25rem auto 1.5rem;
      max-width: 520px;
      width: 100%;
      text-align: left;
    }

    .direct-call-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.85rem;
    }

    .direct-input-group {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }

    .direct-id-input {
      flex: 1;
      min-width: 160px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: var(--text-main);
      padding: 0.75rem 1rem;
      border-radius: var(--radius-sm);
      font-family: 'Space Grotesk', monospace;
      font-weight: 700;
      font-size: 0.95rem;
      letter-spacing: 0.04em;
      outline: none;
    }

    .direct-id-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 10px var(--accent-glow);
    }

    .check-online-btn {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.18);
      color: var(--text-main);
      padding: 0.75rem 1rem;
      border-radius: var(--radius-sm);
      font-weight: 700;
      font-size: 0.88rem;
      cursor: pointer;
      transition: all 0.2s;
    }

    .check-online-btn:hover {
      background: rgba(255, 255, 255, 0.15);
    }

    .direct-call-action-btn {
      background: linear-gradient(135deg, var(--accent) 0%, #e11d48 100%);
      border: none;
      color: white;
      padding: 0.75rem 1.2rem;
      border-radius: var(--radius-sm);
      font-weight: 800;
      font-size: 0.88rem;
      cursor: pointer;
      transition: all 0.2s;
      box-shadow: 0 4px 15px var(--accent-glow);
    }

    .direct-call-action-btn:hover {
      transform: translateY(-1px);
    }

    .direct-status-banner {
      margin-top: 0.75rem;
      padding: 0.65rem 0.9rem;
      border-radius: var(--radius-sm);
      font-size: 0.85rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      line-height: 1.4;
    }

    .status-online {
      background: rgba(16, 185, 129, 0.12);
      border: 1px solid rgba(16, 185, 129, 0.3);
      color: #34d399;
    }

    .status-offline {
      background: rgba(239, 68, 68, 0.12);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #fca5a5;
    }

    .status-busy {
      background: rgba(245, 158, 11, 0.12);
      border: 1px solid rgba(245, 158, 11, 0.3);
      color: #fbbf24;
    }

    .start-call-btn {
      width: 100%;
      max-width: 440px;
      background: linear-gradient(135deg, var(--accent) 0%, #e11d48 100%);
      color: #ffffff;
      border: none;
      padding: 1.35rem 2rem;
      border-radius: var(--radius-lg);
      font-size: 1.25rem;
      font-weight: 800;
      font-family: 'Space Grotesk', sans-serif;
      letter-spacing: -0.01em;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.25rem;
      box-shadow: 0 10px 30px var(--accent-glow), 0 0 0 1px rgba(255, 255, 255, 0.2) inset;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      margin: 0 auto 1.5rem;
      position: relative;
      overflow: hidden;
    }

    .start-call-btn::after {
      content: "";
      position: absolute;
      top: -50%; left: -50%; width: 200%; height: 200%;
      background: linear-gradient(45deg, transparent 40%, rgba(255,255,255,0.2) 50%, transparent 60%);
      transform: rotate(25deg);
      animation: btnShimmer 3.5s infinite;
    }

    @keyframes btnShimmer {
      0% { transform: translateX(-100%) rotate(25deg); }
      100% { transform: translateX(100%) rotate(25deg); }
    }

    .start-call-btn:hover {
      transform: translateY(-2px) scale(1.02);
      box-shadow: 0 16px 40px var(--accent-glow);
    }

    .start-call-btn:active {
      transform: translateY(1px) scale(0.99);
    }

    .start-call-btn .btn-sub {
      font-size: 0.78rem;
      font-family: 'Plus Jakarta Sans', sans-serif;
      font-weight: 500;
      opacity: 0.9;
    }

    .feature-strip {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1rem;
      margin-top: 1.5rem;
      width: 100%;
    }

    .feature-card {
      background: var(--bg-card);
      border: 1px solid rgba(255, 255, 255, 0.07);
      padding: 1.1rem;
      border-radius: var(--radius-md);
      text-align: left;
    }

    .feature-card .feat-icon {
      font-size: 1.4rem;
      margin-bottom: 0.5rem;
    }

    .feature-card h4 {
      font-size: 0.95rem;
      font-weight: 700;
      margin-bottom: 0.25rem;
    }

    .feature-card p {
      font-size: 0.8rem;
      color: var(--text-muted);
      line-height: 1.4;
    }

    /* SEARCHING SCREEN */
    .radar-box {
      position: relative;
      width: 240px;
      height: 240px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 2rem 0;
    }

    .radar-circle {
      position: absolute;
      border-radius: 50%;
      border: 1px solid var(--accent);
      opacity: 0.2;
    }

    .radar-c1 { width: 80px; height: 80px; }
    .radar-c2 { width: 150px; height: 150px; }
    .radar-c3 { width: 220px; height: 220px; }

    .radar-sweep {
      position: absolute;
      width: 220px;
      height: 220px;
      border-radius: 50%;
      background: conic-gradient(from 0deg, var(--accent-glow) 0deg, transparent 60deg, transparent 360deg);
      animation: radarSpin 2.5s linear infinite;
    }

    @keyframes radarSpin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .radar-center-mic {
      width: 64px;
      height: 64px;
      background: var(--accent);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 30px var(--accent-glow);
      z-index: 2;
    }

    .search-timer {
      font-family: 'Space Grotesk', monospace;
      font-size: 2.2rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
      color: var(--text-main);
    }

    .search-status-text {
      color: var(--text-muted);
      font-size: 1rem;
      margin-bottom: 2rem;
      min-height: 24px;
    }

    .cancel-btn {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.4);
      color: #fca5a5;
      padding: 0.85rem 2rem;
      border-radius: 30px;
      font-size: 1rem;
      font-weight: 700;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      transition: all 0.2s;
    }

    .cancel-btn:hover {
      background: rgba(239, 68, 68, 0.25);
      border-color: #ef4444;
      transform: translateY(-1px);
    }

    /* IN-CALL VOICE ROOM */
    .call-container {
      width: 100%;
      max-width: 720px;
      background: var(--bg-card);
      border: 1px solid var(--bg-card-border);
      backdrop-filter: blur(16px);
      border-radius: var(--radius-lg);
      padding: 1.75rem;
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
    }

    .call-top-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      padding-bottom: 1rem;
    }

    .call-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      background: rgba(16, 185, 129, 0.12);
      border: 1px solid rgba(16, 185, 129, 0.3);
      color: #10b981;
      padding: 0.3rem 0.75rem;
      border-radius: 20px;
      font-size: 0.8rem;
      font-weight: 700;
    }

    .call-timer {
      font-family: 'Space Grotesk', monospace;
      font-size: 1.4rem;
      font-weight: 700;
      color: var(--text-main);
    }

    /* PARTICIPANTS DISPLAY */
    .participants-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.5rem;
      padding: 1rem 0;
    }

    .participant-card {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: var(--radius-md);
      padding: 1.5rem;
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      position: relative;
      transition: all 0.3s;
    }

    .participant-card.talking {
      border-color: var(--accent);
      box-shadow: 0 0 25px var(--accent-glow);
    }

    .participant-avatar {
      width: 80px;
      height: 80px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.06);
      border: 2px solid rgba(255, 255, 255, 0.15);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 2.5rem;
      margin-bottom: 0.75rem;
      position: relative;
      transition: all 0.2s;
    }

    .participant-card.talking .participant-avatar {
      border-color: var(--accent);
      transform: scale(1.05);
    }

    .participant-name {
      font-size: 1.1rem;
      font-weight: 700;
      margin-bottom: 0.25rem;
    }

    .participant-role {
      font-size: 0.75rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 0.75rem;
    }

    /* Waveform canvas */
    .wave-canvas {
      width: 100%;
      height: 38px;
      border-radius: 6px;
      background: rgba(0, 0, 0, 0.25);
    }

    /* Push-to-Talk banner */
    .ptt-banner {
      background: rgba(245, 158, 11, 0.12);
      border: 1px solid rgba(245, 158, 11, 0.3);
      color: #fbbf24;
      padding: 0.5rem 1rem;
      border-radius: 8px;
      font-size: 0.85rem;
      font-weight: 600;
      text-align: center;
      display: none;
    }

    .ptt-banner.active {
      display: block;
    }

    .ptt-banner.talking-now {
      background: rgba(16, 185, 129, 0.2);
      border-color: #10b981;
      color: #34d399;
    }

    /* GROUP CALL STYLING & DYNAMIC AUTO ARRANGE */
    .group-container {
      width: 100%;
      max-width: 840px;
      background: var(--bg-card);
      border: 1px solid var(--bg-card-border);
      backdrop-filter: blur(16px);
      border-radius: var(--radius-lg);
      padding: 1.5rem;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
    }

    .group-code-badge {
      font-family: 'Space Grotesk', monospace;
      font-size: 1.15rem;
      font-weight: 800;
      background: var(--accent-subtle);
      border: 1px solid var(--accent);
      color: var(--accent);
      padding: 0.25rem 0.75rem;
      border-radius: 8px;
      letter-spacing: 0.08em;
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      cursor: pointer;
    }

    .group-grid {
      display: grid;
      gap: 0.75rem;
      width: 100%;
      margin: 0.5rem 0;
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }

    /* Auto arrange smaller if many users (1 to 10 users) */
    .group-grid.layout-1-2 {
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 1rem;
    }
    .group-grid.layout-3-4 {
      grid-template-columns: repeat(2, 1fr);
      gap: 0.85rem;
    }
    .group-grid.layout-5-6 {
      grid-template-columns: repeat(3, 1fr);
      gap: 0.75rem;
    }
    .group-grid.layout-7-8 {
      grid-template-columns: repeat(4, 1fr);
      gap: 0.6rem;
    }
    .group-grid.layout-9-10,
    .group-grid.layout-7-10 {
      grid-template-columns: repeat(5, 1fr);
      gap: 0.5rem;
    }

    @media (max-width: 860px) {
      .group-grid.layout-5-6 {
        grid-template-columns: repeat(2, 1fr);
      }
      .group-grid.layout-7-8 {
        grid-template-columns: repeat(2, 1fr);
      }
      .group-grid.layout-9-10,
      .group-grid.layout-7-10 {
        grid-template-columns: repeat(2, 1fr);
      }
    }

    .group-member-card {
      background: rgba(255, 255, 255, 0.035);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: var(--radius-md);
      padding: 1.15rem;
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      position: relative;
      transition: all 0.25s ease;
      min-height: 110px;
      justify-content: center;
    }

    .group-member-card.talking {
      border-color: var(--accent);
      box-shadow: 0 0 22px var(--accent-glow);
    }

    .group-member-card .host-badge {
      position: absolute;
      top: 8px;
      right: 8px;
      font-size: 0.65rem;
      font-weight: 800;
      background: rgba(245, 158, 11, 0.2);
      border: 1px solid #f59e0b;
      color: #fbbf24;
      padding: 2px 6px;
      border-radius: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    /* Auto arrange smaller layout for 5 - 6 users */
    .group-grid.layout-5-6 .group-member-card {
      padding: 0.85rem 0.5rem;
      min-height: 100px;
    }
    .group-grid.layout-5-6 .participant-avatar {
      width: 48px;
      height: 48px;
      font-size: 1.5rem;
      margin-bottom: 0.35rem;
    }
    .group-grid.layout-5-6 .participant-name {
      font-size: 0.9rem;
    }
    .group-grid.layout-5-6 .wave-canvas {
      height: 22px;
    }

    /* Auto arrange smaller layout for 7 - 8 users */
    .group-grid.layout-7-8 .group-member-card {
      padding: 0.65rem 0.4rem;
      border-radius: var(--radius-sm);
      min-height: 90px;
    }
    .group-grid.layout-7-8 .participant-avatar {
      width: 42px;
      height: 42px;
      font-size: 1.35rem;
      margin-bottom: 0.3rem;
    }
    .group-grid.layout-7-8 .participant-name {
      font-size: 0.85rem;
      max-width: 105px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .group-grid.layout-7-8 .participant-role {
      font-size: 0.66rem;
      margin-bottom: 0.2rem;
    }
    .group-grid.layout-7-8 .wave-canvas {
      height: 18px;
    }
    .group-grid.layout-7-8 .host-badge {
      top: 4px;
      right: 4px;
      font-size: 0.55rem;
      padding: 1px 4px;
    }

    /* Auto arrange even smaller layout for 9 - 10 users */
    .group-grid.layout-9-10 .group-member-card,
    .group-grid.layout-7-10 .group-member-card {
      padding: 0.5rem 0.3rem;
      border-radius: var(--radius-sm);
      min-height: 82px;
    }
    .group-grid.layout-9-10 .participant-avatar,
    .group-grid.layout-7-10 .participant-avatar {
      width: 34px;
      height: 34px;
      font-size: 1.15rem;
      margin-bottom: 0.2rem;
    }
    .group-grid.layout-9-10 .participant-name,
    .group-grid.layout-7-10 .participant-name {
      font-size: 0.78rem;
      max-width: 90px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .group-grid.layout-9-10 .participant-role,
    .group-grid.layout-7-10 .participant-role {
      font-size: 0.62rem;
      margin-bottom: 0.15rem;
    }
    .group-grid.layout-9-10 .wave-canvas,
    .group-grid.layout-7-10 .wave-canvas {
      height: 14px;
    }
    .group-grid.layout-9-10 .host-badge,
    .group-grid.layout-7-10 .host-badge {
      top: 3px;
      right: 3px;
      font-size: 0.5rem;
      padding: 1px 3px;
    }

    /* CALL CONTROLS */
    .call-controls {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      padding-top: 1.25rem;
    }

    .volume-row {
      display: flex;
      align-items: center;
      gap: 1rem;
      background: rgba(255, 255, 255, 0.03);
      padding: 0.6rem 1rem;
      border-radius: var(--radius-sm);
    }

    .volume-row label {
      font-size: 0.82rem;
      font-weight: 600;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 0.4rem;
      min-width: 130px;
    }

    .volume-slider {
      flex: 1;
      accent-color: var(--accent);
      cursor: pointer;
    }

    .action-buttons-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      flex-wrap: wrap;
    }

    .ctrl-btn {
      flex: 1;
      min-width: 120px;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: var(--text-main);
      padding: 0.85rem 1rem;
      border-radius: var(--radius-md);
      font-size: 0.95rem;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      transition: all 0.2s;
    }

    .ctrl-btn:hover {
      background: rgba(255, 255, 255, 0.14);
    }

    .ctrl-btn.active-muted {
      background: rgba(239, 68, 68, 0.18);
      border-color: #ef4444;
      color: #fca5a5;
    }

    .end-call-btn {
      flex: 1.2;
      background: linear-gradient(135deg, #ef4444 0%, #b91c1c 100%);
      color: #ffffff;
      border: none;
      padding: 0.85rem 1.25rem;
      border-radius: var(--radius-md);
      font-size: 1rem;
      font-weight: 800;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      box-shadow: 0 4px 15px rgba(239, 68, 68, 0.4);
      transition: all 0.2s;
    }

    .end-call-btn:hover {
      background: linear-gradient(135deg, #dc2626 0%, #991b1b 100%);
      transform: translateY(-1px);
    }

    /* CALL SUMMARY SCREEN (WHEN ENDED) */
    .summary-card {
      width: 100%;
      max-width: 580px;
      background: var(--bg-card);
      border: 1px solid var(--bg-card-border);
      backdrop-filter: blur(16px);
      border-radius: var(--radius-lg);
      padding: 2rem;
      text-align: center;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
    }

    .summary-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      background: rgba(239, 68, 68, 0.12);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #fca5a5;
      padding: 0.35rem 0.85rem;
      border-radius: 30px;
      font-size: 0.85rem;
      font-weight: 700;
      margin-bottom: 1rem;
    }

    .summary-headline {
      font-family: 'Space Grotesk', sans-serif;
      font-size: 2rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
    }

    .summary-sub {
      color: var(--text-muted);
      font-size: 0.95rem;
      margin-bottom: 1.5rem;
    }

    .metrics-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
      margin-bottom: 1.5rem;
    }

    .metric-item {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: var(--radius-md);
      padding: 1rem;
    }

    .metric-val {
      font-family: 'Space Grotesk', monospace;
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--text-main);
      margin-bottom: 0.2rem;
    }

    .metric-label {
      font-size: 0.75rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .cooldown-alert {
      background: rgba(245, 158, 11, 0.1);
      border: 1px solid rgba(245, 158, 11, 0.25);
      color: #fbbf24;
      padding: 0.75rem 1rem;
      border-radius: var(--radius-sm);
      font-size: 0.85rem;
      line-height: 1.4;
      margin-bottom: 1.5rem;
      text-align: left;
      display: flex;
      align-items: flex-start;
      gap: 0.6rem;
    }

    .summary-actions {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .next-stranger-btn {
      background: linear-gradient(135deg, var(--accent) 0%, #e11d48 100%);
      color: #fff;
      border: none;
      padding: 1.1rem;
      border-radius: var(--radius-md);
      font-size: 1.1rem;
      font-weight: 800;
      font-family: 'Space Grotesk', sans-serif;
      cursor: pointer;
      box-shadow: 0 8px 25px var(--accent-glow);
      transition: all 0.2s;
    }

    .next-stranger-btn:hover {
      transform: translateY(-2px);
    }

    .return-home-btn {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: var(--text-main);
      padding: 0.9rem;
      border-radius: var(--radius-md);
      font-size: 0.95rem;
      font-weight: 700;
      cursor: pointer;
    }

    /* MODALS */
    .modal-overlay {
      position: fixed;
      top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(8px);
      z-index: 1000;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 1rem;
    }

    .modal-overlay.active {
      display: flex;
    }

    .modal-box {
      background: var(--bg-card);
      border: 1px solid var(--bg-card-border);
      border-radius: var(--radius-lg);
      width: 100%;
      max-width: 480px;
      padding: 1.75rem;
      max-height: 90vh;
      overflow-y: auto;
      box-shadow: 0 25px 50px rgba(0, 0, 0, 0.6);
      position: relative;
    }

    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1.25rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      padding-bottom: 0.75rem;
    }

    .modal-header h3 {
      font-family: 'Space Grotesk', sans-serif;
      font-size: 1.25rem;
      font-weight: 700;
    }

    .close-modal-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 1.5rem;
      cursor: pointer;
      line-height: 1;
    }

    .avatar-picker-grid {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 0.5rem;
      margin-bottom: 1.25rem;
    }

    .avatar-opt {
      width: 48px;
      height: 48px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.05);
      border: 2px solid transparent;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.6rem;
      cursor: pointer;
      transition: all 0.2s;
    }

    .avatar-opt:hover {
      background: rgba(255, 255, 255, 0.1);
    }

    .avatar-opt.selected {
      border-color: var(--accent);
      background: var(--accent-subtle);
    }

    .input-field {
      width: 100%;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: var(--text-main);
      padding: 0.85rem 1rem;
      border-radius: var(--radius-sm);
      font-size: 1rem;
      font-family: inherit;
      outline: none;
      margin-bottom: 1rem;
      transition: border-color 0.2s;
    }

    .input-field:focus {
      border-color: var(--accent);
      box-shadow: 0 0 10px var(--accent-glow);
    }

    .setting-item {
      margin-bottom: 1.2rem;
    }

    .setting-item label {
      display: block;
      font-size: 0.85rem;
      font-weight: 700;
      margin-bottom: 0.4rem;
      color: var(--text-muted);
    }

    .setting-select {
      width: 100%;
      background: #181b24;
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: var(--text-main);
      padding: 0.75rem 1rem;
      border-radius: var(--radius-sm);
      font-size: 0.95rem;
      outline: none;
    }

    .toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.6rem 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }

    .toggle-info h4 {
      font-size: 0.95rem;
      font-weight: 600;
      margin-bottom: 0.15rem;
    }

    .toggle-info p {
      font-size: 0.78rem;
      color: var(--text-muted);
    }

    /* Switch */
    .switch {
      position: relative;
      display: inline-block;
      width: 46px;
      height: 24px;
    }

    .switch input { opacity: 0; width: 0; height: 0; }

    .slider {
      position: absolute;
      cursor: pointer;
      top: 0; left: 0; right: 0; bottom: 0;
      background-color: rgba(255, 255, 255, 0.15);
      transition: .3s;
      border-radius: 24px;
    }

    .slider:before {
      position: absolute;
      content: "";
      height: 18px;
      width: 18px;
      left: 3px;
      bottom: 3px;
      background-color: white;
      transition: .3s;
      border-radius: 50%;
    }

    input:checked + .slider {
      background-color: var(--accent);
    }

    input:checked + .slider:before {
      transform: translateX(22px);
    }

    .mic-test-meter {
      width: 100%;
      height: 12px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      overflow: hidden;
      margin-top: 0.5rem;
    }

    .mic-test-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #10b981 0%, #fbbf24 70%, #ef4444 100%);
      transition: width 0.05s ease;
    }

    /* HISTORY LIST */
    .history-list {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      max-height: 320px;
      overflow-y: auto;
    }

    .history-card {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.07);
      padding: 0.85rem;
      border-radius: var(--radius-sm);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .hist-name {
      font-weight: 700;
      font-size: 0.95rem;
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }

    .hist-meta {
      font-size: 0.78rem;
      color: var(--text-muted);
    }

    .empty-state {
      text-align: center;
      padding: 2rem 0;
      color: var(--text-muted);
      font-size: 0.9rem;
    }

    /* FOOTER */
    footer {
      margin-top: auto;
      padding: 1.5rem 0 0.5rem;
      border-top: 1px solid rgba(255, 255, 255, 0.07);
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 0.8rem;
      color: var(--text-muted);
    }

    @media (max-width: 640px) {
      .hero-headline { font-size: 2.2rem; }
      .feature-strip { grid-template-columns: 1fr; }
      .participants-grid { grid-template-columns: 1fr; }
      .metrics-row { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>

  <div class="kanji-bg">紅</div>

  <!-- DYNAMIC AZUKI LOADING SCREEN -->
  <div id="loadingScreen">
    <div class="mic-loader-wrapper">
      <div class="sonic-ring"></div>
      <div class="sonic-ring"></div>
      <div class="sonic-ring"></div>
      <div class="mic-core">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" x2="12" y1="19" y2="22"/>
        </svg>
      </div>
    </div>
    <div class="loading-title">ZUKI VOICE TALK</div>
    <div class="loading-sub">Connecting to live matching grid...</div>
    <div class="azuki-made-tag">✨ made with Azuki ✨</div>
  </div>

  <div class="container">
    <!-- HEADER -->
    <header>
      <div class="brand" onclick="navigateHome()">
        <div class="brand-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" x2="12" y1="19" y2="22"/>
          </svg>
        </div>
        <div class="brand-text">
          <h1>ZUKI TALK <span class="azuki-badge">AZUKI</span></h1>
        </div>
      </div>

      <div class="header-actions">
        <div class="live-status-pill" title="100% Real Live People Connected">
          <div class="live-dot"></div>
          <span id="liveCounter">1 Online</span>
        </div>

        <button class="pill-btn" onclick="openModal('historyModal')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          History
        </button>

        <button class="pill-btn" onclick="openModal('settingsModal')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
      </div>
    </header>

    <!-- 1. HOME SCREEN -->
    <div id="homeScreen" class="screen active">
      <div class="home-hero">
        <div class="hero-badge">⚡ Pure Live Audio Network</div>
        <h2 class="hero-headline">Instant Voice Talk with <span>Real Strangers</span></h2>
        <p class="hero-desc">
          No bots, no fake users, no simulated recordings. Connect instantly via encrypted WebRTC with actual live people online right now.
        </p>

        <div style="display:flex; justify-content:center; gap:0.75rem; flex-wrap:wrap; margin-bottom: 1.5rem;">
          <div class="profile-card-preview" onclick="openModal('usernameModal')" title="Click to change codename & avatar">
            <div class="avatar-circle" id="homeAvatarPreview">🦊</div>
            <div style="text-align: left;">
              <div style="font-size: 0.72rem; color: var(--text-muted); text-transform: uppercase;">Your Codename</div>
              <div style="font-size: 0.95rem; font-weight: 700;" id="homeUsernamePreview">Ronin_99</div>
            </div>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m18 15-6-6-6 6"/></svg>
          </div>

          <div class="permanent-id-chip" onclick="copyPermanentId()" title="Click to copy your 1-on-1 Permanent ID">
            <div style="text-align: left;">
              <div style="font-size: 0.72rem; color: var(--accent); font-weight: 700; text-transform: uppercase;">1-on-1 ID</div>
              <div style="font-size: 0.95rem; font-family: 'Space Grotesk', monospace; font-weight: 800; letter-spacing: 0.05em;" id="homePermanentIdPreview">ZK-XXXXXX</div>
            </div>
            <span id="copyIdBtnText" class="copy-badge">📋 Copy</span>
          </div>

          <div class="permanent-id-chip" onclick="copyGroupPermanentId()" title="Click to copy your Group 4-Code Permanent ID" style="border-color: rgba(0, 240, 255, 0.4); background: rgba(0, 240, 255, 0.06);">
            <div style="text-align: left;">
              <div style="font-size: 0.72rem; color: #00f0ff; font-weight: 700; text-transform: uppercase;">Group 4-Code</div>
              <div style="font-size: 0.95rem; font-family: 'Space Grotesk', monospace; font-weight: 800; letter-spacing: 0.08em; color: #00f0ff;" id="homeGroupPermanentIdPreview">----</div>
            </div>
            <span id="copyGroupIdBtnText" class="copy-badge" style="border-color: #00f0ff; color: #00f0ff; background: rgba(0, 240, 255, 0.15);">📋 Copy</span>
          </div>
        </div>

        <button class="start-call-btn" id="startFindingBtn" onclick="startFindingStranger()">
          <span>START FINDING STRANGER</span>
          <span class="btn-sub">1-on-1 Random Match • Instant Voice</span>
        </button>

        <!-- DIRECT INSTANT CALL BY PERMANENT ID -->
        <div class="direct-call-box">
          <div class="direct-call-header">
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              <span style="font-size: 1.1rem;">⚡</span>
              <span style="font-weight: 700; font-size: 0.95rem;">Instant Call via Permanent ID</span>
            </div>
            <span style="font-size: 0.75rem; color: var(--text-muted);">Checks if user is online first</span>
          </div>

          <div class="direct-input-group">
            <input type="text" id="targetPermanentIdInput" class="direct-id-input" placeholder="Enter ID (e.g. ZK-A82F10)" maxlength="16" oninput="this.value = this.value.toUpperCase()">
            <button class="check-online-btn" onclick="checkUserOnlineStatus()" id="checkStatusBtn">
              🔍 Check Status
            </button>
            <button class="direct-call-action-btn" onclick="initiateDirectCall()" id="directCallActionBtn">
              📞 Instant Call
            </button>
          </div>

          <!-- Live Status feedback banner -->
          <div id="directStatusBanner" class="direct-status-banner" style="display: none;"></div>
        </div>

        <!-- NEW MODE: GROUP VOICE CALL (4-CODE ROOMS, MAX 10 USERS) -->
        <div class="direct-call-box" style="border-color: rgba(0, 240, 255, 0.28); box-shadow: 0 0 20px rgba(0, 240, 255, 0.05);">
          <div class="direct-call-header">
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              <span style="font-size: 1.15rem;">👥</span>
              <span style="font-weight: 800; font-size: 1rem; color: #00f0ff;">Group Voice Call (4-Code ID)</span>
            </div>
            <span style="font-size: 0.72rem; font-weight: 800; color: #00f0ff; background: rgba(0, 240, 255, 0.12); border: 1px solid rgba(0, 240, 255, 0.3); padding: 2px 8px; border-radius: 12px; text-transform: uppercase;">Max 10 Users</span>
          </div>

          <p style="font-size: 0.82rem; color: var(--text-muted); margin-bottom: 1rem; line-height: 1.45;">
            Join or start an encrypted multi-user voice room using a 4-code permanent ID. Auto-arranges up to 10 participants.
          </p>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; margin-bottom: 0.75rem;">
            <!-- Start Your Permanent Group -->
            <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); padding: 0.9rem; border-radius: var(--radius-sm); text-align: left; display: flex; flex-direction: column; justify-content: space-between;">
              <div>
                <div style="font-size: 0.75rem; font-weight: 800; text-transform: uppercase; color: var(--accent); margin-bottom: 0.35rem; letter-spacing: 0.05em;">👑 Host Your Group</div>
                <div style="display: flex; align-items: center; justify-content: space-between; background: rgba(0,0,0,0.3); padding: 0.4rem 0.6rem; border-radius: 6px; border: 1px solid rgba(255,255,255,0.08); margin-bottom: 0.6rem;">
                  <span style="font-size: 0.75rem; color: var(--text-muted);">Your 4-Code:</span>
                  <span id="myGroupCodeBadge" style="font-family: 'Space Grotesk', monospace; font-weight: 800; font-size: 1.05rem; color: #00f0ff; letter-spacing: 0.08em;">----</span>
                </div>
              </div>
              <button class="start-call-btn" id="startMyGroupBtn" style="width: 100%; padding: 0.75rem 0.5rem; font-size: 0.9rem; margin: 0;" onclick="startMyPermanentGroupCall()">
                <span id="startMyGroupBtnText">🔥 Start My Group</span>
              </button>
            </div>

            <!-- Join Existing Group by 4-Code -->
            <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); padding: 0.9rem; border-radius: var(--radius-sm); text-align: left; display: flex; flex-direction: column; justify-content: space-between;">
              <div>
                <div style="font-size: 0.75rem; font-weight: 800; text-transform: uppercase; color: #00f0ff; margin-bottom: 0.4rem; letter-spacing: 0.05em;">🔑 Join a Group</div>
                <input type="text" id="joinGroupCodeInput" class="direct-id-input" placeholder="Enter 4-Code" maxlength="4" style="text-align: center; font-size: 1.05rem; width: 100%; margin-bottom: 0.6rem; text-transform: uppercase;" oninput="this.value = this.value.toUpperCase()">
              </div>
              <div style="display: flex; gap: 0.4rem;">
                <button class="check-online-btn" style="flex: 1; padding: 0.7rem 0.4rem; font-size: 0.8rem;" onclick="checkGroupRoomStatus()">
                  🔍 Check
                </button>
                <button class="direct-call-action-btn" style="flex: 1.3; padding: 0.7rem 0.5rem; font-size: 0.82rem; background: linear-gradient(135deg, #00f0ff 0%, #0077ff 100%); color: #000; font-weight: 900;" onclick="joinGroupCall()">
                  🎙️ Join (10)
                </button>
              </div>
            </div>
          </div>

          <!-- Group Live Status feedback banner (displays : this group hasn't started by user / : this group is full (10)) -->
          <div id="groupStatusBanner" class="direct-status-banner" style="display: none;"></div>
        </div>

        <div class="feature-strip">
          <div class="feature-card">
            <div class="feat-icon">🛑</div>
            <h4>End Call Anytime</h4>
            <p>Either user can hang up at any moment with zero locks or wait penalties.</p>
          </div>
          <div class="feature-card">
            <div class="feat-icon">⚡</div>
            <h4>Instant Re-match</h4>
            <p>Zero cooldowns or delays. Hop straight into a new voice conversation anytime.</p>
          </div>
          <div class="feature-card">
            <div class="feat-icon">🎙️</div>
            <h4>Crisp Audio Engine</h4>
            <p>Equipped with noise suppression, echo cancellation, volume boost & Push-to-Talk.</p>
          </div>
        </div>
      </div>
    </div>

    <!-- 2. SEARCHING SCREEN -->
    <div id="searchingScreen" class="screen">
      <div class="radar-box">
        <div class="radar-circle radar-c1"></div>
        <div class="radar-circle radar-c2"></div>
        <div class="radar-circle radar-c3"></div>
        <div class="radar-sweep"></div>
        <div class="radar-center-mic">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" x2="12" y1="19" y2="22"/>
          </svg>
        </div>
      </div>

      <div class="search-timer" id="searchTimer">00:00</div>
      <div class="search-status-text" id="searchStatusText">Scanning live frequencies for online strangers...</div>

      <button class="cancel-btn" onclick="cancelSearch()">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        Cancel Search
      </button>
    </div>

    <!-- 3. IN-CALL VOICE ROOM -->
    <div id="callScreen" class="screen">
      <div class="call-container">
        <div class="call-top-bar">
          <div class="call-badge">
            <span class="live-dot" style="background:#10b981;"></span>
            <span>VOICE CONNECTED</span>
          </div>
          <div class="call-timer" id="callDurationTimer">00:00</div>
          <div style="font-size: 0.8rem; color: var(--text-muted);" id="callEncryptionBadge">🔒 WebRTC P2P</div>
        </div>

        <div id="pttBanner" class="ptt-banner">
          ⌨️ PUSH-TO-TALK ACTIVE: Hold <strong>SPACEBAR</strong> to talk
        </div>

        <div class="participants-grid">
          <!-- You -->
          <div class="participant-card" id="youCard">
            <div class="participant-avatar" id="youAvatar">🦊</div>
            <div class="participant-name" id="youName">You</div>
            <div class="participant-role">Local Microphone</div>
            <canvas id="localWaveCanvas" class="wave-canvas" width="240" height="40"></canvas>
          </div>

          <!-- Stranger -->
          <div class="participant-card" id="strangerCard">
            <div class="participant-avatar" id="strangerAvatar">👹</div>
            <div class="participant-name" id="strangerName">Stranger</div>
            <div class="participant-role">Live Stranger</div>
            <canvas id="remoteWaveCanvas" class="wave-canvas" width="240" height="40"></canvas>
          </div>
        </div>

        <div class="call-controls">
          <div class="volume-row">
            <label>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
              Stranger Volume
            </label>
            <input type="range" class="volume-slider" id="strangerVolumeSlider" min="0" max="150" value="100" oninput="adjustStrangerVolume(this.value)">
            <span id="volumePercentText" style="font-size:0.8rem; font-family:monospace; min-width:35px;">100%</span>
          </div>

          <div class="action-buttons-row">
            <button class="ctrl-btn" id="muteMicBtn" onclick="toggleMuteMic()">
              <svg id="muteMicIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
              <span id="muteMicText">Mute Mic</span>
            </button>

            <button class="ctrl-btn" onclick="openModal('settingsModal')">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/></svg>
              <span>Audio Config</span>
            </button>

            <button class="end-call-btn" onclick="endCallAnytime()">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="22" y1="2" x2="2" y2="22"/></svg>
              <span>END CALL</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 4. CALL SUMMARY (STAY IN ROOM TO VIEW SESSION INFO) -->
    <div id="summaryScreen" class="screen">
      <div class="summary-card">
        <div class="summary-badge" id="summaryEndReasonBadge">🛑 Call Ended</div>
        <h2 class="summary-headline" id="summaryHeadline">Session Ended</h2>
        <p class="summary-sub" id="summarySub">You stayed in the room to view session details.</p>

        <div class="metrics-row">
          <div class="metric-item">
            <div class="metric-val" id="summaryDurationVal">00:00</div>
            <div class="metric-label">Talk Duration</div>
          </div>
          <div class="metric-item">
            <div class="metric-val" id="summaryStrangerNameVal">Stranger</div>
            <div class="metric-label">Stranger Codename</div>
          </div>
        </div>


        <div class="summary-actions">
          <button class="next-stranger-btn" onclick="startFindingStranger()">
            🔥 FIND ANOTHER STRANGER
          </button>
          <button class="return-home-btn" onclick="navigateHome()">
            🏠 Return to Lobby
          </button>
        </div>
      </div>
    </div>

    <!-- 5. GROUP VOICE CALL ROOM (UP TO 10 USERS, AUTO ARRANGE) -->
    <div id="groupCallScreen" class="screen">
      <div class="group-container">
        <div class="call-top-bar">
          <div style="display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;">
            <div class="call-badge" style="background: rgba(0, 240, 255, 0.12); border-color: rgba(0, 240, 255, 0.3); color: #00f0ff;">
              <span class="live-dot" style="background:#00f0ff; box-shadow: 0 0 10px #00f0ff;"></span>
              <span>GROUP VOICE ACTIVE</span>
            </div>
            <div class="group-code-badge" onclick="copyGroupRoomCode()" title="Click to copy 4-Code">
              <span style="font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase;">ROOM:</span>
              <span id="currentGroupCodeDisplay">----</span>
              <span id="copyGroupCodeBtnText" style="font-size: 0.72rem; background: rgba(255,255,255,0.12); padding: 2px 6px; border-radius: 4px;">📋 Copy</span>
            </div>
          </div>

          <div style="display: flex; align-items: center; gap: 0.75rem;">
            <div class="live-status-pill" id="groupMemberCountBadge" style="background: rgba(0, 240, 255, 0.1); border-color: rgba(0, 240, 255, 0.3); color: #00f0ff;">
              👥 <span id="groupCountText">1 / 10 Users</span>
            </div>
            <div class="call-timer" id="groupCallTimer">00:00</div>
          </div>
        </div>

        <div id="groupPttBanner" class="ptt-banner">
          ⌨️ PUSH-TO-TALK ACTIVE: Hold <strong>SPACEBAR</strong> to talk
        </div>

        <!-- DYNAMIC AUTO-ARRANGING PARTICIPANTS GRID (UP TO 10 USERS) -->
        <div id="groupGrid" class="group-grid layout-1-2">
          <!-- Populated by renderGroupGrid() -->
        </div>

        <!-- Controls Bar -->
        <div class="call-controls">
          <div class="volume-row">
            <label>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
              Group Master Volume
            </label>
            <input type="range" class="volume-slider" id="groupVolumeSlider" min="0" max="150" value="100" oninput="adjustGroupVolume(this.value)">
            <span id="groupVolumePercentText" style="font-size:0.8rem; font-family:monospace; min-width:35px;">100%</span>
          </div>

          <div class="action-buttons-row">
            <button class="ctrl-btn" id="groupMuteMicBtn" onclick="toggleMuteMic()">
              <svg id="groupMuteMicIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
              <span id="groupMuteMicText">Mute Mic</span>
            </button>

            <button class="ctrl-btn" onclick="openModal('settingsModal')">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/></svg>
              <span>Audio Config</span>
            </button>

            <button class="end-call-btn" onclick="leaveGroupCall()">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="22" y1="2" x2="2" y2="22"/></svg>
              <span>LEAVE GROUP</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- FOOTER -->
    <footer>
      <div>✨ made with Azuki ✨ • 100% Real Live Voice Talk</div>
      <div>Zero Bots • P2P WebRTC</div>
    </footer>
  </div>

  <!-- HIDDEN AUDIO ELEMENT FOR 1-ON-1 STRANGER -->
  <audio id="remoteAudio" autoplay playsinline></audio>
  <!-- HIDDEN AUDIO CONTAINER FOR GROUP ROOM PEERS -->
  <div id="groupAudiosContainer" style="display: none;"></div>

  <!-- MODAL 1: USERNAME & AVATAR MODAL -->
  <div class="modal-overlay" id="usernameModal">
    <div class="modal-box">
      <div class="modal-header">
        <h3>Choose Your Identity</h3>
        <button class="close-modal-btn" onclick="closeModal('usernameModal')">&times;</button>
      </div>

      <div style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.75rem;">Select your Azuki avatar:</div>
      <div class="avatar-picker-grid">
        <div class="avatar-opt selected" onclick="pickAvatar('🦊', this)">🦊</div>
        <div class="avatar-opt" onclick="pickAvatar('👹', this)">👹</div>
        <div class="avatar-opt" onclick="pickAvatar('⚔️', this)">⚔️</div>
        <div class="avatar-opt" onclick="pickAvatar('🥷', this)">🥷</div>
        <div class="avatar-opt" onclick="pickAvatar('🐉', this)">🐉</div>
        <div class="avatar-opt" onclick="pickAvatar('⚡', this)">⚡</div>
      </div>

      <div style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.4rem;">Codename (no account needed):</div>
      <div style="display:flex; gap:0.5rem;">
        <input type="text" id="usernameInput" class="input-field" placeholder="Enter codename (e.g. NeonRonin)" maxlength="20">
        <button class="pill-btn" style="height:48px; border-radius:8px;" onclick="randomizeCodename()" title="Randomize Codename">🎲</button>
      </div>

      <button class="next-stranger-btn" style="width:100%;" onclick="saveUsernameAndClose()">
        Save & Continue
      </button>
    </div>
  </div>

  <!-- MODAL 2: SETTINGS MODAL -->
  <div class="modal-overlay" id="settingsModal">
    <div class="modal-box">
      <div class="modal-header">
        <h3>Audio & Experience Settings</h3>
        <button class="close-modal-btn" onclick="closeModal('settingsModal')">&times;</button>
      </div>

      <!-- Theme selector -->
      <div class="setting-item">
        <label>Theme Aesthetic</label>
        <select class="setting-select" id="themeSelect" onchange="changeTheme(this.value)">
          <option value="azuki">Azuki Crimson (Default)</option>
          <option value="cyberpunk">Cyberpunk Neon</option>
          <option value="stealth">Samurai Stealth (OLED)</option>
          <option value="sunset">Tokyo Sunset</option>
        </select>
      </div>

      <!-- Audio Input -->
      <div class="setting-item">
        <label>Microphone Input Device</label>
        <select class="setting-select" id="audioInputSelect" onchange="changeAudioInput(this.value)">
          <option value="">Default Microphone</option>
        </select>
      </div>

      <!-- Audio Output -->
      <div class="setting-item">
        <label>Speaker / Audio Output</label>
        <select class="setting-select" id="audioOutputSelect" onchange="changeAudioOutput(this.value)">
          <option value="">Default Speaker</option>
        </select>
      </div>

      <!-- Noise suppression toggle -->
      <div class="toggle-row">
        <div class="toggle-info">
          <h4>Noise Suppression</h4>
          <p>Filter out background static, fans, and street noise</p>
        </div>
        <label class="switch">
          <input type="checkbox" id="noiseSuppressionToggle" checked onchange="updateAudioPreferences()">
          <span class="slider"></span>
        </label>
      </div>

      <!-- Echo Cancellation -->
      <div class="toggle-row">
        <div class="toggle-info">
          <h4>Echo Cancellation</h4>
          <p>Prevent feedback loop when using speaker</p>
        </div>
        <label class="switch">
          <input type="checkbox" id="echoCancellationToggle" checked onchange="updateAudioPreferences()">
          <span class="slider"></span>
        </label>
      </div>

      <!-- Push to Talk -->
      <div class="toggle-row">
        <div class="toggle-info">
          <h4>Push-to-Talk (Spacebar)</h4>
          <p>Keep mic muted until you hold Spacebar</p>
        </div>
        <label class="switch">
          <input type="checkbox" id="pushToTalkToggle" onchange="updatePttPreference(this.checked)">
          <span class="slider"></span>
        </label>
      </div>

      <!-- Mic Test Meter -->
      <div class="setting-item" style="margin-top: 1.25rem;">
        <label>Test Microphone</label>
        <button class="pill-btn" id="testMicBtn" style="width:100%; justify-content:center;" onclick="toggleMicTest()">
          🎙️ Start Microphone Test
        </button>
        <div class="mic-test-meter">
          <div class="mic-test-fill" id="micTestBar"></div>
        </div>
      </div>
    </div>
  </div>

  <!-- MODAL 3: CALL HISTORY MODAL -->
  <div class="modal-overlay" id="historyModal">
    <div class="modal-box">
      <div class="modal-header">
        <h3>Recent Call History</h3>
        <button class="close-modal-btn" onclick="closeModal('historyModal')">&times;</button>
      </div>
      <div style="font-size:0.8rem; color:var(--text-muted); margin-bottom:1rem;">
        Saved locally on this device. Never uploaded to servers.
      </div>
      <div class="history-list" id="historyListContainer">
        <!-- Rendered by JS -->
      </div>
      <div style="margin-top:1.25rem; display:flex; gap:0.5rem;">
        <button class="pill-btn" style="flex:1; justify-content:center; color:#fca5a5;" onclick="clearCallHistory()">
          Clear History
        </button>
        <button class="pill-btn" style="flex:1; justify-content:center;" onclick="closeModal('historyModal')">
          Done
        </button>
      </div>
    </div>
  </div>

  <!-- MODAL 4: OUTGOING DIRECT CALL OVERLAY -->
  <div class="modal-overlay" id="outgoingCallModal" style="z-index: 2000;">
    <div class="modal-box" style="text-align: center; max-width: 420px;">
      <div class="mic-loader-wrapper" style="width: 100px; height: 100px; margin: 0 auto 1.25rem;">
        <div class="sonic-ring"></div>
        <div class="sonic-ring"></div>
        <div class="mic-core" style="width: 56px; height: 56px; font-size: 1.8rem;" id="outgoingAvatarIcon">🦊</div>
      </div>
      <div style="font-size: 0.82rem; color: var(--accent); font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 0.35rem;">
        Outgoing Direct Call
      </div>
      <h3 style="font-family: 'Space Grotesk', sans-serif; font-size: 1.5rem; margin-bottom: 0.25rem;" id="outgoingTargetName">Calling...</h3>
      <div style="font-family: monospace; font-size: 0.9rem; color: var(--text-muted); margin-bottom: 1.25rem;" id="outgoingTargetId">ZK-XXXXXX</div>
      <p style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 1.5rem;" id="outgoingCallStatusText">Ringing... waiting for user to answer</p>
      <button class="cancel-btn" style="width: 100%; justify-content: center;" onclick="cancelDirectCall()">
        ✕ Cancel Call
      </button>
    </div>
  </div>

  <!-- MODAL 5: INCOMING DIRECT CALL OVERLAY -->
  <div class="modal-overlay" id="incomingCallModal" style="z-index: 2500;">
    <div class="modal-box" style="text-align: center; max-width: 420px; border-color: #10b981; box-shadow: 0 0 50px rgba(16, 185, 129, 0.35);">
      <div class="mic-loader-wrapper" style="width: 110px; height: 110px; margin: 0 auto 1.25rem;">
        <div class="sonic-ring" style="border-color: #10b981;"></div>
        <div class="sonic-ring" style="border-color: #10b981;"></div>
        <div class="mic-core" style="width: 64px; height: 64px; background: linear-gradient(135deg, #10b981, #059669); font-size: 2rem; box-shadow: 0 0 30px rgba(16, 185, 129, 0.4);" id="incomingAvatarIcon">👹</div>
      </div>
      <div style="font-size: 0.82rem; color: #34d399; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 0.35rem;">
        🔔 Incoming Direct Voice Call
      </div>
      <h3 style="font-family: 'Space Grotesk', sans-serif; font-size: 1.6rem; margin-bottom: 0.25rem;" id="incomingCallerName">Stranger</h3>
      <div style="font-family: monospace; font-size: 0.95rem; color: var(--text-muted); margin-bottom: 1.75rem;" id="incomingCallerId">ID: ZK-XXXXXX</div>
      <div style="display: flex; gap: 0.75rem;">
        <button class="ctrl-btn" style="flex: 1; background: rgba(239, 68, 68, 0.18); border-color: #ef4444; color: #fca5a5;" onclick="declineIncomingCall()">
          ✕ Decline
        </button>
        <button class="ctrl-btn" style="flex: 1.4; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; border: none; font-weight: 800; box-shadow: 0 4px 15px rgba(16, 185, 129, 0.4);" onclick="acceptIncomingCall()">
          📞 Accept Call
        </button>
      </div>
    </div>
  </div>

  <!-- APPLICATION LOGIC SCRIPT -->
  <script>
    // -----------------------------------------------------------------
    // STATE & CONFIG
    // -----------------------------------------------------------------
    const socket = io();
    let localStream = null;
    let peerConnection = null;
    let currentRoomId = null;
    let currentPartner = null;
    let isInitiator = false;

    let isSearching = false;
    let searchTimerInterval = null;
    let searchSeconds = 0;

    let callTimerInterval = null;
    let callSeconds = 0;

    let isMicMuted = false;
    let pushToTalkEnabled = false;
    let isSpacebarPressed = false;

    let audioContext = null;
    let localAnalyser = null;
    let remoteAnalyser = null;
    let animationFrameId = null;

    let testMicStream = null;
    let testMicAudioCtx = null;
    let testMicAnalyser = null;
    let testMicAnimId = null;

    // Stun configuration for reliable P2P WebRTC
    const rtcConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      ]
    };

    // User profile state & Permanent ID
    let myPermanentId = localStorage.getItem('zuki_permanent_id');
    if (!myPermanentId) {
      const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
      let code = 'ZK-';
      for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      myPermanentId = code;
      localStorage.setItem('zuki_permanent_id', myPermanentId);
    }

    // Four-code permanent ID for user's group
    let myGroupPermanentId = localStorage.getItem('zuki_group_permanent_id');
    if (!myGroupPermanentId) {
      const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
      let gCode = '';
      for (let i = 0; i < 4; i++) {
        gCode += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      myGroupPermanentId = gCode;
      localStorage.setItem('zuki_group_permanent_id', myGroupPermanentId);
    }

    let myUserId = localStorage.getItem('zuki_user_uid');
    if (!myUserId) {
      myUserId = 'zuki_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now();
      localStorage.setItem('zuki_user_uid', myUserId);
    }

    let myUsername = localStorage.getItem('zuki_username') || '';
    let myAvatar = localStorage.getItem('zuki_avatar') || '🦊';
    let currentTheme = localStorage.getItem('zuki_theme') || 'azuki';
    pushToTalkEnabled = localStorage.getItem('zuki_ptt') === 'true';

    let currentOutgoingTargetId = null;
    let pendingIncomingCall = null;
    let ringInterval = null;

    // Group Voice Calling State (4-code rooms, max 10 users)
    let currentGroupCode = null;
    let isGroupHost = false;
    let groupMembers = new Map(); // socketId -> memberData
    let groupPeerConnections = new Map(); // socketId -> RTCPeerConnection
    let groupAudioStreams = new Map(); // socketId -> MediaStream
    let groupAnalysers = new Map(); // socketId -> AnalyserNode
    let groupCallTimerInterval = null;
    let groupCallSeconds = 0;
    let groupMasterVolume = 100;

    // Pleasant audio ringtone generator using Web Audio API
    function playRingtone(isOutgoing) {
      stopRingtone();
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        function playChime() {
          const osc1 = ctx.createOscillator();
          const osc2 = ctx.createOscillator();
          const gain = ctx.createGain();
          osc1.type = 'sine';
          osc2.type = 'sine';
          osc1.frequency.setValueAtTime(isOutgoing ? 440 : 523.25, ctx.currentTime);
          osc2.frequency.setValueAtTime(isOutgoing ? 480 : 659.25, ctx.currentTime);
          gain.gain.setValueAtTime(0.08, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.2);
          osc1.connect(gain);
          osc2.connect(gain);
          gain.connect(ctx.destination);
          osc1.start();
          osc2.start();
          osc1.stop(ctx.currentTime + 1.2);
        }
        playChime();
        ringInterval = setInterval(playChime, 3000);
      } catch (e) {}
    }

    function stopRingtone() {
      if (ringInterval) {
        clearInterval(ringInterval);
        ringInterval = null;
      }
    }

    // -----------------------------------------------------------------
    // INITIALIZATION & LOADING SCREEN
    // -----------------------------------------------------------------
    window.addEventListener('DOMContentLoaded', () => {
      // Apply theme
      applyTheme(currentTheme);
      document.getElementById('themeSelect').value = currentTheme;
      document.getElementById('pushToTalkToggle').checked = pushToTalkEnabled;

      // Handle username
      if (!myUsername) {
        randomizeCodename();
      }
      updateHomeProfileDisplay();
      randomizeGroupCodeInput();

      // Enumerate audio devices
      refreshAudioDevices();
      if (navigator.mediaDevices && navigator.mediaDevices.ondevicechange) {
        navigator.mediaDevices.ondevicechange = refreshAudioDevices;
      }

      // Hide loading screen smoothly after 1.4s
      setTimeout(() => {
        const loader = document.getElementById('loadingScreen');
        if (loader) {
          loader.style.opacity = '0';
          loader.style.pointerEvents = 'none';
          setTimeout(() => { loader.style.display = 'none'; }, 500);
        }
      }, 1400);

      // Register socket when connected
      socket.on('connect', () => {
        registerUserWithServer();
      });

      // Render past history
      renderCallHistory();
    });

    function registerUserWithServer() {
      socket.emit('user:register', {
        userId: myUserId,
        permanentId: myPermanentId,
        groupPermanentId: myGroupPermanentId,
        username: myUsername || 'Ronin_99',
        avatar: myAvatar
      });
    }

    function copyPermanentId() {
      if (!myPermanentId) return;
      navigator.clipboard.writeText(myPermanentId).then(() => {
        const btn = document.getElementById('copyIdBtnText');
        if (btn) {
          const original = btn.textContent;
          btn.textContent = 'Copied! ✨';
          btn.style.borderColor = '#10b981';
          btn.style.color = '#34d399';
          setTimeout(() => {
            btn.textContent = original;
            btn.style.borderColor = '';
            btn.style.color = '';
          }, 2000);
        }
      }).catch(() => {
        prompt('Your Permanent ID (Press Ctrl+C to copy):', myPermanentId);
      });
    }

    function copyGroupPermanentId() {
      if (!myGroupPermanentId) return;
      navigator.clipboard.writeText(myGroupPermanentId).then(() => {
        const btn = document.getElementById('copyGroupIdBtnText');
        if (btn) {
          const original = btn.textContent;
          btn.textContent = 'Copied! ✨';
          btn.style.borderColor = '#00f0ff';
          btn.style.color = '#00f0ff';
          setTimeout(() => {
            btn.textContent = original;
            btn.style.borderColor = '';
            btn.style.color = '';
          }, 2000);
        }
      }).catch(() => {
        prompt('Your 4-Code Group ID (Press Ctrl+C to copy):', myGroupPermanentId);
      });
    }

    function startMyPermanentGroupCall() {
      if (!myGroupPermanentId) return;
      showGroupStatus('Starting your permanent group room (' + myGroupPermanentId + ')...', 'status-busy');
      socket.emit('group:create', { customCode: myGroupPermanentId });
    }

    // -----------------------------------------------------------------
    // DIRECT CALL BY PERMANENT ID (ONLINE CHECK & CALLING)
    // -----------------------------------------------------------------
    function checkUserOnlineStatus() {
      const input = document.getElementById('targetPermanentIdInput');
      const targetId = (input.value || '').trim().toUpperCase();

      if (!targetId) {
        showDirectStatus('⚠️ Please enter a Permanent ID (e.g. ZK-A82F10)', 'status-offline');
        input.focus();
        return;
      }

      if (targetId === myPermanentId) {
        showDirectStatus('⚠️ This is your own Permanent ID.', 'status-busy');
        return;
      }

      showDirectStatus('Pinging server to check live online status...', 'status-busy');
      socket.emit('direct:check', { targetId });
    }

    function initiateDirectCall() {
      const input = document.getElementById('targetPermanentIdInput');
      const targetId = (input.value || '').trim().toUpperCase();

      if (!targetId) {
        showDirectStatus('⚠️ Please enter a Permanent ID first.', 'status-offline');
        input.focus();
        return;
      }

      if (targetId === myPermanentId) {
        showDirectStatus('⚠️ You cannot call your own Permanent ID.', 'status-busy');
        return;
      }

      showDirectStatus('Checking live status & connecting...', 'status-busy');
      socket.emit('direct:call_request', { targetId });
    }

    function showDirectStatus(msg, cssClass) {
      const banner = document.getElementById('directStatusBanner');
      if (!banner) return;
      banner.style.display = 'flex';
      banner.className = 'direct-status-banner ' + cssClass;
      banner.innerHTML = msg;
    }

    function acceptIncomingCall() {
      if (!pendingIncomingCall) return;
      stopRingtone();
      closeModal('incomingCallModal');
      socket.emit('direct:call_accept', {
        callerSocketId: pendingIncomingCall.callerSocketId,
        callSessionId: pendingIncomingCall.callSessionId
      });
      pendingIncomingCall = null;
    }

    function declineIncomingCall() {
      if (!pendingIncomingCall) return;
      stopRingtone();
      closeModal('incomingCallModal');
      socket.emit('direct:call_decline', {
        callerSocketId: pendingIncomingCall.callerSocketId
      });
      pendingIncomingCall = null;
    }

    function cancelDirectCall() {
      if (currentOutgoingTargetId) {
        socket.emit('direct:call_cancel', { targetId: currentOutgoingTargetId });
      }
      closeModal('outgoingCallModal');
      stopRingtone();
      currentOutgoingTargetId = null;
    }

    // -----------------------------------------------------------------
    // GROUP VOICE CALL (4-CODE ROOMS, AUTO-ARRANGE UP TO 10 USERS)
    // -----------------------------------------------------------------
    function randomizeGroupCodeInput() {
      const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
      let code = '';
      for (let i = 0; i < 4; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
      }
      const el = document.getElementById('createGroupCodeInput');
      if (el) el.value = code;
    }

    function showGroupStatus(msg, cssClass) {
      const banner = document.getElementById('groupStatusBanner');
      if (!banner) return;
      banner.style.display = 'flex';
      banner.className = 'direct-status-banner ' + cssClass;
      banner.innerHTML = msg;
    }

    function checkGroupRoomStatus() {
      const input = document.getElementById('joinGroupCodeInput');
      const code = (input.value || '').trim().toUpperCase();
      if (!code || code.length !== 4) {
        showGroupStatus('⚠️ Please enter a 4-code Group ID (e.g. 8492)', 'status-offline');
        input.focus();
        return;
      }
      showGroupStatus('Checking group room on server...', 'status-busy');
      socket.emit('group:check', { code });
    }

    function createGroupCall() {
      const input = document.getElementById('createGroupCodeInput');
      const customCode = (input.value || '').trim().toUpperCase();
      if (customCode && customCode.length !== 4) {
        showGroupStatus('⚠️ Custom group code must be 4 characters.', 'status-offline');
        input.focus();
        return;
      }
      showGroupStatus('Creating group voice room...', 'status-busy');
      socket.emit('group:create', { customCode });
    }

    function joinGroupCall() {
      const input = document.getElementById('joinGroupCodeInput');
      const code = (input.value || '').trim().toUpperCase();
      if (!code || code.length !== 4) {
        showGroupStatus('⚠️ Please enter a 4-code Group ID (e.g. 8492)', 'status-offline');
        input.focus();
        return;
      }
      showGroupStatus('Connecting to group room...', 'status-busy');
      socket.emit('group:join', { code });
    }

    function copyGroupRoomCode() {
      if (!currentGroupCode) return;
      navigator.clipboard.writeText(currentGroupCode).then(() => {
        const btn = document.getElementById('copyGroupCodeBtnText');
        if (btn) {
          const orig = btn.textContent;
          btn.textContent = 'Copied! ✨';
          setTimeout(() => { btn.textContent = orig; }, 2000);
        }
      }).catch(() => {
        prompt('Group 4-Code (Press Ctrl+C to copy):', currentGroupCode);
      });
    }

    async function ensureLocalMicrophone() {
      if (localStream) return localStream;
      const inputDeviceId = document.getElementById('audioInputSelect').value;
      const noiseSuppression = document.getElementById('noiseSuppressionToggle').checked;
      const echoCancellation = document.getElementById('echoCancellationToggle').checked;
      try {
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: inputDeviceId ? { exact: inputDeviceId } : undefined,
            echoCancellation,
            noiseSuppression,
            autoGainControl: true
          },
          video: false
        });
      } catch (err) {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      }

      if (pushToTalkEnabled) {
        localStream.getAudioTracks().forEach(t => t.enabled = false);
        isMicMuted = true;
      } else {
        isMicMuted = false;
        localStream.getAudioTracks().forEach(t => t.enabled = true);
      }
      updateMuteButtonDisplay();
      return localStream;
    }

    function createGroupPeerConnection(peerSocketId, isInitiator) {
      if (groupPeerConnections.has(peerSocketId)) {
        return groupPeerConnections.get(peerSocketId);
      }

      const pc = new RTCPeerConnection(rtcConfig);
      groupPeerConnections.set(peerSocketId, pc);

      if (localStream) {
        localStream.getTracks().forEach(track => {
          pc.addTrack(track, localStream);
        });
      }

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('group:signal:candidate', {
            toSocketId: peerSocketId,
            candidate: event.candidate
          });
        }
      };

      pc.ontrack = (event) => {
        const remoteStream = event.streams[0];
        groupAudioStreams.set(peerSocketId, remoteStream);

        const container = document.getElementById('groupAudiosContainer');
        let audioEl = document.getElementById('audio_' + peerSocketId);
        if (!audioEl) {
          audioEl = document.createElement('audio');
          audioEl.id = 'audio_' + peerSocketId;
          audioEl.autoplay = true;
          audioEl.playsInline = true;
          container.appendChild(audioEl);
        }
        audioEl.srcObject = remoteStream;
        audioEl.volume = Math.min(1.0, groupMasterVolume / 100);

        attachPeerAnalyser(peerSocketId, remoteStream);
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          cleanupPeerConnection(peerSocketId);
        }
      };

      if (isInitiator) {
        pc.createOffer().then(offer => {
          return pc.setLocalDescription(offer);
        }).then(() => {
          socket.emit('group:signal:offer', {
            toSocketId: peerSocketId,
            offer: pc.localDescription
          });
        }).catch(err => console.error('Error creating group offer:', err));
      }

      return pc;
    }

    function cleanupPeerConnection(peerSocketId) {
      const pc = groupPeerConnections.get(peerSocketId);
      if (pc) {
        pc.close();
        groupPeerConnections.delete(peerSocketId);
      }
      const audioEl = document.getElementById('audio_' + peerSocketId);
      if (audioEl) audioEl.remove();
      groupAudioStreams.delete(peerSocketId);
      groupAnalysers.delete(peerSocketId);
    }

    function attachPeerAnalyser(peerSocketId, stream) {
      try {
        if (!audioContext) {
          audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioContext.state === 'suspended') {
          audioContext.resume();
        }
        const src = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 64;
        src.connect(analyser);
        groupAnalysers.set(peerSocketId, analyser);
      } catch (e) {
        console.warn('Group audio context error:', e);
      }
    }

    function adjustGroupVolume(val) {
      groupMasterVolume = val;
      const valEl = document.getElementById('groupVolumePercentText');
      if (valEl) valEl.textContent = val + '%';
      const container = document.getElementById('groupAudiosContainer');
      if (container) {
        const audios = container.querySelectorAll('audio');
        audios.forEach(a => {
          a.volume = Math.min(1.0, val / 100);
        });
      }
    }

    // AUTO ARRANGE USERS SMALLER IF MANY USERS (UP TO 10)
    function renderGroupGrid() {
      const grid = document.getElementById('groupGrid');
      if (!grid) return;

      const members = Array.from(groupMembers.values());
      const totalCount = members.length;

      // Auto arrange responsive layout classes
      grid.classList.remove('layout-1-2', 'layout-3-4', 'layout-5-6', 'layout-7-8', 'layout-9-10', 'layout-7-10');
      if (totalCount <= 2) {
        grid.classList.add('layout-1-2');
      } else if (totalCount <= 4) {
        grid.classList.add('layout-3-4');
      } else if (totalCount <= 6) {
        grid.classList.add('layout-5-6');
      } else if (totalCount <= 8) {
        grid.classList.add('layout-7-8');
      } else {
        // 9 to 10 users: auto arrange even smaller!
        grid.classList.add('layout-9-10');
      }

      const countText = document.getElementById('groupCountText');
      if (countText) countText.textContent = totalCount + ' / 10 Users';

      grid.innerHTML = members.map(m => {
        const isMe = m.socketId === socket.id;
        const roleLabel = isMe ? 'Local Microphone' : (m.isHost ? 'Group Host' : 'Participant');
        return '<div class="group-member-card" id="groupCard_' + m.socketId + '">' +
          (m.isHost ? '<span class="host-badge">👑 Host</span>' : '') +
          '<div class="participant-avatar" id="groupAvatar_' + m.socketId + '">' + (m.avatar || '🦊') + '</div>' +
          '<div class="participant-name" title="' + m.username + '">' +
            m.username + (isMe ? ' <span style="color:var(--accent); font-size:0.75rem;">(You)</span>' : '') +
          '</div>' +
          '<div class="participant-role">' + roleLabel + '</div>' +
          '<canvas id="groupWave_' + m.socketId + '" class="wave-canvas" width="200" height="30"></canvas>' +
        '</div>';
      }).join('');
    }

    function startGroupVisualizerLoop() {
      if (animationFrameId) cancelAnimationFrame(animationFrameId);

      const freqData = new Uint8Array(32);

      function drawGroupFrame() {
        if (localAnalyser && socket.id) {
          const myCanvas = document.getElementById('groupWave_' + socket.id);
          const myCard = document.getElementById('groupCard_' + socket.id);
          if (myCanvas) {
            const ctx = myCanvas.getContext('2d');
            localAnalyser.getByteFrequencyData(freqData);
            renderWaveBars(ctx, myCanvas, freqData, isMicMuted ? '#ef4444' : '#ff2a5f');
            const avg = freqData.reduce((a, b) => a + b, 0) / freqData.length;
            if (myCard) myCard.classList.toggle('talking', avg > 18 && !isMicMuted);
          }
        }

        for (const [peerSocketId, analyser] of groupAnalysers.entries()) {
          const canvas = document.getElementById('groupWave_' + peerSocketId);
          const card = document.getElementById('groupCard_' + peerSocketId);
          if (canvas && analyser) {
            const ctx = canvas.getContext('2d');
            analyser.getByteFrequencyData(freqData);
            renderWaveBars(ctx, canvas, freqData, '#00f0ff');
            const avg = freqData.reduce((a, b) => a + b, 0) / freqData.length;
            if (card) card.classList.toggle('talking', avg > 15);
          }
        }

        animationFrameId = requestAnimationFrame(drawGroupFrame);
      }

      drawGroupFrame();
    }

    function startGroupCallTimer() {
      stopGroupCallTimer();
      groupCallSeconds = 0;
      const timerEl = document.getElementById('groupCallTimer');
      if (timerEl) timerEl.textContent = '00:00';
      groupCallTimerInterval = setInterval(() => {
        groupCallSeconds++;
        if (timerEl) timerEl.textContent = formatTime(groupCallSeconds);
      }, 1000);
    }

    function stopGroupCallTimer() {
      if (groupCallTimerInterval) {
        clearInterval(groupCallTimerInterval);
        groupCallTimerInterval = null;
      }
    }

    function leaveGroupCall() {
      socket.emit('group:leave');
      cleanupGroupCallLocal();
      showScreen('homeScreen');
    }

    function cleanupGroupCallLocal() {
      stopGroupCallTimer();
      for (const [peerId] of groupPeerConnections.entries()) {
        cleanupPeerConnection(peerId);
      }
      groupPeerConnections.clear();
      groupAudioStreams.clear();
      groupAnalysers.clear();
      groupMembers.clear();
      currentGroupCode = null;
      isGroupHost = false;

      const container = document.getElementById('groupAudiosContainer');
      if (container) container.innerHTML = '';
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
    }

    // -----------------------------------------------------------------
    // SOCKET EVENTS
    // -----------------------------------------------------------------
    socket.on('group:status', ({ code, status, memberCount, message }) => {
      let cssClass = 'status-offline';
      if (status === 'available') cssClass = 'status-online';
      else if (status === 'full' || status === 'not_started') cssClass = 'status-busy';
      showGroupStatus(message, cssClass);
    });

    socket.on('group:error', ({ code, reason, message }) => {
      showGroupStatus(message, 'status-offline');
    });

    socket.on('group:joined_success', async ({ groupCode, isHost, myMember, existingMembers, allMembers }) => {
      currentGroupCode = groupCode;
      isGroupHost = isHost;

      const codeDisplay = document.getElementById('currentGroupCodeDisplay');
      if (codeDisplay) codeDisplay.textContent = groupCode;
      const ptt = document.getElementById('groupPttBanner');
      if (ptt) ptt.classList.toggle('active', pushToTalkEnabled);

      groupMembers.clear();
      allMembers.forEach(m => groupMembers.set(m.socketId, m));

      await ensureLocalMicrophone();
      if (localStream && !localAnalyser) {
        if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (audioContext.state === 'suspended') audioContext.resume();
        const src = audioContext.createMediaStreamSource(localStream);
        localAnalyser = audioContext.createAnalyser();
        localAnalyser.fftSize = 64;
        src.connect(localAnalyser);
      }

      showScreen('groupCallScreen');
      renderGroupGrid();
      startGroupCallTimer();
      startGroupVisualizerLoop();

      existingMembers.forEach(peer => {
        createGroupPeerConnection(peer.socketId, true);
      });
    });

    socket.on('group:member_joined', ({ newMember, totalCount, allMembers }) => {
      groupMembers.set(newMember.socketId, newMember);
      renderGroupGrid();
    });

    socket.on('group:member_left', ({ leftSocketId, totalCount, allMembers }) => {
      cleanupPeerConnection(leftSocketId);
      groupMembers.delete(leftSocketId);
      allMembers.forEach(m => groupMembers.set(m.socketId, m));
      renderGroupGrid();
    });

    socket.on('group:left', () => {
      cleanupGroupCallLocal();
      showScreen('homeScreen');
    });

    socket.on('group:signal:offer', async ({ fromSocketId, offer }) => {
      await ensureLocalMicrophone();
      const pc = createGroupPeerConnection(fromSocketId, false);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('group:signal:answer', {
          toSocketId: fromSocketId,
          answer
        });
      } catch (err) {
        console.error('Error handling group offer:', err);
      }
    });

    socket.on('group:signal:answer', async ({ fromSocketId, answer }) => {
      const pc = groupPeerConnections.get(fromSocketId);
      if (pc) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
        } catch (err) {
          console.error('Error handling group answer:', err);
        }
      }
    });

    socket.on('group:signal:candidate', async ({ fromSocketId, candidate }) => {
      const pc = groupPeerConnections.get(fromSocketId);
      if (pc && candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error('Error adding group ICE candidate:', err);
        }
      }
    });
    socket.on('user:registered', ({ permanentId, groupPermanentId }) => {
      if (permanentId) {
        myPermanentId = permanentId;
        localStorage.setItem('zuki_permanent_id', myPermanentId);
      }
      if (groupPermanentId) {
        myGroupPermanentId = groupPermanentId;
        localStorage.setItem('zuki_group_permanent_id', myGroupPermanentId);
      }
      updateHomeProfileDisplay();
    });

    socket.on('stats:update', ({ onlineCount, inCallCount }) => {
      const counter = document.getElementById('liveCounter');
      if (counter) {
        counter.textContent = onlineCount + ' Online';
      }
    });

    socket.on('direct:status', ({ targetId, status, username, avatar, message }) => {
      let cssClass = 'status-offline';
      if (status === 'online') cssClass = 'status-online';
      else if (status === 'busy' || status === 'self') cssClass = 'status-busy';
      showDirectStatus(message, cssClass);
    });

    socket.on('direct:calling', ({ targetId, targetUsername, targetAvatar, callSessionId }) => {
      currentOutgoingTargetId = targetId;
      document.getElementById('outgoingTargetName').textContent = targetUsername || 'User';
      document.getElementById('outgoingTargetId').textContent = 'ID: ' + targetId;
      document.getElementById('outgoingAvatarIcon').textContent = targetAvatar || '🦊';
      document.getElementById('outgoingCallStatusText').textContent = 'Ringing... Waiting for ' + (targetUsername || targetId) + ' to answer';
      openModal('outgoingCallModal');
      playRingtone(true);
    });

    socket.on('direct:call_failed', ({ reason, message }) => {
      closeModal('outgoingCallModal');
      stopRingtone();
      currentOutgoingTargetId = null;
      showDirectStatus(message || 'Call failed: user unavailable', 'status-offline');
    });

    socket.on('direct:call_declined', ({ message }) => {
      closeModal('outgoingCallModal');
      stopRingtone();
      currentOutgoingTargetId = null;
      showDirectStatus(message || 'User declined your direct call.', 'status-offline');
    });

    socket.on('direct:call_cancelled', () => {
      closeModal('incomingCallModal');
      stopRingtone();
      pendingIncomingCall = null;
    });

    socket.on('direct:incoming_call', ({ callerSocketId, callerId, callerUsername, callerAvatar, callSessionId }) => {
      pendingIncomingCall = { callerSocketId, callerId, callerUsername, callerAvatar, callSessionId };
      document.getElementById('incomingCallerName').textContent = callerUsername || 'Caller';
      document.getElementById('incomingCallerId').textContent = 'Permanent ID: ' + callerId;
      document.getElementById('incomingAvatarIcon').textContent = callerAvatar || '🦊';
      openModal('incomingCallModal');
      playRingtone(false);
    });

    socket.on('match:found', async ({ roomId, isInitiator: initiator, partner }) => {
      stopRingtone();
      closeModal('outgoingCallModal');
      closeModal('incomingCallModal');
      pendingIncomingCall = null;
      currentOutgoingTargetId = null;

      stopSearchTimer();
      currentRoomId = roomId;
      isInitiator = initiator;
      currentPartner = partner;

      // Transition to call screen
      showScreen('callScreen');

      // Update call screen info
      document.getElementById('youName').textContent = myUsername + ' (You)';
      document.getElementById('youAvatar').textContent = myAvatar;
      document.getElementById('strangerName').textContent = partner.username;
      document.getElementById('strangerAvatar').textContent = partner.avatar || '👺';
      document.getElementById('pttBanner').classList.toggle('active', pushToTalkEnabled);

      // Start Call Timer
      startCallTimer();

      // Initialize WebRTC
      try {
        await initWebRtcCall();
      } catch (err) {
        console.error('WebRTC initialization error:', err);
      }
    });

    socket.on('match:cancelled', () => {
      stopSearchTimer();
      showScreen('homeScreen');
    });

    socket.on('signal:offer', async ({ offer }) => {
      if (!peerConnection) return;
      try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('signal:answer', { roomId: currentRoomId, answer });
      } catch (err) {
        console.error('Error handling offer:', err);
      }
    });

    socket.on('signal:answer', async ({ answer }) => {
      if (!peerConnection) return;
      try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      } catch (err) {
        console.error('Error handling answer:', err);
      }
    });

    socket.on('signal:ice-candidate', async ({ candidate }) => {
      if (!peerConnection || !candidate) return;
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error('Error adding ICE candidate:', err);
      }
    });

    // "If stranger ends: you stay in the room to view session info, no auto-kick back to home"
    socket.on('call:ended_by_partner', ({ reason, duration, endedAt }) => {
      handleCallTerminated({
        endedBy: 'Stranger',
        reasonBadge: reason === 'stranger_disconnected' ? '⚠️ Stranger Disconnected' : '🛑 Stranger Left Call',
        headline: reason === 'stranger_disconnected' ? 'Stranger Disconnected' : 'Stranger Ended Call',
        sub: 'The stranger has left the voice room. You can view session info or match again anytime.',
        duration,
        endedAt
      });
    });

    socket.on('call:ended_by_you', ({ duration, endedAt }) => {
      handleCallTerminated({
        endedBy: 'You',
        reasonBadge: '🛑 You Ended Call',
        headline: 'Call Ended',
        sub: 'You hung up the call. You can jump straight back into matchmaking anytime.',
        duration,
        endedAt
      });
    });

    // -----------------------------------------------------------------
    // WEBRTC & AUDIO ENGINE
    // -----------------------------------------------------------------
    async function initWebRtcCall() {
      // 1. Get microphone stream
      const inputDeviceId = document.getElementById('audioInputSelect').value;
      const noiseSuppression = document.getElementById('noiseSuppressionToggle').checked;
      const echoCancellation = document.getElementById('echoCancellationToggle').checked;

      const constraints = {
        audio: {
          deviceId: inputDeviceId ? { exact: inputDeviceId } : undefined,
          echoCancellation,
          noiseSuppression,
          autoGainControl: true
        },
        video: false
      };

      try {
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        console.warn('Microphone permission fallback or error:', err);
        // Retry with default basic audio
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      }

      // If PTT enabled, start muted
      if (pushToTalkEnabled) {
        localStream.getAudioTracks().forEach(t => t.enabled = false);
        isMicMuted = true;
        updateMuteButtonDisplay();
      } else {
        isMicMuted = false;
        localStream.getAudioTracks().forEach(t => t.enabled = true);
        updateMuteButtonDisplay();
      }

      // 2. Setup RTCPeerConnection
      peerConnection = new RTCPeerConnection(rtcConfig);

      // Add local audio track
      localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
      });

      // Handle ICE Candidates
      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('signal:ice-candidate', {
            roomId: currentRoomId,
            candidate: event.candidate
          });
        }
      };

      // Handle Remote Stream
      peerConnection.ontrack = (event) => {
        const remoteAudio = document.getElementById('remoteAudio');
        if (remoteAudio && event.streams[0]) {
          remoteAudio.srcObject = event.streams[0];
          setupVisualizers(localStream, event.streams[0]);
        }
      };

      // If initiator, create and send Offer
      if (isInitiator) {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit('signal:offer', {
          roomId: currentRoomId,
          offer
        });
      }
    }

    // Audio Visualizer with Web Audio API
    function setupVisualizers(localStr, remoteStr) {
      try {
        if (!audioContext) {
          audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioContext.state === 'suspended') {
          audioContext.resume();
        }

        // Local Analyser
        if (localStr) {
          const localSrc = audioContext.createMediaStreamSource(localStr);
          localAnalyser = audioContext.createAnalyser();
          localAnalyser.fftSize = 64;
          localSrc.connect(localAnalyser);
        }

        // Remote Analyser
        if (remoteStr) {
          const remoteSrc = audioContext.createMediaStreamSource(remoteStr);
          remoteAnalyser = audioContext.createAnalyser();
          remoteAnalyser.fftSize = 64;
          remoteSrc.connect(remoteAnalyser);
        }

        startVisualizerLoop();
      } catch (e) {
        console.warn('AudioContext visualizer error:', e);
      }
    }

    function startVisualizerLoop() {
      if (animationFrameId) cancelAnimationFrame(animationFrameId);

      const localCanvas = document.getElementById('localWaveCanvas');
      const remoteCanvas = document.getElementById('remoteWaveCanvas');
      const localCard = document.getElementById('youCard');
      const strangerCard = document.getElementById('strangerCard');

      const localCtx = localCanvas ? localCanvas.getContext('2d') : null;
      const remoteCtx = remoteCanvas ? remoteCanvas.getContext('2d') : null;

      const localData = new Uint8Array(32);
      const remoteData = new Uint8Array(32);

      function draw() {
        // Draw Local
        if (localAnalyser && localCtx && localCanvas) {
          localAnalyser.getByteFrequencyData(localData);
          renderWaveBars(localCtx, localCanvas, localData, isMicMuted ? '#ef4444' : '#ff2a5f');
          // Glow card if voice detected
          const localAvg = localData.reduce((a, b) => a + b, 0) / localData.length;
          if (localCard) localCard.classList.toggle('talking', localAvg > 18 && !isMicMuted);
        }

        // Draw Remote
        if (remoteAnalyser && remoteCtx && remoteCanvas) {
          remoteAnalyser.getByteFrequencyData(remoteData);
          renderWaveBars(remoteCtx, remoteCanvas, remoteData, '#00f0ff');
          const remoteAvg = remoteData.reduce((a, b) => a + b, 0) / remoteData.length;
          if (strangerCard) strangerCard.classList.toggle('talking', remoteAvg > 15);
        }

        animationFrameId = requestAnimationFrame(draw);
      }

      draw();
    }

    function renderWaveBars(ctx, canvas, data, color) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const barWidth = (canvas.width / data.length) * 1.8;
      let x = 4;
      for (let i = 0; i < data.length; i++) {
        const barHeight = Math.max(3, (data[i] / 255) * canvas.height * 0.9);
        const y = (canvas.height - barHeight) / 2;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth - 2, barHeight, 2);
        ctx.fill();
        x += barWidth + 1;
        if (x > canvas.width) break;
      }
    }

    // -----------------------------------------------------------------
    // CONTROLS: MUTE, VOLUME, END CALL
    // -----------------------------------------------------------------
    function toggleMuteMic() {
      if (!localStream) return;
      isMicMuted = !isMicMuted;
      localStream.getAudioTracks().forEach(track => {
        track.enabled = !isMicMuted;
      });
      updateMuteButtonDisplay();
    }

    function updateMuteButtonDisplay() {
      const btn = document.getElementById('muteMicBtn');
      const text = document.getElementById('muteMicText');
      const icon = document.getElementById('muteMicIcon');
      if (!btn || !text || !icon) return;

      if (isMicMuted) {
        btn.classList.add('active-muted');
        text.textContent = 'Unmute Mic';
        icon.innerHTML = '<line x1="2" y1="2" x2="22" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" x2="12" y1="19" y2="22"/>';
      } else {
        btn.classList.remove('active-muted');
        text.textContent = 'Mute Mic';
        icon.innerHTML = '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>';
      }
    }

    function adjustStrangerVolume(val) {
      const audio = document.getElementById('remoteAudio');
      if (audio) {
        audio.volume = Math.min(1.0, val / 100);
      }
      document.getElementById('volumePercentText').textContent = val + '%';
    }

    function endCallAnytime() {
      socket.emit('call:end');
    }

    function handleCallTerminated({ endedBy, reasonBadge, headline, sub, duration, endedAt }) {
      // 1. Clean up local media & peerConnection
      if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
      }
      if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
      }
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
      stopCallTimer();
      stopRingtone();
      closeModal('outgoingCallModal');
      closeModal('incomingCallModal');
      pendingIncomingCall = null;
      currentOutgoingTargetId = null;

      const finalDurationSec = duration || callSeconds;
      const formattedDuration = formatTime(finalDurationSec);
      const partnerName = (currentPartner && currentPartner.username) ? currentPartner.username : 'Stranger';

      // 2. Save session to local Call History
      saveCallToHistory({
        id: 'call_' + Date.now(),
        strangerName: partnerName,
        duration: formattedDuration,
        endedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        endedBy: endedBy
      });

      // 3. Update Summary View
      document.getElementById('summaryEndReasonBadge').textContent = reasonBadge;
      document.getElementById('summaryHeadline').textContent = headline;
      document.getElementById('summarySub').textContent = sub;
      document.getElementById('summaryDurationVal').textContent = formattedDuration;
      document.getElementById('summaryStrangerNameVal').textContent = partnerName;

      // 4. Switch to summary screen (User stays here to view session info)
      showScreen('summaryScreen');
    }

    // -----------------------------------------------------------------
    // MATCHMAKING & RADAR
    // -----------------------------------------------------------------
    function startFindingStranger() {
      if (!myUsername) {
        openModal('usernameModal');
        return;
      }

      isSearching = true;
      showScreen('searchingScreen');
      startSearchTimer();
      socket.emit('match:start');
    }

    function cancelSearch() {
      isSearching = false;
      stopSearchTimer();
      socket.emit('match:cancel');
    }

    function startSearchTimer() {
      searchSeconds = 0;
      document.getElementById('searchTimer').textContent = '00:00';
      const statusEl = document.getElementById('searchStatusText');

      const statusMessages = [
        'Scanning live frequencies for available strangers...',
        'Searching for available online strangers...',
        'Handshaking with online nodes...',
        'Matching with an active real user...',
        'Almost there, connecting audio channels...'
      ];

      searchTimerInterval = setInterval(() => {
        searchSeconds++;
        document.getElementById('searchTimer').textContent = formatTime(searchSeconds);
        const idx = Math.floor(searchSeconds / 3) % statusMessages.length;
        statusEl.textContent = statusMessages[idx];
      }, 1000);
    }

    function stopSearchTimer() {
      if (searchTimerInterval) {
        clearInterval(searchTimerInterval);
        searchTimerInterval = null;
      }
    }

    function startCallTimer() {
      callSeconds = 0;
      document.getElementById('callDurationTimer').textContent = '00:00';
      callTimerInterval = setInterval(() => {
        callSeconds++;
        document.getElementById('callDurationTimer').textContent = formatTime(callSeconds);
      }, 1000);
    }

    function stopCallTimer() {
      if (callTimerInterval) {
        clearInterval(callTimerInterval);
        callTimerInterval = null;
      }
    }

    function formatTime(totalSec) {
      const mins = Math.floor(totalSec / 60);
      const secs = totalSec % 60;
      return (mins < 10 ? '0' : '') + mins + ':' + (secs < 10 ? '0' : '') + secs;
    }

    // -----------------------------------------------------------------
    // PUSH-TO-TALK HANDLING
    // -----------------------------------------------------------------
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && pushToTalkEnabled && !isSpacebarPressed && localStream) {
        // Prevent scrolling if on call screen
        if (document.getElementById('callScreen').classList.contains('active')) {
          e.preventDefault();
        }
        isSpacebarPressed = true;
        localStream.getAudioTracks().forEach(t => t.enabled = true);
        isMicMuted = false;
        updateMuteButtonDisplay();
        const ptt = document.getElementById('pttBanner');
        if (ptt) {
          ptt.classList.add('talking-now');
          ptt.innerHTML = '🎙️ <strong>TRANSMITTING AUDIO NOW...</strong> (Release Space to mute)';
        }
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space' && pushToTalkEnabled && isSpacebarPressed && localStream) {
        isSpacebarPressed = false;
        localStream.getAudioTracks().forEach(t => t.enabled = false);
        isMicMuted = true;
        updateMuteButtonDisplay();
        const ptt = document.getElementById('pttBanner');
        if (ptt) {
          ptt.classList.remove('talking-now');
          ptt.innerHTML = '⌨️ PUSH-TO-TALK ACTIVE: Hold <strong>SPACEBAR</strong> to talk';
        }
      }
    });

    function updatePttPreference(enabled) {
      pushToTalkEnabled = enabled;
      localStorage.setItem('zuki_ptt', enabled ? 'true' : 'false');
      const banner = document.getElementById('pttBanner');
      if (banner) {
        banner.classList.toggle('active', enabled);
      }
    }

    // -----------------------------------------------------------------
    // AUDIO DEVICE ENUMERATION & TEST
    // -----------------------------------------------------------------
    async function refreshAudioDevices() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const inSelect = document.getElementById('audioInputSelect');
        const outSelect = document.getElementById('audioOutputSelect');

        inSelect.innerHTML = '<option value="">Default Microphone</option>';
        outSelect.innerHTML = '<option value="">Default Speaker</option>';

        devices.forEach(dev => {
          if (dev.kind === 'audioinput') {
            const opt = document.createElement('option');
            opt.value = dev.deviceId;
            opt.textContent = dev.label || ('Microphone (' + dev.deviceId.slice(0, 5) + ')');
            inSelect.appendChild(opt);
          } else if (dev.kind === 'audiooutput') {
            const opt = document.createElement('option');
            opt.value = dev.deviceId;
            opt.textContent = dev.label || ('Speaker (' + dev.deviceId.slice(0, 5) + ')');
            outSelect.appendChild(opt);
          }
        });
      } catch (err) {
        console.warn('Could not enumerate audio devices:', err);
      }
    }

    function changeAudioInput(deviceId) {
      if (localStream && peerConnection) {
        navigator.mediaDevices.getUserMedia({
          audio: { deviceId: deviceId ? { exact: deviceId } : undefined }
        }).then(newStream => {
          const newTrack = newStream.getAudioTracks()[0];
          const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'audio');
          if (sender) {
            sender.replaceTrack(newTrack);
          }
          localStream = newStream;
        });
      }
    }

    function changeAudioOutput(deviceId) {
      const audio = document.getElementById('remoteAudio');
      if (audio && typeof audio.setSinkId === 'function' && deviceId) {
        audio.setSinkId(deviceId).catch(e => console.warn('setSinkId error:', e));
      }
    }

    function toggleMicTest() {
      const btn = document.getElementById('testMicBtn');
      const bar = document.getElementById('micTestBar');

      if (testMicStream) {
        // Stop test
        testMicStream.getTracks().forEach(t => t.stop());
        testMicStream = null;
        if (testMicAnimId) cancelAnimationFrame(testMicAnimId);
        btn.textContent = '🎙️ Start Microphone Test';
        bar.style.width = '0%';
        return;
      }

      // Start test
      navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        testMicStream = stream;
        btn.textContent = '⏹️ Stop Microphone Test';
        testMicAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const src = testMicAudioCtx.createMediaStreamSource(stream);
        testMicAnalyser = testMicAudioCtx.createAnalyser();
        testMicAnalyser.fftSize = 64;
        src.connect(testMicAnalyser);

        const data = new Uint8Array(32);
        function checkLevel() {
          testMicAnalyser.getByteFrequencyData(data);
          const avg = data.reduce((a, b) => a + b, 0) / data.length;
          const pct = Math.min(100, Math.round((avg / 120) * 100));
          bar.style.width = pct + '%';
          testMicAnimId = requestAnimationFrame(checkLevel);
        }
        checkLevel();
      }).catch(err => {
        alert('Microphone access denied or unavailable: ' + err.message);
      });
    }

    // -----------------------------------------------------------------
    // THEMES & PROFILE
    // -----------------------------------------------------------------
    function changeTheme(themeName) {
      currentTheme = themeName;
      localStorage.setItem('zuki_theme', themeName);
      applyTheme(themeName);
    }

    function applyTheme(theme) {
      if (theme === 'azuki') {
        document.documentElement.removeAttribute('data-theme');
      } else {
        document.documentElement.setAttribute('data-theme', theme);
      }
    }

    function pickAvatar(icon, el) {
      document.querySelectorAll('.avatar-opt').forEach(opt => opt.classList.remove('selected'));
      el.classList.add('selected');
      myAvatar = icon;
    }

    function randomizeCodename() {
      const prefixes = ['Neon', 'Cyber', 'Shadow', 'Tokyo', 'Akira', 'Ghost', 'Crimson', 'Silent', 'Ronin', 'Kitsune', 'Volt', 'Zen'];
      const suffixes = ['Striker', 'Blade', 'Echo', 'Viper', 'Rider', 'Phantom', 'Wave', 'Pulse', 'Walker', 'Soul', 'Zero', 'Hunter'];
      const num = Math.floor(Math.random() * 90) + 10;
      const randomName = prefixes[Math.floor(Math.random() * prefixes.length)] + '_' + suffixes[Math.floor(Math.random() * suffixes.length)] + num;
      document.getElementById('usernameInput').value = randomName;
    }

    function saveUsernameAndClose() {
      const val = document.getElementById('usernameInput').value.trim();
      if (!val) {
        alert('Please enter a codename.');
        return;
      }
      myUsername = val;
      localStorage.setItem('zuki_username', myUsername);
      localStorage.setItem('zuki_avatar', myAvatar);
      updateHomeProfileDisplay();
      registerUserWithServer();
      closeModal('usernameModal');
    }

    function updateHomeProfileDisplay() {
      const nameEl = document.getElementById('homeUsernamePreview');
      const avatarEl = document.getElementById('homeAvatarPreview');
      const permIdEl = document.getElementById('homePermanentIdPreview');
      const groupPermIdEl = document.getElementById('homeGroupPermanentIdPreview');
      const myGroupCodeBadge = document.getElementById('myGroupCodeBadge');
      const startMyGroupBtnText = document.getElementById('startMyGroupBtnText');

      if (nameEl) nameEl.textContent = myUsername || 'Click to set codename';
      if (avatarEl) avatarEl.textContent = myAvatar;
      if (permIdEl) permIdEl.textContent = myPermanentId || 'ZK-......';
      if (groupPermIdEl) groupPermIdEl.textContent = myGroupPermanentId || '----';
      if (myGroupCodeBadge) myGroupCodeBadge.textContent = myGroupPermanentId || '----';
      if (startMyGroupBtnText) startMyGroupBtnText.textContent = '🔥 Start My Group (' + (myGroupPermanentId || '----') + ')';

      if (document.getElementById('usernameInput')) {
        document.getElementById('usernameInput').value = myUsername;
      }
    }

    // -----------------------------------------------------------------
    // CALL HISTORY
    // -----------------------------------------------------------------
    function saveCallToHistory(callObj) {
      try {
        const existing = JSON.parse(localStorage.getItem('zuki_call_history') || '[]');
        existing.unshift(callObj);
        if (existing.length > 20) existing.pop(); // keep last 20
        localStorage.setItem('zuki_call_history', JSON.stringify(existing));
        renderCallHistory();
      } catch (e) {
        console.warn('History save error:', e);
      }
    }

    function renderCallHistory() {
      const container = document.getElementById('historyListContainer');
      if (!container) return;
      try {
        const history = JSON.parse(localStorage.getItem('zuki_call_history') || '[]');
        if (history.length === 0) {
          container.innerHTML = '<div class="empty-state">No call sessions recorded yet. Start talking to strangers!</div>';
          return;
        }

        container.innerHTML = history.map(item => 
          '<div class="history-card">' +
            '<div>' +
              '<div class="hist-name">🎙️ ' + (item.strangerName || 'Stranger') + '</div>' +
              '<div class="hist-meta">' + (item.endedAt || '') + ' • Duration: ' + (item.duration || '00:00') + '</div>' +
            '</div>' +
            '<div style="font-size:0.75rem; font-weight:700; color: ' + (item.endedBy === 'You' ? '#fca5a5' : '#a7f3d0') + ';">' +
              (item.endedBy === 'You' ? 'Ended by You' : 'Stranger Left') +
            '</div>' +
          '</div>'
        ).join('');
      } catch (e) {
        container.innerHTML = '<div class="empty-state">Error loading history</div>';
      }
    }

    function clearCallHistory() {
      localStorage.removeItem('zuki_call_history');
      renderCallHistory();
    }

    // -----------------------------------------------------------------
    // NAVIGATION & MODALS
    // -----------------------------------------------------------------
    function showScreen(screenId) {
      document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
      const target = document.getElementById(screenId);
      if (target) target.classList.add('active');
    }

    function navigateHome() {
      if (currentRoomId) {
        socket.emit('call:end');
      }
      if (isSearching) {
        cancelSearch();
      }
      showScreen('homeScreen');
    }

    function openModal(id) {
      const modal = document.getElementById(id);
      if (modal) modal.classList.add('active');
    }

    function closeModal(id) {
      const modal = document.getElementById(id);
      if (modal) modal.classList.remove('active');
    }

    // Close on overlay click
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          overlay.classList.remove('active');
        }
      });
    });
  </script>
</body>
</html>`);
});

// -------------------------------------------------------------
// SERVER START
// -------------------------------------------------------------
server.listen(port, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(`🚀 ZUKI VOICE TALK RUNNING AT: http://localhost:${port}`);
  console.log(`⚡ 100% REAL LIVE ONLINE USERS ONLY — NO BOTS EVER`);
  console.log(`✨ made with Azuki ✨`);
  console.log(`======================================================\n`);
});
