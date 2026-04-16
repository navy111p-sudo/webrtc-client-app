/**
 * app.js – 메인 진입점: 로비, 탭 전환, WebSocket 연결
 * Native WebSocket 기반 (Socket.IO 대체)
 */
let ws = null;
let localStream = null;
let roomId = null;
let username = null;

const $lobby    = document.getElementById('lobby');
const $app      = document.getElementById('app');
const $joinBtn  = document.getElementById('join-btn');
const $usernameInput = document.getElementById('username-input');
const $roomInput     = document.getElementById('room-input');
const $roomBadge     = document.getElementById('room-badge');
const $userCount     = document.getElementById('user-count');

$joinBtn.addEventListener('click', joinRoom);
$usernameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
$roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });

async function joinRoom() {
  username = $usernameInput.value.trim() || ('사용자' + Math.floor(Math.random() * 1000));
  roomId = $roomInput.value.trim() || generateRoomId();

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    console.warn('미디어 장치 접근 실패:', err.message);
    localStream = new MediaStream();
  }

  document.getElementById('local-video').srcObject = localStream;
  document.getElementById('local-label').textContent = username + ' (나)';

  connectWebSocket();

  $lobby.classList.add('hidden');
  $app.classList.remove('hidden');
  $roomBadge.textContent = '방: ' + roomId;

  initWhiteboard();
  initChat();

  window.addEventListener('resize', () => {
    resizeWhiteboard();
    if (window.currentPdfPage) renderPdfPage(window.currentPdfPage);
  });

  // 방 입장 즉시 자동 녹화 시작
  try {
    if (typeof startRecording === 'function' && localStream && localStream.getTracks().length > 0) {
      const ok = startRecording();
      if (ok) console.log('[auto-record] 녹화 자동 시작');
      else console.warn('[auto-record] 시작 실패');
    }
  } catch (e) { console.warn('[auto-record] 예외:', e); }

  window.addEventListener('beforeunload', () => {
    try { if (typeof isRecording === 'function' && isRecording()) stopRecording(); } catch (_) {}
  });
}

function generateRoomId() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  ws = new WebSocket(protocol + '//' + host + '/ws/video-call?roomId=' + encodeURIComponent(roomId));

  ws.onopen = () => {
    console.log('WebSocket 연결 완료');
    sendWsMessage({ type: 'join-room', data: { roomId, username } });
  };
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleWebSocketMessage(msg);
    } catch (err) { console.error('Message parse error:', err); }
  };
  ws.onerror = () => { console.error('WebSocket 오류'); };
  ws.onclose = () => { console.log('WebSocket 연결 종료'); };
}

function handleWebSocketMessage(msg) {
  const { type, data } = msg;
  switch (type) {
    case 'existing-users': handleExistingUsers(data); break;
    case 'room-joined': handleRoomJoined(data); break;
    case 'user-joined': handleUserJoined(data); break;
    case 'user-left': handleUserLeft(data); break;
    case 'chat-message': handleChatMessageReceived(data); break;
    case 'whiteboard-draw': drawRemote(data); break;
    case 'whiteboard-clear': handleWhiteboardClear(); break;
    case 'pdf-sync': handlePdfSync(data); break;
    case 'pdf-page-change': handlePdfPageChange(data); break;
    case 'pdf-stop-share': stopPdfShare(); break;
    case 'offer': handleOfferMessage(data); break;
    case 'answer': handleAnswerMessage(data); break;
    case 'ice-candidate': handleIceCandidateMessage(data); break;
  }
}

function handleRoomJoined(data) {
  console.log('[app] Room joined:', data.roomId, 'userId:', data.userId, 'userCount:', data.userCount);
  if (data.userCount) { userCount = data.userCount; updateUserCount(); }
}

function handleUserLeft({ userId }) {
  userCount = Math.max(1, userCount - 1);
  updateUserCount();
  const pc = peerConnections.get(userId);
  if (pc) { pc.close(); peerConnections.delete(userId); }
  const el = document.getElementById('video-' + userId);
  if (el) el.remove();
  // 플로팅 비디오도 제거
  if (typeof removeFloatingVideo === 'function') removeFloatingVideo(userId);
}

let userCount = 1;
function updateUserCount() { $userCount.textContent = userCount + '명'; }

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'whiteboard') resizeWhiteboard();
  });
});

document.getElementById('toggle-mic').addEventListener('click', function() {
  const audioTrack = localStream.getAudioTracks()[0];
  if (!audioTrack) return;
  audioTrack.enabled = !audioTrack.enabled;
  this.classList.toggle('active', !audioTrack.enabled);
  this.textContent = audioTrack.enabled ? '🎤' : '🔇';
});
document.getElementById('toggle-cam').addEventListener('click', function() {
  const videoTrack = localStream.getVideoTracks()[0];
  if (!videoTrack) return;
  videoTrack.enabled = !videoTrack.enabled;
  this.classList.toggle('active', !videoTrack.enabled);
  this.textContent = '📷';
});

// 나가기 - 녹화 중지 + 업로드 완료 대기
document.getElementById('leave-btn').addEventListener('click', async () => {
  if (!confirm('통화에서 나가시겠습니까?')) return;
  try {
    if (typeof isRecording === 'function' && isRecording()) {
      console.log('[auto-record] 녹화 중지 및 업로드 중...');
      const result = await stopRecording();
      console.log('[auto-record] 업로드 결과:', result);
    }
  } catch (e) { console.warn('[auto-record] 중지/업로드 예외:', e); }

  localStream.getTracks().forEach(t => t.stop());
  if (ws) ws.close();
  location.href = '/';
});

document.getElementById('toggle-chat').addEventListener('click', () => {
  const panel = document.getElementById('chat-panel');
  panel.classList.toggle('open');
  const badge = document.querySelector('.chat-toggle .badge');
  if (badge) badge.remove();
  const msgs = document.getElementById('chat-messages');
  msgs.scrollTop = msgs.scrollHeight;
});
document.getElementById('close-chat').addEventListener('click', () => {
  document.getElementById('chat-panel').classList.remove('open');
});

function sendWsMessage(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// 스텁 함수: webrtc.js, pdf-viewer.js, chat.js 에서 덮어씌워짐
// 각 모듈이 로드되기 전에 메시지가 올 경우를 대비한 안전장치
function handleChatMessageReceived(data) { console.log('[stub] chat-message (모듈 미로드)'); }
function handlePdfSync(data) { console.log('[stub] pdf-sync (모듈 미로드)'); }
function handlePdfPageChange(data) { console.log('[stub] pdf-page-change (모듈 미로드)'); }
function handleExistingUsers(data) { console.log('[stub] existing-users (모듈 미로드)'); }
function handleUserJoined(data) { console.log('[stub] user-joined (모듈 미로드)'); }
function handleOfferMessage(data) { console.log('[stub] offer (모듈 미로드)'); }
function handleAnswerMessage(data) { console.log('[stub] answer (모듈 미로드)'); }
function handleIceCandidateMessage(data) { console.log('[stub] ice-candidate (모듈 미로드)'); }
