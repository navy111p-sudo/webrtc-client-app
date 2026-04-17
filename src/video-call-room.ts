/**
 * video-call-room.ts - Durable Object for multi-user video call
 * Handles: join-room, leave-room, chat-message, whiteboard-draw, whiteboard-clear, pdf-share, pdf-page-change
 * Max 10 users per room
 */

import { WebSocketMessage, ConnectionInfo, PdfShareData } from './types';

const MAX_USERS = 10;

interface RoomUser {
  userId: string;
  username: string;
  isObserver?: boolean;  // 관찰자 모드 (선생님/학생에게 보이지 않음)
}

interface VideoChatRoomState {
  connections: Map<string, ConnectionInfo>;
  users: Map<string, RoomUser>;
  pdfState: PdfShareData | null;
  roomId: string;
}

export class VideoCallRoom {
  private state: DurableObjectState;
  private roomId: string;
  private connections: Map<string, ConnectionInfo> = new Map();
  private users: Map<string, RoomUser> = new Map();
  private pdfState: PdfShareData | null = null;
  private videoState: { url: string; type: string } | null = null;
  private observers: Set<string> = new Set();  // 관찰자 userId 목록

  constructor(state: DurableObjectState) {
    this.state = state;
    this.roomId = '';
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const roomIdParam = url.searchParams.get('roomId');
    if (roomIdParam) this.roomId = roomIdParam;

    // HTTP GET: 방 상태 조회 (관리자용)
    if (request.method === 'GET' && url.pathname === '/status') {
      const normalUsers = Array.from(this.users.values())
        .filter(u => !u.isObserver)
        .map(u => ({ userId: u.userId, username: u.username }));
      const observerCount = this.observers.size;
      return new Response(JSON.stringify({
        roomId: this.roomId,
        userCount: normalUsers.length,
        observerCount,
        users: normalUsers,
        hasPdf: !!this.pdfState,
        hasVideo: !!this.videoState
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request);
    }
    return new Response('Invalid request', { status: 400 });
  }

  private handleWebSocket(request: Request): Response {
    const userId = this.generateUserId();
    const { 0: client, 1: server } = new WebSocketPair();

    server.accept();
    server.addEventListener('message', (event: MessageEvent) => {
      this.onMessage(userId, event.data);
    });
    server.addEventListener('close', () => {
      this.onClose(userId);
    });
    server.addEventListener('error', () => {
      this.onClose(userId);
    });

    this.connections.set(userId, { socketId: userId, roomId: this.roomId, ws: server });

    return new Response(null, { status: 101, webSocket: client });
  }

  private onMessage(userId: string, rawData: string): void {
    try {
      const msg: WebSocketMessage = JSON.parse(rawData);
      const conn = this.connections.get(userId);
      if (!conn) return;

      switch (msg.type) {
        case 'ping':
          // keepalive: 클라이언트 ping에 pong 응답
          this.send(userId, { type: 'pong' });
          return;
        case 'join-room':
          this.handleJoinRoom(userId, msg.data as any);
          break;
        case 'join-observe':
          this.handleJoinObserve(userId, msg.data as any);
          break;
        case 'leave-room':
          this.handleLeaveRoom(userId);
          break;
        case 'chat-message':
          this.handleChatMessage(userId, msg.data as any);
          break;
        case 'whiteboard-draw':
          this.handleWhiteboardDraw(userId, msg.data as any);
          break;
        case 'whiteboard-clear':
          this.handleWhiteboardClear(userId);
          break;
        case 'pdf-share':
          this.handlePdfShare(userId, msg.data as any);
          break;
        case 'pdf-page-change':
          this.handlePdfPageChange(userId, msg.data as any);
          break;
        case 'pdf-stop-share':
          this.handlePdfStopShare(userId);
          break;
        case 'video-share':
          this.handleVideoShare(userId, msg.data as any);
          break;
        case 'video-stop-share':
          this.handleVideoStopShare(userId);
          break;
        case 'offer':
          this.handleOffer(userId, msg.data as any);
          break;
        case 'answer':
          this.handleAnswer(userId, msg.data as any);
          break;
        case 'ice-candidate':
          this.handleIceCandidate(userId, msg.data as any);
          break;
        default:
          console.warn(`Unknown message type: ${msg.type}`);
      }
    } catch (err) {
      console.error('Message parse error:', err);
    }
  }

  private handleJoinRoom(userId: string, data: any): void {
    const { roomId, username } = data;
    if (!username) {
      this.send(userId, { type: 'error-msg', data: { message: 'username required' } });
      return;
    }

    if (this.users.size >= MAX_USERS) {
      this.send(userId, { type: 'room-full', data: { roomId: this.roomId } });
      return;
    }

    const user: RoomUser = { userId, username };
    this.users.set(userId, user);

    // Send room-joined to new user
    this.send(userId, {
      type: 'room-joined',
      data: {
        roomId: this.roomId,
        userId,
        userCount: this.users.size,
        pdfState: this.pdfState
      }
    });

    // Send existing users to new user
    const existingUsers = Array.from(this.users.values())
      .filter(u => u.userId !== userId && !u.isObserver)
      .map(u => ({ userId: u.userId, username: u.username }));

    this.send(userId, {
      type: 'existing-users',
      data: { users: existingUsers, pdfState: this.pdfState }
    });

    // Notify others of new user
    this.broadcast(userId, {
      type: 'user-joined',
      data: { userId, username, userCount: this.users.size }
    });

    // 관찰자들에게도 새 참가자 알림
    for (const obsId of this.observers) {
      if (obsId !== userId) {
        this.send(obsId, {
          type: 'observer-user-joined',
          data: { userId, username }
        });
      }
    }

    // Sync current PDF state if sharing
    if (this.pdfState) {
      this.send(userId, {
        type: 'pdf-sync',
        data: this.pdfState
      });
    }

    // Sync current video state if sharing
    if (this.videoState) {
      this.send(userId, {
        type: 'video-sync',
        data: this.videoState
      });
    }

    // System message (관찰자에게도 채팅은 보여줌 — 모니터링 목적)
    this.broadcastAll({
      type: 'chat-message',
      data: {
        username: '시스템',
        message: `${username}님이 입장했습니다.`,
        timestamp: Date.now(),
        isSystem: true
      }
    });

    console.log(`[VideoChat] User ${username} (${userId}) joined room ${this.roomId}`);
  }

  /** 관찰자 모드 입장: 다른 참가자에게 알리지 않고 조용히 입장 */
  private handleJoinObserve(userId: string, data: any): void {
    const username = data.username || '관찰자';
    this.observers.add(userId);

    const user: RoomUser = { userId, username, isObserver: true };
    this.users.set(userId, user);

    // 관찰자에게 방 정보 전달 (관찰자 모드 표시)
    this.send(userId, {
      type: 'room-joined',
      data: {
        roomId: this.roomId,
        userId,
        userCount: this.getNormalUserCount(),
        isObserver: true
      }
    });

    // 관찰자에게 기존 일반 참가자 목록 전달 (관찰자가 이들의 영상을 받기 위해)
    const normalUsers = Array.from(this.users.values())
      .filter(u => u.userId !== userId && !u.isObserver)
      .map(u => ({ userId: u.userId, username: u.username }));

    this.send(userId, {
      type: 'existing-users',
      data: { users: normalUsers, pdfState: this.pdfState }
    });

    // PDF/비디오 상태 동기화
    if (this.pdfState) {
      this.send(userId, { type: 'pdf-sync', data: this.pdfState });
    }
    if (this.videoState) {
      this.send(userId, { type: 'video-sync', data: this.videoState });
    }

    console.log(`[VideoChat] Observer ${username} (${userId}) entered room ${this.roomId} silently`);
  }

  private handleLeaveRoom(userId: string): void {
    const user = this.users.get(userId);
    if (!user) return;

    const wasObserver = this.observers.has(userId);
    this.observers.delete(userId);
    this.users.delete(userId);
    this.connections.delete(userId);

    // 관찰자가 나가면 아무 알림 없이 조용히 제거
    if (wasObserver) {
      console.log(`[VideoChat] Observer ${user.username} (${userId}) left room ${this.roomId} silently`);
      return;
    }

    // 모든 참가자에게 user-left 알림
    this.broadcastAll({
      type: 'user-left',
      data: { userId, username: user.username, userCount: this.users.size }
    });

    if (user.username) {
      this.broadcastAll({
        type: 'chat-message',
        data: {
          username: '시스템',
          message: `${user.username}님이 퇴장했습니다.`,
          timestamp: Date.now(),
          isSystem: true
        }
      });
    }

    console.log(`[VideoChat] User ${user.username} (${userId}) left room ${this.roomId}`);
  }

  private handleChatMessage(userId: string, data: any): void {
    const user = this.users.get(userId);
    if (!user) return;

    const { message } = data;
    if (!message) return;

    this.broadcastAll({
      type: 'chat-message',
      data: {
        username: user.username,
        message,
        timestamp: Date.now(),
        isSystem: false,
        userId
      }
    });
  }

  private handleWhiteboardDraw(userId: string, data: any): void {
    this.broadcast(userId, {
      type: 'whiteboard-draw',
      data
    });
  }

  private handleWhiteboardClear(userId: string): void {
    this.broadcast(userId, {
      type: 'whiteboard-clear'
    });
  }

  private handlePdfShare(userId: string, data: any): void {
    const { url, currentPage, pdfId } = data;
    if (!url && !pdfId) return;

    // pdfId: 클라이언트가 보낸 값 or URL에서 추출
    const resolvedPdfId = pdfId || (url ? url.replace('/api/video-call/pdf/', '') : '');
    this.pdfState = { url: url || `/api/video-call/pdf/${resolvedPdfId}`, currentPage: currentPage || 1, pdfId: resolvedPdfId, isSharing: true };

    this.broadcast(userId, {
      type: 'pdf-sync',
      data: this.pdfState
    });

    console.log(`[VideoChat] PDF shared in room ${this.roomId}: pdfId=${resolvedPdfId}`);
  }

  private handlePdfPageChange(userId: string, data: any): void {
    const pageNum = data.currentPage || data.pageNum || data;
    if (typeof pageNum !== 'number') return;

    if (this.pdfState) {
      this.pdfState.currentPage = pageNum;
    }

    this.broadcast(userId, {
      type: 'pdf-page-change',
      data: { currentPage: pageNum, pageNum }
    });
  }

  private handlePdfStopShare(userId: string): void {
    this.pdfState = null;

    this.broadcast(userId, {
      type: 'pdf-stop-share'
    });

    console.log(`[VideoChat] PDF sharing stopped in room ${this.roomId}`);
  }

  private handleVideoShare(userId: string, data: any): void {
    const { url, type } = data;
    if (!url) return;
    this.videoState = { url, type: type || 'url' };
    this.broadcast(userId, {
      type: 'video-sync',
      data: this.videoState
    });
    console.log(`[VideoChat] Video shared in room ${this.roomId}: ${url}`);
  }

  private handleVideoStopShare(userId: string): void {
    this.videoState = null;
    this.broadcast(userId, {
      type: 'video-stop-share'
    });
  }

  private handleOffer(userId: string, data: any): void {
    const target = data.targetUserId || data.to;
    const sdp = data.sdp || data.offer;
    if (!target || !sdp) return;
    const fromUser = this.users.get(userId);
    this.sendTo(target, {
      type: 'offer',
      data: { fromUserId: userId, fromUsername: fromUser?.username || '참가자', sdp }
    });
  }

  private handleAnswer(userId: string, data: any): void {
    const target = data.targetUserId || data.to;
    const sdp = data.sdp || data.answer;
    if (!target || !sdp) return;
    this.sendTo(target, {
      type: 'answer',
      data: { fromUserId: userId, sdp }
    });
  }

  private handleIceCandidate(userId: string, data: any): void {
    const target = data.targetUserId || data.to;
    const candidate = data.candidate;
    if (!target || !candidate) return;
    this.sendTo(target, {
      type: 'ice-candidate',
      data: { fromUserId: userId, candidate }
    });
  }

  /** 관찰자를 제외한 일반 참가자 수 */
  private getNormalUserCount(): number {
    let count = 0;
    for (const u of this.users.values()) {
      if (!u.isObserver) count++;
    }
    return count;
  }

  /** 관찰자를 제외한 일반 참가자에게만 브로드캐스트 */
  private broadcastToNormal(excludeId: string, msg: WebSocketMessage): void {
    const jsonMsg = JSON.stringify(msg);
    for (const [id, conn] of this.connections) {
      if (id !== excludeId && !this.observers.has(id) && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(jsonMsg);
      }
    }
  }

  private onClose(userId: string): void {
    const user = this.users.get(userId);
    if (user) {
      this.handleLeaveRoom(userId);
    } else {
      this.connections.delete(userId);
    }
  }

  private send(userId: string, msg: WebSocketMessage): void {
    const conn = this.connections.get(userId);
    if (conn && conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify(msg));
    }
  }

  private sendTo(targetId: string, msg: WebSocketMessage): void {
    const conn = this.connections.get(targetId);
    if (conn && conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify(msg));
    }
  }

  private broadcast(excludeId: string, msg: WebSocketMessage): void {
    const jsonMsg = JSON.stringify(msg);
    for (const [id, conn] of this.connections) {
      if (id !== excludeId && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(jsonMsg);
      }
    }
  }

  private broadcastAll(msg: WebSocketMessage): void {
    const jsonMsg = JSON.stringify(msg);
    for (const [, conn] of this.connections) {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(jsonMsg);
      }
    }
  }

  private generateUserId(): string {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  }
}
