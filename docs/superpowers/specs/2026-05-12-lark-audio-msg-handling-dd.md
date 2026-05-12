# DD: Lark audio message handling

**Date**: 2026-05-12
**Status**: ✅ LOCKED 2026-05-12 — **D1-1 (不做)** picked by user; complex STT pipeline candidates eliminated

---

## 0. Motivation

User asked 2026-05-12: `如果飞书这边直接发过去的是这个音频消息，能处理吗？` — currently bridge silently drops `msg_type='audio'` events (adapter.ts:225). User-facing failure mode: messages disappear without acknowledgment.

After investigation (§2 below) the user re-framed the question: `服务器支持直接处理语音，但只支持处理文本，这样行不行？` — i.e. **rely on Feishu mobile keyboard's built-in voice-to-text** (system-level STT converts voice to text on the user's device before sending). This makes the bridge audio pipeline unnecessary in 99% of real usage.

This DD records the decision: **do not handle `msg_type='audio'` messages** in the daemon. The bridge stays text-only. Preserve the 尽调 facts in §2 so a future audio-handling reopen has a head start.

---

## 1. 尽调 (real evidence, 2026-05-12)

### 1.1 Feishu audio message payload

`im.message.receive_v1` for `msg_type='audio'`:

```json
{
  "message": {
    "message_type": "audio",
    "content": "{\"file_key\":\"75235e0c-...\",\"duration\":2000}"
  }
}
```

- `file_key` (string) — unique audio identifier
- `duration` (number, **milliseconds**) — audio length
- No format/size limits documented in `message_content` reference

### 1.2 Resource download API

`client.im.v1.messageResource.get({ path: { message_id, file_key }, params: { type: 'audio' } })` returns:
- `getReadableStream(): Readable` — stream the binary
- `writeFile(filePath): Promise<unknown>` — write to disk
- `headers`

Limits per SDK comments:
- 100 MB max file size
- Bot and message must be in the same chat (silent failure if not)
- No support for resources in forwarded messages

### 1.3 Lark built-in STT

`client.speech_to_text.speech.fileRecognize({ data: { speech: { speech | speech_key }, config: { file_id, format, engine_type } } })` returns `{ recognition_text }`. Limits:
- **60s** single recognition cap (longer audio rejected)
- 20 QPS tenant-wide rate limit
- Free for self-built bot in personal/internal tenant (no token cost on top of the existing Lark app)

### 1.4 Anthropic API audio support

