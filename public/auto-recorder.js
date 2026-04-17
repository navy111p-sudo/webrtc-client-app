/**
 * auto-recorder.js
 * 교사 브라우저에서 자동으로 MediaRecorder를 시작하고 R2로 청크를 스트리밍 업로드합니다.
 *
 * 사용법: 교사용 방 HTML에서 로컬 스트림(getUserMedia 결과)이 준비된 직후 한 번 호출.
 *   import { AutoRecorder } from './auto-recorder.js';
 *   const rec = new AutoRecorder({ stream: localStream, roomId, teacherId, teacherName, participantIds });
 *   await rec.start();     // 방 입장 시
 *   await rec.stop();      // 방 퇴장 시 (beforeunload에 연결)
 *
 * 이유:
 *   - 5초 간격 타임슬라이스 → 네트워크 끊겨도 마지막 5초만 손실
 *   - PUT stream body → Worker에서 R2로 바로 파이프라인, 메모리 점유 최소화
 *   - beforeunload에 sendBeacon(abort) → 비정상 종료 시 R2 orphan multipart 정리
 */
export class AutoRecorder {
  constructor({ stream, roomId, teacherId, teacherName, participantIds = [], participantNames = [], timesliceMs = 5000, mimeType = "video/webm;codecs=vp9,opus" }) {
    this.stream = stream;
    this.roomId = roomId;
    this.teacherId = teacherId;
    this.teacherName = teacherName;
    this.participantIds = participantIds;
    this.participantNames = participantNames;
    this.timesliceMs = timesliceMs;
    this.mimeType = MediaRecorder.isTypeSupported(mimeType) ? mimeType : "video/webm";
    this.recordingId = null;
    this.key = null;
    this.uploadId = null;
    this.parts = [];
    this.partNumber = 0;
    this.totalBytes = 0;
    this.startedAt = 0;
    this.recorder = null;
    this.uploadQueue = Promise.resolve(); // 순서 보장용 직렬 큐
    this._abortHandler = () => this._onUnload();
  }

  async start() {
    // 1) 녹화 메타 생성
    const startRes = await fetch("/api/recordings/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room_id: this.roomId,
        teacher_id: this.teacherId,
        teacher_name: this.teacherName,
        participant_ids: this.participantIds,
        participant_names: this.participantNames,
      }),
    }).then((r) => r.json());
    if (!startRes.ok) throw new Error("recording start failed");
    this.recordingId = startRes.recording_id;

    // 2) R2 multipart 업로드 시작
    const createRes = await fetch("/api/recordings/upload/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recording_id: this.recordingId, room_id: this.roomId }),
    }).then((r) => r.json());
    this.key = createRes.key;
    this.uploadId = createRes.upload_id;

    // 3) MediaRecorder 시작
    this.recorder = new MediaRecorder(this.stream, { mimeType: this.mimeType });
    this.startedAt = Date.now();
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this._enqueuePart(e.data);
    };
    this.recorder.onerror = (e) => console.error("[rec] error", e);
    this.recorder.start(this.timesliceMs);

    window.addEventListener("beforeunload", this._abortHandler);
    console.log("[rec] started", { recordingId: this.recordingId, key: this.key });
    return this.recordingId;
  }

  // 청크를 직렬 큐에 올려 순서대로 업로드 (R2 multipart는 partNumber 순서 무관하지만 네트워크 혼잡 완화)
  _enqueuePart(blob) {
    this.partNumber += 1;
    const pn = this.partNumber;
    this.totalBytes += blob.size;
    this.uploadQueue = this.uploadQueue.then(async () => {
      const url = `/api/recordings/upload/part?key=${encodeURIComponent(this.key)}&upload_id=${encodeURIComponent(this.uploadId)}&part=${pn}`;
      // R2 multipart 최소 파트 크기 5MB 제한이 있지만, 마지막 파트는 예외이므로 5초 청크도 OK
      // 단, 각 청크가 5MB 미만인 경우 complete 시 마지막 파트만 작은 크기 허용됨
      const res = await fetch(url, { method: "PUT", body: blob });
      if (!res.ok) {
        console.error("[rec] part upload failed", pn, res.status);
        return;
      }
      const { etag } = await res.json();
      this.parts.push({ partNumber: pn, etag });
    });
  }

  async stop() {
    if (!this.recorder) return;
    // recorder stop 이벤트까지 기다려서 마지막 dataavailable을 수집
    await new Promise((resolve) => {
      this.recorder.onstop = () => resolve();
      try { this.recorder.stop(); } catch (_) { resolve(); }
    });
    // 큐에 쌓인 업로드가 전부 끝날 때까지 대기
    await this.uploadQueue;

    // complete 호출 (정렬 필수)
    this.parts.sort((a, b) => a.partNumber - b.partNumber);
    const duration = Date.now() - this.startedAt;
    await fetch("/api/recordings/upload/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recording_id: this.recordingId,
        key: this.key,
        upload_id: this.uploadId,
        parts: this.parts,
        duration_ms: duration,
        size_bytes: this.totalBytes,
      }),
    });

    // recordings/stop 메타 업데이트 (기존 API 호환)
    await fetch("/api/recordings/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recording_id: this.recordingId,
        duration_ms: duration,
        size_bytes: this.totalBytes,
      }),
    });

    window.removeEventListener("beforeunload", this._abortHandler);
    console.log("[rec] completed", { recordingId: this.recordingId, sizeMB: (this.totalBytes / 1048576).toFixed(1) });
  }

  _onUnload() {
    // 비동기 abort — sendBeacon으로 보내기 위해 JSON 문자열
    try {
      navigator.sendBeacon(
        "/api/recordings/upload/abort",
        new Blob(
          [JSON.stringify({ recording_id: this.recordingId, key: this.key, upload_id: this.uploadId })],
          { type: "application/json" }
        )
      );
    } catch (_) {}
  }
}
