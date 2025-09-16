// online_widget.js
// Must be loaded with <script type="module" src="..."></script>

import * as protobuf from "https://cdn.jsdelivr.net/npm/protobufjs@7/dist/protobuf.min.mjs";

/* Inline protobuf schema (no external frames.proto required) */
const PROTO = `
syntax = "proto3";
package pipecat;

message AudioFrame {
  bytes audio = 1;
  int32 sampleRate = 2;
  int32 numChannels = 3;
}

message Frame {
  AudioFrame audio = 1;
}
`;

// Parse schema synchronously
const parsed = protobuf.parse(PROTO);
const root = parsed.root;
const FrameType = root.lookupType("pipecat.Frame");

/* Web Component definition */
class PipecatWidget extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    // defaults, can be overridden with attribute server-url
    this.SAMPLE_RATE = 16000;
    this.NUM_CHANNELS = 1;
    this.PLAY_TIME_RESET_THRESHOLD_MS = 1.0;

    // State
    this.ws = null;
    this.audioContext = null;
    this.microphoneStream = null;
    this.source = null;
    this.scriptProcessor = null;
    this.playTime = 0;
    this.lastMessageTime = 0;
    this.isPlaying = false;

    // markup
    this.shadowRoot.innerHTML = `
      <style>
        :host { all: initial; font-family: Arial, sans-serif; }
        #widget-icon {
          position: fixed; bottom: 20px; right: 20px;
          width: 50px; height: 50px; background: #4a6bff;
          border-radius: 50%; display:flex; justify-content:center; align-items:center;
          color:white; font-size:24px; cursor:pointer; z-index:999999; box-shadow:0 2px 12px rgba(0,0,0,0.2);
          transition: transform .12s ease;
        }
        #widget-icon:hover { transform: scale(1.08); }
        #widget-container{
          position: fixed; bottom: 20px; right: 20px; width: 360px; z-index:1000000; display: none;
        }
        #widget-header {
          background: #4a6bff; color: white; padding: 10px 12px; border-radius: 10px 10px 0 0;
          display:flex; justify-content:space-between; align-items:center; cursor: move;
        }
        #widget-content {
          background: white; border: 1px solid #ddd; border-top: none; padding: 12px; border-radius: 0 0 10px 10px;
          box-shadow: 0 8px 18px rgba(0,0,0,0.08);
        }
        .status { display:inline-block; width:10px; height:10px; border-radius:50%; background:#ccc; margin-left:8px;}
        .status.connected { background: #4CAF50; box-shadow: 0 0 8px #4CAF50; }
        .btn { padding:8px 12px; border-radius:6px; border:none; cursor:pointer; font-weight:600; }
        .btn-primary { background:#4a6bff; color:white; }
        .btn-danger { background:#f44336; color:white; }
        .btn-plain { background: none; color: white; font-size: 16px; padding: 0 8px; }
        .button-row { display:flex; gap:8px; margin-top:10px; }
        .hidden { display:none !important; }
      </style>

      <div id="widget-icon" title="Open Pipecat">🤖</div>

      <div id="widget-container">
        <div id="widget-header">
          <div><strong>Pipecat</strong> <span id="status" class="status"></span></div>
          <div>
            <button id="minimizeBtn" class="btn-plain">−</button>
            <button id="closeBtn" class="btn-plain">×</button>
          </div>
        </div>
        <div id="widget-content">
          <div id="progressText">Loading widget...</div>
          <div class="button-row">
            <button id="startBtn" class="btn btn-primary" disabled>Start</button>
            <button id="stopBtn" class="btn btn-danger" disabled>Stop</button>
          </div>
          <div style="margin-top:8px; font-size:12px; color:#666;">
            Provide server endpoint as attribute: <code>server-url</code>
          </div>
        </div>
      </div>
    `;

    // elements
    this.icon = this.shadowRoot.querySelector("#widget-icon");
    this.container = this.shadowRoot.querySelector("#widget-container");
    this.startBtn = this.shadowRoot.querySelector("#startBtn");
    this.stopBtn = this.shadowRoot.querySelector("#stopBtn");
    this.closeBtn = this.shadowRoot.querySelector("#closeBtn");
    this.minimizeBtn = this.shadowRoot.querySelector("#minimizeBtn");
    this.progressText = this.shadowRoot.querySelector("#progressText");
    this.statusEl = this.shadowRoot.querySelector("#status");

    // dragging
    this._drag = { active: false, offsetX: 0, offsetY: 0 };
  }

  // observe server-url attribute so pages can set it after loading
  static get observedAttributes() { return ["server-url"]; }

  attributeChangedCallback(name, oldVal, newVal) {
    if (name === "server-url" && oldVal !== newVal) {
      // If connected, reconnect to new URL
      if (this.ws) {
        try { this.ws.close(); } catch(e) {}
        this.ws = null;
      }
      // no auto-reconnect here; user clicks Start to connect to new URL
      this.progressText.textContent = `Server set to ${newVal}. Click Start to connect.`;
    }
  }

  connectedCallback() {
    // UI behavior
    this.icon.addEventListener("click", () => {
      this.container.style.display = "block";
      this.icon.style.display = "none";
    });
    this.closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.container.style.display = "none";
      this.icon.style.display = "flex";
    });
    this.minimizeBtn.addEventListener("click", () => {
      const content = this.shadowRoot.querySelector("#widget-content");
      content.classList.toggle("hidden");
      this.minimizeBtn.textContent = content.classList.contains("hidden") ? "+" : "−";
    });

    // simple draggable
    const header = this.shadowRoot.querySelector("#widget-header");
    header.addEventListener("mousedown", (e) => {
      this._drag.active = true;
      const rect = this.container.getBoundingClientRect();
      this._drag.offsetX = e.clientX - rect.left;
      this._drag.offsetY = e.clientY - rect.top;
      this.container.style.right = "auto";
      this.container.style.bottom = "auto";
    });
    document.addEventListener("mousemove", (e) => {
      if (!this._drag.active) return;
      this.container.style.left = (e.clientX - this._drag.offsetX) + "px";
      this.container.style.top = (e.clientY - this._drag.offsetY) + "px";
    });
    document.addEventListener("mouseup", () => this._drag.active = false);

    // Start/Stop handlers
    this.startBtn.addEventListener("click", () => this._onStart());
    this.stopBtn.addEventListener("click", () => this._onStop());

    // ready to use
    this.progressText.textContent = "Ready — set server-url and click Start";
    this.startBtn.disabled = false;
  }

  disconnectedCallback() {
    this._cleanupAudio();
    if (this.ws) { try { this.ws.close(); } catch(e) {} }
  }

  // convenience getter for server URL
  get serverUrl() {
    return this.getAttribute("server-url") || "ws://localhost:8765";
  }

  /* START */
  async _onStart() {
    if (!("mediaDevices" in navigator && navigator.mediaDevices.getUserMedia)) {
      alert("getUserMedia not supported in this browser");
      return;
    }

    // UI state
    this.startBtn.disabled = true;
    this.stopBtn.disabled = false;
    this.progressText.textContent = `Connecting to ${this.serverUrl}...`;

    // create audioContext (try to set sampleRate; browser may ignore)
    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: this.SAMPLE_RATE });
    } catch (e) {
      // fallback
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    // open WS
    try {
      this.ws = new WebSocket(this.serverUrl);
      this.ws.binaryType = "arraybuffer";
    } catch (e) {
      this.progressText.textContent = "WebSocket creation failed: " + e.message;
      this.startBtn.disabled = false;
      return;
    }

    this.ws.onopen = async () => {
      this.progressText.textContent = "Connected — capturing microphone...";
      this.statusEl.classList.add("connected");

      // start mic
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: this.NUM_CHANNELS } });
        this.microphoneStream = stream;

        // ScriptProcessor is deprecated but still widely supported; AudioWorklet is better for production
        const bufferSize = 512; // lower = lower latency
        this.scriptProcessor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
        this.source = this.audioContext.createMediaStreamSource(stream);
        this.source.connect(this.scriptProcessor);
        this.scriptProcessor.connect(this.audioContext.destination);

        this.scriptProcessor.onaudioprocess = (event) => {
          if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
          const input = event.inputBuffer.getChannelData(0);
          const int16 = this._floatTo16BitPCM(input);
          const bytes = new Uint8Array(int16.buffer);

          // Build protobuf Frame
          const framePayload = {
            audio: {
              audio: bytes,
              sampleRate: this.SAMPLE_RATE,
              numChannels: this.NUM_CHANNELS
            }
          };

          // create and encode (FrameType expects an object where 'audio' has bytes)
          const created = FrameType.create(framePayload);
          const encoded = FrameType.encode(created).finish(); // Uint8Array
          try {
            this.ws.send(encoded);
          } catch (e) {
            console.warn("WS send error:", e);
          }
        };

        this.isPlaying = true;
        this.progressText.textContent = "Microphone streaming. Waiting for bot audio...";
      } catch (err) {
        console.error("getUserMedia error:", err);
        this.progressText.textContent = "Microphone access denied or unavailable.";
        this._cleanupAudio();
      }
    };

    this.ws.onmessage = (ev) => {
      // incoming audio frames (server must send the same protobuf Frame with encoded audio bytes, e.g. WAV or MP3 bytes)
      if (!this.isPlaying) return;
      const ab = ev.data;
      this._handleIncomingFrame(ab);
    };

    this.ws.onclose = () => {
      this.progressText.textContent = "Disconnected from server.";
      this.statusEl.classList.remove("connected");
      this.startBtn.disabled = false;
      this.stopBtn.disabled = true;
      this._cleanupAudio();
    };

    this.ws.onerror = (e) => {
      console.error("WebSocket error:", e);
      this.progressText.textContent = "WebSocket error (check console)";
    };
  }

  /* STOP */
  _onStop() {
    this._cleanupAudio();
    if (this.ws) {
      try { this.ws.close(); } catch(e) {}
      this.ws = null;
    }
    this.progressText.textContent = "Stopped.";
    this.startBtn.disabled = false;
    this.stopBtn.disabled = true;
    this.statusEl.classList.remove("connected");
    this.isPlaying = false;
  }

  _cleanupAudio() {
    try {
      if (this.scriptProcessor) { this.scriptProcessor.disconnect(); this.scriptProcessor.onaudioprocess = null; }
      if (this.source) { this.source.disconnect(); }
      if (this.microphoneStream) {
        this.microphoneStream.getTracks().forEach(t => t.stop());
        this.microphoneStream = null;
      }
    } catch (e) {
      console.warn("cleanup error", e);
    }
  }

  /* Handle incoming protobuf frame (expects 'Frame' with audio field bytes that are playable like WAV/MP3) */
  async _handleIncomingFrame(arrayBuffer) {
    try {
      const parsed = FrameType.decode(new Uint8Array(arrayBuffer));
      if (!parsed?.audio) return;

      // server should send encoded audio (wav/mp3) bytes inside the `audio.audio` field
      const audioBytes = parsed.audio.audio instanceof Uint8Array ? parsed.audio.audio : new Uint8Array(parsed.audio.audio);

      // Reset playTime after pause
      const diffTime = this.audioContext.currentTime - this.lastMessageTime;
      if (this.playTime === 0 || diffTime > this.PLAY_TIME_RESET_THRESHOLD_MS) {
        this.playTime = this.audioContext.currentTime;
      }
      this.lastMessageTime = this.audioContext.currentTime;

      // Decode audio bytes (expects a valid audio container like WAV/MP3)
      try {
        const decoded = await this.audioContext.decodeAudioData(audioBytes.buffer.slice(0));
        const src = this.audioContext.createBufferSource();
        src.buffer = decoded;
        src.connect(this.audioContext.destination);
        src.start(this.playTime);
        this.playTime += decoded.duration;
      } catch (err) {
        console.error("decodeAudioData failed:", err);
      }
    } catch (err) {
      console.error("Failed to decode incoming proto frame:", err);
    }
  }

  /* helper: float32 -> Int16 */
  _floatTo16BitPCM(float32Array) {
    const l = float32Array.length;
    const int16 = new Int16Array(l);
    for (let i = 0; i < l; i++) {
      let s = Math.max(-1, Math.min(1, float32Array[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return int16;
  }
}

customElements.define("pipecat-widget", PipecatWidget);
