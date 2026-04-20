/**
 * index.ts - Main Worker entry point
 * Handles routing, API endpoints, and WebSocket upgrades
 */

import { SignalingRoom } from './signaling-room';
import { VideoCallRoom } from './video-call-room';
import { HealthResponse, TurnConfigResponse, PdfUploadResponse } from './types';

interface Env {
  SIGNALING_ROOM: DurableObjectNamespace;
  VIDEO_CALL_ROOM: DurableObjectNamespace;
  PDF_STORE: KVNamespace;
  ASSETS: any;
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
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
    }

    // Health check endpoint
    if (path === '/api/health') {
      return handleHealth();
    }

    // TURN/STUN config endpoint
    if (path === '/api/turn-config') {
      return handleTurnConfig();
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

    // WebSocket upgrade for signaling
    if (path.startsWith('/ws/signaling')) {
      return await handleSignalingWebSocket(request, url, env);
    }

    // WebSocket upgrade for video-call
    if (path.startsWith('/ws/video-call')) {
      return await handleVideoCallWebSocket(request, url, env);
    }

    // Static assets (실제 파일 확장자가 있는 요청)
    if (path.match(/\.\w+$/)) {
      return env.ASSETS.fetch(request);
    }

    // SPA 라우팅: API/WS가 아닌 모든 경로에서 index.html 반환
    // (예: /signaling, /video-call 등 → SPA가 클라이언트에서 처리)
    const indexRequest = new Request(new URL('/', request.url).toString(), request);
    return env.ASSETS.fetch(indexRequest);
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

function handleTurnConfig(): Response {
  const response: TurnConfigResponse = {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302'] },
      { urls: ['stun:stun1.l.google.com:19302'] },
      { urls: ['stun:stun2.l.google.com:19302'] },
      { urls: ['stun:stun3.l.google.com:19302'] },
      { urls: ['stun:stun4.l.google.com:19302'] }
    ]
  };
  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
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

    await env.PDF_STORE.put(fileKey, buffer, {
      metadata: {
        originalName,
        uploadedAt: new Date().toISOString(),
        size
      } as any
    });

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
    const list = await env.PDF_STORE.list();
    const pdfs = list.keys.map(key => ({
      filename: key.metadata?.originalName || key.name,
      url: `/api/video-call/pdf/${key.name}`,
      uploadedAt: key.metadata?.uploadedAt || null
    }));

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
    // /api/video-call/pdf/{fileKey} 에서 fileKey 추출
    // path는 URL-인코딩 상태이므로 decodeURIComponent로 원본 키 복원
    const rawKey = path.replace('/api/video-call/pdf/', '');
    const fileKey = decodeURIComponent(rawKey);

    if (!fileKey) {
      return new Response(JSON.stringify({ error: 'No file key provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const pdfData = await env.PDF_STORE.get(fileKey, { type: 'arrayBuffer' });

    if (!pdfData) {
      return new Response(JSON.stringify({ error: 'PDF not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(pdfData, {
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

    // Pass through the request to the Durable Object
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

    // Pass through the request to the Durable Object
    const response = await durableObject.fetch(request);
    return response;
  } catch (err) {
    console.error('VideoCall WebSocket error:', err);
    return new Response('WebSocket connection failed', { status: 500 });
  }
}