[Anthropic Files API](https://platform.claude.com/docs/en/build-with-claude/files) supported types as of 2026-05-12: **PDF, plain text, images (jpeg/png/gif/webp)**. No audio. Cannot feed Lark audio directly to cc.

### 1.5 OpenAI Whisper API

Whisper-1 transcription: ~$0.006/min, 25 MB file size cap, multi-format (mp3/mp4/m4a/wav/webm/etc.), multilingual auto-detect. Adds API key dependency + network IO + per-message cost.

### 1.6 whisper.cpp local

Tiny (75 MB disk / 273 MB RAM) up to Large (2.9 GB / 3.9 GB). Plain C/C++. Native input format = 16-bit WAV; opus/aac needs ffmpeg conversion (Linux only per upstream README, macOS via brew install ffmpeg). Apple Silicon CPU acceptable for tiny/base; medium/large needs GPU for real-time.

---

## 2. Dimensions — candidates considered before lock

### D1 — Approach

| ID | Candidate | First-pass note |
|---|---|---|
| **D1-1** ✅ | **Do not handle audio messages** — rely on user's mobile keyboard voice-to-text | Required candidate per CLAUDE.md. Feishu iOS/Android input bar 🎤 icon = system-level STT, converts voice to text client-side before sending. Daemon sees `msg_type='text'`, existing pipeline routes normally. Zero daemon code change. |
| D1-2 | Inbound audio → STT → text → existing routing pipeline | Daemon receives `msg_type='audio'`, downloads via resource API, transcribes via §1.3-1.6 STT vendor, treats transcript as plain text for routing. |
| D1-3 | Bidirectional: inbound audio + outbound TTS (cc reply → audio) | D1-2 plus a TTS vendor for outbound. Out of scope — no demonstrated need. |

### D2 — STT vendor (only relevant if D1-2)

| ID | Vendor | Speed (30s audio) | Cost | Install | Offline | Language quality |
|---|---|---|---|---|---|---|
| D2-1 | Lark `speech_to_text.speech.fileRecognize` | ~2-5s | Free (in tenant) | None (already in SDK) | No | Native Mandarin |
| D2-2 | OpenAI Whisper API | ~2-4s | $0.006/min | API key | No | Multilingual |
| D2-3 | whisper.cpp local (tiny/base) | ~5-15s on CPU | Free | brew + model 75 MB | Yes | Multilingual, accuracy lower for tiny |
| D2-4 | whisper.cpp local (medium/large) | 10-30s+ on CPU | Free | brew + model 1.5-2.9 GB | Yes | Multilingual, accuracy high |
| D2-5 | Gemini Audio API | ~2-3s | $0.00125/sec | API key | No | Multilingual |
| D2-6 | Deepgram Nova-2 | ~1-2s | $0.0036/min | API key | No | Multilingual |
| D2-7 | Anthropic API direct audio | n/a | n/a | n/a | n/a | **Not supported** — Files API has no audio block type |

### D3 — File handling

| ID | Candidate | Note |
|---|---|---|
| D3-1 | Stream + transcribe in memory | Lark resource API returns a `Readable`; pipe to STT directly. No disk IO. |
| D3-2 | Download to `~/.multi-cc-im/inbox/lark/<sid>/<msg_id>.opus` then transcribe then unlink | Disk-based. Slightly more robust if STT vendor needs file path. Matches conventions.md "v2 voice/image/file → inbox" plan. |

### D4 — Error fallback

| ID | Candidate | Note |
|---|---|---|
| D4-1 | Echo "❌ 音频转写失败: <reason>" with the inbound chatId | Generic STT failure handling. |
| D4-2 | Silent drop + log to daemon stderr | Same as current code's non-text behavior — leaves user wondering. |

### D5 — Post-transcription routing

| ID | Candidate | Note |
|---|---|---|
| D5-1 | Treat transcript as plain text, route through normal pipeline | Simple. Risk: transcription error → wrong cc command. |
| D5-2 | Pre-echo transcript to user for confirmation, then route on `/ok` | Safer but adds friction; user has to wait + reply twice per audio msg. |

### D6 — Pre-acknowledgment (user-added 2026-05-12)

User: `如果是语音分诊的话，需要先给用户回一句"正在进行语音分诊"。不然的话，就感觉好像IM过来的消息断了`.

| ID | Candidate | Note |
|---|---|---|
| D6-1 | No pre-ack | First echo is transcribe+route result. User waits 5-15s seeing nothing. |
| D6-2 | Single-line pre-ack "🎤 正在转写语音..." immediately on receiving audio msg | Fire-and-forget before STT starts; result echo comes after. |
| D6-3 | Progress updates (downloading → transcribing → routing) | Too noisy. Three echoes per audio msg. |

---

## 3. Why D1-1 was picked

User decision 2026-05-12: `还有个问题，可以简单一点吗？服务器支持直接处理语音，但只支持处理文本，这样行不行？`. Interpretation: rely on Feishu mobile keyboard's voice-to-text (system-level), bridge stays text-only.

Concrete reasons traceable to the 尽调 in §1 and matrices in §2:

1. **99% real usage already works via keyboard mic**. Feishu iOS/Android input bar 🎤 icon does system-level STT — bridge sees `msg_type='text'`, no daemon change needed. The actual UX gap is rare (user records audio msg by mistake).
2. **D1-2's downsides are real**:
   - **D2 STT selection** is a multi-vendor decision with no clearly dominant option for personal use (each vendor adds API key / install / network dependency / cost).
   - **D3 file handling** introduces a new `inbox/` directory + lifecycle + cleanup.
   - **D6 pre-ack** complicates the event handler — adapter has to send a message it doesn't know how to send (current `send()` is the only outbound surface, never called from inside the event handler).
   - **Failure modes** multiply: download timeout, STT timeout, STT misrecognition, network glitch, vendor outage. Each one needs a fallback echo.
   - Estimated ~500 LOC + 6 new tests + 2 new docs.
3. **No demonstrated need**. User has DM with keyboard mic working. Audio msg is hypothetical.
4. **CLAUDE.md "Don't add features beyond what task requires"** — explicit rule.

---

## 4. Implementation milestones — **CANCELLED**

D1-1 closes scope. The P-plan below is preserved as historical reference only — what would have been built under D1-2 if reopened.

| ID | Scope (historical, not implemented) |
|---|---|
| ~~P1~~ | ~~adapter event handler: branch on `msg_type === 'audio'`, fire D6-2 pre-ack via `client.im.v1.message.create` direct, download via `messageResource.get` to `inbox/lark/<sid>/<msg_id>.opus`.~~ |
| ~~P2~~ | ~~STT integration with chosen vendor (D2-1 Lark built-in recommended for personal use — already in SDK, free in tenant, native Mandarin).~~ |
| ~~P3~~ | ~~Inject transcript as IncomingMessage.text → existing router pipeline (D5-1).~~ |
| ~~P4~~ | ~~Failure echo (D4-1) for each pipeline stage: download / STT / over-60s.~~ |
| ~~P5~~ | ~~Tests: adapter audio path, STT stub, pre-ack ordering, 60s-cap rejection, failure echoes.~~ |
| ~~P6~~ | ~~Docs: README mention, conventions.md status row, setup-feishu.md (add `speech_to_text:speech` scope).~~ |

---

## 5. What this PR DOES change

Tiny UX fix outside the cancelled milestones: make `msg_type='audio'` echo a friendly hint instead of silent drop.

`packages/im-lark/src/adapter.ts` — before the generic non-text drop, add an audio-specific echo:

```
❌ 暂不支持音频消息，请用键盘 🎤 麦克风转文字后发送
```

Other non-text types (image / file / etc.) still drop silently — out of scope for this DD.

---

## 6. Reopen criteria

This DD reopens with status `🔄 REOPENED` if any of:
- User demonstrates real need for audio msg handling (not hypothetical) — track frequency
- Feishu retires the mobile-keyboard voice-to-text feature
- A future IM adapter (tg) lacks keyboard-mic STT and audio handling becomes the only path
- Anthropic API adds audio support → D2-7 becomes viable → simplifies the pipeline significantly

When reopening: §1 尽调 facts may need re-fetch (Lark / Anthropic APIs change). §2 matrix re-validated against then-current options.

---

## 7. Review log

- **2026-05-12 (a)** — DD drafted after user asked about audio msg handling. Real fetches captured §1 (Lark audio msg shape / resource download / STT API / Anthropic / OpenAI / whisper.cpp). User added D6 pre-ack requirement during draft.
- **2026-05-12 (b)** — User pivoted to simple-path: `服务器支持直接处理语音，但只支持处理文本`. D1-1 locked. P1-P6 cancelled. Single-line UX fix added as §5 (audio echo).
