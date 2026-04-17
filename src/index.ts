/**
 * index.ts - Main Worker entry point
 * Handles routing, API endpoints, and WebSocket upgrades
 */

import { SignalingRoom } from './signaling-room';
import { VideoCallRoom } from './video-call-room';
import { HealthResponse, TurnConfigResponse, PdfUploadResponse } from './types';
import { handleMangoApi } from './api-mango';
import { purgeExpired } from './retention';
import { handleLivekit, ensureLivekitSchema } from './livekit-bridge';
import { handleRecordingUpload as handleR2MultipartUpload } from './recordings-r2';

interface Env {
  SIGNALING_ROOM: DurableObjectNamespace;
  VIDEO_CALL_ROOM: DurableObjectNamespace;
  PDF_STORE: KVNamespace;
  SESSION_STATE: KVNamespace;
  DB: D1Database;
  ASSETS: any;
  LIVEKIT_API_KEY?: string;
  LIVEKIT_API_SECRET?: string;
  LIVEKIT_URL?: string;
  // R2: 수업 녹화 파일 저장 (MediaRecorder 업로드 블롭)
  RECORDINGS?: R2Bucket;
  MAX_RECORDING_MB?: string;
  ALLOWED_RECORDING_MIME?: string;
  // Cloudflare TURN 서비스 (선택사항 - 설정하면 동적 TURN 자격증명 생성)
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

export { SignalingRoom, VideoCallRoom };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Room-Id, X-Filename, X-Recording-Id, X-Duration-Ms, X-Size-Bytes'
        }
      });
    }

    // Health check endpoint
    if (path === '/api/health') {
      return handleHealth();
    }

    // TURN/STUN config endpoint
    if (path === '/api/turn-config') {
      return await handleTurnConfig(env);
    }

    // PDF upload endpoint
    if (path === '/api/video-call/upload-pdf' && request.method === 'POST') {
      return await handlePdfUpload(request, env);
    }

    // PDF list endpoint
    if (path === '/api/video-call/pdf-list' && request.method === 'GET') {
      return await handlePdfList(env);
    }

    // PDF download endpoint (SPA에서 PDF.js로 렌더링할 때 사용)
    if (path.startsWith('/api/video-call/pdf/') && request.method === 'GET') {
      return await handlePdfDownload(path, env);
    }

    // 보관기간 자동 파기: 수동 실행/상태 조회
    if (path === '/api/retention/run' && request.method === 'POST') {
      const result = await purgeExpired(env);
      return new Response(JSON.stringify(result), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
    if (path === '/api/retention/status' && request.method === 'GET') {
      const last = await env.SESSION_STATE.get('retention:last_run');
      return new Response(last || 'null', {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    // 활성 방 목록 (관리자용)
    if (path === '/api/active-rooms' && request.method === 'GET') {
      return await handleActiveRooms(env);
    }

    // 특정 방 상태 조회 (관리자용)
    if (path.startsWith('/api/room-status/') && request.method === 'GET') {
      const roomId = path.replace('/api/room-status/', '');
      return await handleRoomStatus(roomId, env);
    }

    // LiveKit 하이브리드 브릿지 (v4)
    if (path.startsWith('/api/livekit')) {
      const res = await handleLivekit(request, url, env as any);
      if (res) return res;
    }

    // R2 녹화 저장소 연결 테스트
    if (path === '/api/recordings/test-r2' && request.method === 'GET') {
      try {
        if (!env.RECORDINGS) return new Response(JSON.stringify({ ok: false, error: 'RECORDINGS bucket not bound' }), { headers: { 'Content-Type': 'application/json' } });
        const testKey = '_test/' + Date.now() + '.txt';
        await env.RECORDINGS.put(testKey, 'test-' + Date.now(), { httpMetadata: { contentType: 'text/plain' } });
        const obj = await env.RECORDINGS.get(testKey);
        const text = obj ? await obj.text() : null;
        await env.RECORDINGS.delete(testKey);
        // 녹화 파일 목록도 확인
        const recList = await env.RECORDINGS.list({ prefix: 'recordings/', limit: 10 });
        return new Response(JSON.stringify({
          ok: true, bucket: 'connected', testWrite: !!text, testContent: text,
          recordingFiles: recList.objects.map(o => ({ key: o.key, size: o.size, uploaded: o.uploaded }))
        }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      } catch (e: any) {
        return new Response(JSON.stringify({ ok: false, error: e?.message }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    // ── 자동녹화 R2 multipart upload + stream (auto-recording-patch) ──
    // 기존 /api/recordings/blob 보다 먼저 매칭해야 함
    if (path.startsWith('/api/recordings/upload') || path.startsWith('/api/recordings/stream')) {
      const res = await handleR2MultipartUpload(request, url, env as any);
      if (res) return res;
    }

    // ── 녹화 완료: blob 업로드 + DB 업데이트를 한 번에 처리 ──
    if (path === '/api/recordings/complete' && request.method === 'POST') {
      return await handleRecordingComplete(request, env);
    }

    // R2 녹화 블롭 저장소 (MediaRecorder → POST /api/recordings/blob/upload)
    // Mango DB API(`/api/recordings`)와 공존하도록 `/blob/` 서브경로 사용
    if (path === '/api/recordings/blob/upload' && request.method === 'POST') {
      return await handleRecordingUpload(request, env);
    }
    if (path === '/api/recordings/blob/list' && request.method === 'GET') {
      return await handleRecordingList(request, env);
    }
    if (path.startsWith('/api/recordings/blob/') && request.method === 'GET') {
      return await handleRecordingDownload(path, request, env);
    }
    if (path.startsWith('/api/recordings/blob/') && request.method === 'DELETE') {
      return await handleRecordingDelete(path, env);
    }

    // v3 명세서 신규 API (출석/보상/카카오/대시보드)
    if (path.startsWith('/api/attendance') ||
        path.startsWith('/api/speaking-time') ||
        path.startsWith('/api/kakao-id') ||
        path.startsWith('/api/emergency') ||
        path.startsWith('/api/reward') ||
        path.startsWith('/api/consents') ||
        path.startsWith('/api/recordings') ||
        path === '/api/dashboard') {
      const res = await handleMangoApi(request, url, env);
      if (res) return res;
    }

    // WebSocket upgrade for signaling
    if (path.startsWith('/ws/signaling')) {
      return await handleSignalingWebSocket(request, url, env);
    }

    // WebSocket upgrade for video-call
    if (path.startsWith('/ws/video-call')) {
      return await handleVideoCallWebSocket(request, url, env);
    }

    // 관리 대시보드 경로
    if (path === '/admin' || path === '/admin/') {
      const adminRequest = new Request(new URL('/admin.html', request.url).toString(), request);
      return env.ASSETS.fetch(adminRequest);
    }

    // Static assets (실제 파일 확장자가 있는 요청)
    if (path.match(/\.\w+$/)) {
      const assetResp = await env.ASSETS.fetch(request);
      // HTML/JS/CSS는 캐시 방지 (항상 최신 버전)
      if (path.match(/\.(html|js|css)$/)) {
        const assetHeaders = new Headers(assetResp.headers);
        assetHeaders.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        return new Response(assetResp.body, { status: assetResp.status, headers: assetHeaders });
      }
      return assetResp;
    }

    // SPA 라우팅: API/WS가 아닌 모든 경로에서 index.html 반환
    // (예: /signaling, /video-call 등 → SPA가 클라이언트에서 처리)
    const indexRequest = new Request(new URL('/', request.url).toString(), request);
    const resp = await env.ASSETS.fetch(indexRequest);
    // HTML 캐시 방지 — 브라우저가 항상 최신 버전을 받도록
    const headers = new Headers(resp.headers);
    headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    headers.set('Pragma', 'no-cache');
    return new Response(resp.body, { status: resp.status, headers });
  },

  // Cron Trigger: 매일 KST 03:00 (UTC 18:00) 보관기간 만료 데이터 자동 파기
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      try {
        const result = await purgeExpired(env);
        console.log('[retention] purged', JSON.stringify(result));
      } catch (err) {
        console.error('[retention] error', err);
      }
    })());
  }
};

async function handleHealth(): Promise<Response> {
  const response: HealthResponse = {
    status: 'ok',
    message: 'WebRTC Unified Platform Worker is running',
    timestamp: Date.now()
  };
  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleTurnConfig(env: Env): Promise<Response> {
  // Cloudflare TURN 키가 설정되어 있으면 동적 자격증명 생성
  if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
    try {
      const cfResp = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.TURN_KEY_API_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ ttl: 86400 }) // 24시간 유효
        }
      );
      if (cfResp.ok) {
        const cfData: any = await cfResp.json();
        // Cloudflare가 반환한 iceServers에 Google STUN도 추가
        const iceServers = [
          { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
          ...(cfData.iceServers || [])
        ];
        return new Response(JSON.stringify({ iceServers }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      console.error('Cloudflare TURN API error:', cfResp.status, await cfResp.text());
    } catch (err) {
      console.error('Cloudflare TURN fetch error:', err);
    }
  }

  // Fallback: 정적 STUN + 공개 TURN 서버들
  const response = {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: ['stun:stun.cloudflare.com:3478'] },
      // 공개 TURN 서버 (폴백)
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
    ]
  };
  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

async function handlePdfUpload(request: Request, env: Env): Promise<Response> {
  try {
    const contentType = request.headers.get('content-type') || '';
    let buffer: ArrayBuffer;
    let originalName: string;
    let mimeType: string;

    if (contentType.includes('multipart/form-data')) {
      // 구형 클라이언트: FormData 업로드
      const formData = await request.formData();
      const file = formData.get('pdf') as File | null;
      if (!file) {
        return new Response(JSON.stringify({ error: 'No file provided' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      mimeType = file.type;
      originalName = file.name;
      buffer = await file.arrayBuffer();
    } else {
      // 신형 클라이언트: raw 바이너리 업로드 (프리뷰 호환)
      const url = new URL(request.url);
      originalName = url.searchParams.get('filename') || 'upload.pdf';
      mimeType = contentType || 'application/pdf';
      buffer = await request.arrayBuffer();
    }

    if (mimeType !== 'application/pdf') {
      return new Response(JSON.stringify({ error: 'Only PDF files are allowed' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const size = buffer.byteLength;
    const maxSize = 50 * 1024 * 1024; // 50MB
    if (size > maxSize) {
      return new Response(JSON.stringify({ error: 'File too large (max 50MB)' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 한글/특수문자 파일명 안전하게 처리: ASCII만 남기고 나머지는 _로 치환
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileKey = `pdf-${Date.now()}-${safeName}`;

    // R2 업로드 (KV는 put 일일한도 1,000회라서 PDF 저장에 부적합)
    const r2 = (env as any).RECORDINGS as R2Bucket | undefined;
    if (r2) {
      await r2.put(`pdfs/${fileKey}`, buffer, {
        httpMetadata: { contentType: 'application/pdf' },
        customMetadata: { originalName, uploadedAt: new Date().toISOString(), size: String(size) }
      });
    } else {
      await env.PDF_STORE.put(fileKey, buffer, {
        metadata: { originalName, uploadedAt: new Date().toISOString(), size } as any
      });
    }

    const response: PdfUploadResponse = {
      success: true,
      filename: originalName,
      url: `/api/video-call/pdf/${fileKey}`
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('PDF upload error:', err);
    return new Response(JSON.stringify({ error: 'Upload failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handlePdfList(env: Env): Promise<Response> {
  try {
    const r2 = (env as any).RECORDINGS as R2Bucket | undefined;
    let pdfs: any[] = [];
    if (r2) {
      const r2List = await r2.list({ prefix: 'pdfs/' });
      pdfs = r2List.objects.map(o => ({
        filename: o.customMetadata?.originalName || o.key.replace('pdfs/', ''),
        url: `/api/video-call/pdf/${o.key.replace('pdfs/', '')}`,
        uploadedAt: o.customMetadata?.uploadedAt || o.uploaded?.toISOString?.() || null
      }));
    }
    const list = await env.PDF_STORE.list();
    const kvPdfs = list.keys.map(key => ({
      filename: (key.metadata as any)?.originalName || key.name,
      url: `/api/video-call/pdf/${key.name}`,
      uploadedAt: (key.metadata as any)?.uploadedAt || null
    }));
    pdfs = [...pdfs, ...kvPdfs];
    // eslint-disable-next-line no-constant-condition
    if (false) {}

    return new Response(JSON.stringify(pdfs), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('PDF list error:', err);
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handlePdfDownload(path: string, env: Env): Promise<Response> {
  try {
    const rawKey = path.replace('/api/video-call/pdf/', '');
    const fileKey = decodeURIComponent(rawKey);

    if (!fileKey) {
      return new Response(JSON.stringify({ error: 'No file key provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // R2 우선 조회, 없으면 기존 KV fallback
    const r2 = (env as any).RECORDINGS as R2Bucket | undefined;
    let bodyStream: ReadableStream<Uint8Array> | null = null;
    let pdfBuffer: ArrayBuffer | null = null;
    if (r2) {
      const obj = await r2.get(`pdfs/${fileKey}`);
      if (obj) bodyStream = obj.body;
    }
    if (!bodyStream) {
      const kv = await env.PDF_STORE.get(fileKey, { type: 'arrayBuffer' });
      if (kv) pdfBuffer = kv;
    }

    if (!bodyStream && !pdfBuffer) {
      return new Response(JSON.stringify({ error: 'PDF not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(bodyStream || pdfBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600'
      }
    });
  } catch (err) {
    console.error('PDF download error:', err);
    return new Response(JSON.stringify({ error: 'Download failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleSignalingWebSocket(request: Request, url: URL, env: Env): Promise<Response> {
  const roomId = url.searchParams.get('roomId') || 'default';

  try {
    const durableObjectId = env.SIGNALING_ROOM.idFromName(roomId);
    const durableObject = env.SIGNALING_ROOM.get(durableObjectId);

    const response = await durableObject.fetch(request);
    return response;
  } catch (err) {
    console.error('Signaling WebSocket error:', err);
    return new Response('WebSocket connection failed', { status: 500 });
  }
}

async function handleVideoCallWebSocket(request: Request, url: URL, env: Env): Promise<Response> {
  const roomId = url.searchParams.get('roomId') || 'default';

  try {
    const durableObjectId = env.VIDEO_CALL_ROOM.idFromName(roomId);
    const durableObject = env.VIDEO_CALL_ROOM.get(durableObjectId);

    const response = await durableObject.fetch(request);

    // 활성 방 목록에 등록 (fire-and-forget — WebSocket 연결을 차단하지 않음)
    env.SESSION_STATE.put(`active-room:${roomId}`, JSON.stringify({
      roomId,
      lastActivity: Date.now()
    }), { expirationTtl: 600 }).catch(() => {});

    return response;
  } catch (err) {
    console.error('VideoCall WebSocket error:', err);
    return new Response('WebSocket connection failed', { status: 500 });
  }
}

async function handleActiveRooms(env: Env): Promise<Response> {
  try {
    // KV에서 active-room: 프리픽스로 활성 방 목록 조회
    const list = await env.SESSION_STATE.list({ prefix: 'active-room:' });
    const rooms: any[] = [];

    for (const key of list.keys) {
      const roomId = key.name.replace('active-room:', '');
      try {
        // 각 Durable Object에 상태 질의
        const durableObjectId = env.VIDEO_CALL_ROOM.idFromName(roomId);
        const durableObject = env.VIDEO_CALL_ROOM.get(durableObjectId);
        const statusUrl = new URL(`https://internal/status?roomId=${roomId}`);
        const statusResp = await durableObject.fetch(statusUrl.toString());
        const status = await statusResp.json() as any;

        // 유저가 0명이면 KV에서 제거
        if (status.userCount === 0) {
          await env.SESSION_STATE.delete(key.name);
          continue;
        }
        rooms.push(status);
      } catch (e) {
        // DO가 이미 사라진 경우 KV 정리
        await env.SESSION_STATE.delete(key.name);
      }
    }

    return new Response(JSON.stringify(rooms), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (err: any) {
    console.error('[active-rooms] error:', err);
    return new Response(JSON.stringify({ error: err?.message || 'Failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleRoomStatus(roomId: string, env: Env): Promise<Response> {
  try {
    const durableObjectId = env.VIDEO_CALL_ROOM.idFromName(roomId);
    const durableObject = env.VIDEO_CALL_ROOM.get(durableObjectId);
    const statusUrl = new URL(`https://internal/status?roomId=${roomId}`);
    const statusResp = await durableObject.fetch(statusUrl.toString());
    const data = await statusResp.text();
    return new Response(data, {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ───────────────────────────────────────────────
// R2 녹화 블롭 저장소 핸들러
// ───────────────────────────────────────────────
function recordingJson(obj: any, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

/**
 * handleRecordingComplete — blob 업로드 + DB 업데이트를 한 번에 처리
 * 메타데이터는 URL 쿼리 파라미터로 전달 (커스텀 헤더 없음)
 *
 * URL: /api/recordings/complete?recording_id=X&room_id=Y&duration_ms=Z
 * Body: 녹화 blob 바이너리
 */
async function handleRecordingComplete(request: Request, env: Env): Promise<Response> {
  const url2 = new URL(request.url);
  const recordingId = url2.searchParams.get('recording_id') || request.headers.get('x-recording-id') || '';
  const roomId = (url2.searchParams.get('room_id') || request.headers.get('x-room-id') || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  const durationMs = parseInt(url2.searchParams.get('duration_ms') || request.headers.get('x-duration-ms') || '0', 10);
  const ts = Date.now();
  const recIdNum = parseInt(recordingId, 10);

  // 디버그: 모든 단계의 결과를 DB에 기록
  const debugLog: string[] = [];
  debugLog.push('START:' + ts);
  debugLog.push('recId:' + recordingId + ',room:' + roomId + ',dur:' + durationMs);
  debugLog.push('hasR2:' + !!env.RECORDINGS + ',hasDB:' + !!env.DB);

  try {
    if (!env.RECORDINGS) {
      debugLog.push('ERR:NO_R2_BUCKET');
      await _saveDebug(env, recIdNum, debugLog, 0);
      return recordingJson({ ok: false, error: 'R2 bucket RECORDINGS not configured' }, 500);
    }

    const contentType = request.headers.get('content-type') || 'video/webm';
    debugLog.push('ct:' + contentType);

    // 1) blob 읽기
    let body: ArrayBuffer;
    try {
      body = await request.arrayBuffer();
      debugLog.push('bodyOK:' + body.byteLength);
    } catch (bodyErr: any) {
      debugLog.push('ERR:BODY:' + String(bodyErr?.message || bodyErr));
      await _saveDebug(env, recIdNum, debugLog, 0);
      return recordingJson({ ok: false, error: 'Body read failed: ' + bodyErr?.message }, 500);
    }

    const sizeBytes = body.byteLength;
    if (sizeBytes === 0) {
      debugLog.push('ERR:EMPTY_BODY');
      await _saveDebug(env, recIdNum, debugLog, 0);
      return recordingJson({ ok: false, error: 'Empty body' }, 400);
    }

    // 2) R2에 저장
    const date = new Date().toISOString().slice(0, 10);
    const key = `recordings/${roomId}/${date}/${ts}.webm`;
    debugLog.push('key:' + key);

    let r2ok = false;
    try {
      await env.RECORDINGS.put(key, body, {
        httpMetadata: { contentType: contentType.split(';')[0].trim() },
        customMetadata: { roomId, recordingId, size: String(sizeBytes) }
      });
      r2ok = true;
      debugLog.push('R2:OK');
    } catch (r2Err: any) {
      debugLog.push('ERR:R2:' + String(r2Err?.message || r2Err));
    }

    const fileUrl = r2ok ? key : ('DEBUG:' + debugLog.join('|'));
    const playUrl = r2ok ? `/api/recordings/blob/${encodeURIComponent(key)}` : '';

    // 3) DB 업데이트 - 항상 실행 (에러 내용도 file_url에 기록)
    if (!isNaN(recIdNum) && recIdNum > 0 && env.DB) {
      try {
        await env.DB.prepare(
          `UPDATE recordings SET ended_at = ?, duration_ms = ?, size_bytes = ?, status = 'completed',
           file_url = ?, storage = ?
           WHERE id = ?`
        ).bind(ts, durationMs, sizeBytes, fileUrl, r2ok ? 'r2' : 'debug', recIdNum).run();
        debugLog.push('DB:OK');
      } catch (dbErr: any) {
        debugLog.push('ERR:DB:' + String(dbErr?.message || dbErr));
      }
    } else {
      debugLog.push('SKIP_DB:recId=' + recordingId);
    }

    return recordingJson({
      ok: r2ok,
      key: r2ok ? key : null,
      url: playUrl,
      recording_id: recordingId,
      size: sizeBytes,
      duration_ms: durationMs,
      debug: debugLog.join('|')
    });
  } catch (err: any) {
    // 최상위 에러도 DB에 기록
    const errMsg = 'FATAL:' + String(err?.message || err);
    if (!isNaN(recIdNum) && recIdNum > 0 && env.DB) {
      try {
        await env.DB.prepare(
          `UPDATE recordings SET file_url = ?, storage = 'debug' WHERE id = ?`
        ).bind(errMsg, recIdNum).run();
      } catch (_) {}
    }
    return recordingJson({ ok: false, error: String(err?.message || err) }, 500);
  }
}

async function _saveDebug(env: Env, recId: number, log: string[], size: number) {
  if (isNaN(recId) || recId <= 0 || !env.DB) return;
  try {
    await env.DB.prepare(
      `UPDATE recordings SET file_url = ?, storage = 'debug', size_bytes = ? WHERE id = ?`
    ).bind('DEBUG:' + log.join('|'), size, recId).run();
  } catch (_) {}
}

async function handleRecordingUpload(request: Request, env: Env): Promise<Response> {
  try {
    if (!env.RECORDINGS) {
      return recordingJson({ error: 'R2 bucket RECORDINGS not configured' }, 500);
    }

    const contentType = request.headers.get('content-type') || 'video/webm';
    const allowed = (env.ALLOWED_RECORDING_MIME || 'video/webm,video/mp4').split(',').map(s => s.trim());
    const baseType = contentType.split(';')[0].trim();
    if (!allowed.includes(baseType)) {
      return recordingJson({ error: `Disallowed mime type: ${baseType}` }, 400);
    }

    const maxMb = parseInt(env.MAX_RECORDING_MB || '500', 10);
    const maxBytes = maxMb * 1024 * 1024;
    const lenHeader = request.headers.get('content-length');
    if (lenHeader && parseInt(lenHeader, 10) > maxBytes) {
      return recordingJson({ error: `File too large (max ${maxMb}MB)` }, 413);
    }

    const roomId = (request.headers.get('x-room-id') || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    const rawName = request.headers.get('x-filename') || `recording-${Date.now()}.webm`;
    const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const date = new Date().toISOString().slice(0, 10);
    const key = `${roomId}/${date}/${Date.now()}-${safeName}`;

    const body = await request.arrayBuffer();
    if (body.byteLength > maxBytes) {
      return recordingJson({ error: `File too large (max ${maxMb}MB)` }, 413);
    }

    await env.RECORDINGS.put(key, body, {
      httpMetadata: { contentType: baseType },
      customMetadata: {
        roomId,
        originalName: rawName,
        uploadedAt: new Date().toISOString(),
        size: String(body.byteLength)
      }
    });

    return recordingJson({
      success: true,
      key,
      url: `/api/recordings/blob/${encodeURIComponent(key)}`,
      size: body.byteLength
    });
  } catch (err: any) {
    console.error('[recording] upload error:', err);
    return recordingJson({ error: err?.message || 'Upload failed' }, 500);
  }
}

async function handleRecordingList(request: Request, env: Env): Promise<Response> {
  try {
    if (!env.RECORDINGS) return recordingJson({ items: [] });
    const url = new URL(request.url);
    const prefix = url.searchParams.get('prefix') || undefined;
    const listed = await env.RECORDINGS.list({ prefix, limit: 1000 });
    const items = listed.objects.map(o => ({
      key: o.key,
      size: o.size,
      uploaded: o.uploaded,
      url: `/api/recordings/blob/${encodeURIComponent(o.key)}`,
      originalName: (o.customMetadata && o.customMetadata.originalName) || o.key.split('/').pop()
    }));
    return recordingJson({ items });
  } catch (err: any) {
    console.error('[recording] list error:', err);
    return recordingJson({ error: err?.message || 'List failed', items: [] }, 500);
  }
}

async function handleRecordingDownload(path: string, request: Request, env: Env): Promise<Response> {
  try {
    if (!env.RECORDINGS) return recordingJson({ error: 'R2 not configured' }, 500);
    const rawKey = path.replace('/api/recordings/blob/', '');
    const key = decodeURIComponent(rawKey);
    if (!key) return recordingJson({ error: 'No key provided' }, 400);

    const rangeHeader = request.headers.get('range');
    let range: { offset: number; length?: number } | undefined;
    if (rangeHeader) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? parseInt(m[2], 10) : undefined;
        range = { offset: start, length: end !== undefined ? (end - start + 1) : undefined };
      }
    }

    const obj = range
      ? await env.RECORDINGS.get(key, { range })
      : await env.RECORDINGS.get(key);

    if (!obj) return recordingJson({ error: 'Not found' }, 404);

    const headers = new Headers();
    headers.set('Content-Type', (obj.httpMetadata && obj.httpMetadata.contentType) || 'video/webm');
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Cache-Control', 'public, max-age=3600');

    if (range && obj.size) {
      const start = range.offset;
      const end = range.length ? (start + range.length - 1) : (obj.size - 1);
      headers.set('Content-Range', `bytes ${start}-${end}/${obj.size}`);
      headers.set('Content-Length', String(end - start + 1));
      return new Response(obj.body, { status: 206, headers });
    }

    if (obj.size) headers.set('Content-Length', String(obj.size));
    return new Response(obj.body, { status: 200, headers });
  } catch (err: any) {
    console.error('[recording] download error:', err);
    return recordingJson({ error: err?.message || 'Download failed' }, 500);
  }
}

async function handleRecordingDelete(path: string, env: Env): Promise<Response> {
  try {
    if (!env.RECORDINGS) return recordingJson({ error: 'R2 not configured' }, 500);
    const rawKey = path.replace('/api/recordings/blob/', '');
    const key = decodeURIComponent(rawKey);
    if (!key) return recordingJson({ error: 'No key provided' }, 400);
    await env.RECORDINGS.delete(key);
    return recordingJson({ success: true, key });
  } catch (err: any) {
    console.error('[recording] delete error:', err);
    return recordingJson({ error: err?.message || 'Delete failed' }, 500);
  }
}
