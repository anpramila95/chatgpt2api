/**
 * chatgpt-image-proxy.js
 *
 * Rewrite từ Python openai_backend_api.py — proxy tạo ảnh thẳng qua ChatGPT Web
 * KHÔNG dùng OpenAI API, hoàn toàn giống flow proxy hiện tại trong Python.
 *
 * Yêu cầu:
 *   node >= 18  (native fetch)
 *   npm install js-sha3
 *
 * Chạy:
 *   CHATGPT_ACCESS_TOKEN=eyJhb... node chatgpt-image-proxy.js
 */

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { sha3_512 } = require("js-sha3");

// ─── Constants ───────────────────────────────────────────────────────────────

const BASE_URL = "https://chatgpt.com";
const DEFAULT_POW_SCRIPT = "https://chatgpt.com/backend-api/sentinel/sdk.js";
const CLIENT_VERSION = "prod-be885abbfcfe7b1f511e88b3003d9ee44757fbad";
const CLIENT_BUILD = "5955942";

const CORES = [8, 16, 24, 32];
const NAVIGATOR_KEYS = [
  "registerProtocolHandler−function registerProtocolHandler() { [native code] }",
  "storage−[object StorageManager]",
  "cookieEnabled−true",
  "onLine−true",
  "hardwareConcurrency−32",
  "language−zh-CN",
  "userAgentData−[object NavigatorUAData]",
  "webdriver−false",
];
const WINDOW_KEYS = [
  "0", "window", "self", "document", "name", "location",
  "innerWidth", "innerHeight", "devicePixelRatio",
  "__NEXT_DATA__", "__BUILD_MANIFEST",
];
const DOCUMENT_KEYS = ["_reactListeningo743lnnpvdg", "location"];

// ─── Pure helper functions ────────────────────────────────────────────────────

function newUuid() {
  return crypto.randomUUID();
}

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** EST time string — mirrors _legacy_parse_time() in Python */
function legacyParseTime() {
  const now = new Date(Date.now() - 5 * 3600 * 1000);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const d = days[now.getUTCDay()];
  const mon = months[now.getUTCMonth()];
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const yyyy = now.getUTCFullYear();
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  return `${d} ${mon} ${dd} ${yyyy} ${hh}:${mm}:${ss} GMT-0500 (Eastern Standard Time)`;
}

/**
 * Build PoW config array — mirrors build_pow_config() in Python
 * @param {string} userAgent
 * @param {string[]} scriptSources
 * @param {string} dataBuild
 * @returns {unknown[]}
 */
function buildPowConfig(userAgent, scriptSources, dataBuild) {
  const sources = scriptSources && scriptSources.length ? scriptSources : [DEFAULT_POW_SCRIPT];
  return [
    randomChoice([3000, 4000, 5000]),
    legacyParseTime(),
    4294705152,
    0,
    userAgent,
    randomChoice(sources),
    dataBuild,
    "en-US",
    "en-US,es-US,en,es",
    0,
    randomChoice(NAVIGATOR_KEYS),
    randomChoice(DOCUMENT_KEYS),
    randomChoice(WINDOW_KEYS),
    performance.now(),
    newUuid(),
    "",
    randomChoice(CORES),
    Date.now() - performance.now(),
  ];
}

/**
 * SHA3-512 PoW mining — mirrors _pow_generate() in Python
 * @param {string} seed
 * @param {string} difficulty  hex string e.g. "0fffff"
 * @param {unknown[]} config
 * @param {number} limit
 * @returns {{ answer: string, solved: boolean }}
 */
function powGenerate(seed, difficulty, config, limit = 500_000) {
  const target = Buffer.from(difficulty, "hex");
  const diffLen = difficulty.length / 2;
  const seedBytes = Buffer.from(seed);

  const part1 = JSON.stringify(config.slice(0, 3)).slice(0, -1) + ",";
  const part2 = "," + JSON.stringify(config.slice(4, 9)).slice(1, -1) + ",";
  const part3 = "," + JSON.stringify(config.slice(10)).slice(1);

  for (let i = 0; i < limit; i++) {
    const finalJson = part1 + String(i) + part2 + String(i >> 1) + part3;
    const encoded = Buffer.from(finalJson).toString("base64");
    const digest = Buffer.from(
      sha3_512.arrayBuffer(Buffer.concat([seedBytes, Buffer.from(encoded)]))
    );
    if (digest.slice(0, diffLen).compare(target) <= 0) {
      return { answer: encoded, solved: true };
    }
  }
  const fallback =
    "wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D" +
    Buffer.from(`"${seed}"`).toString("base64");
  return { answer: fallback, solved: false };
}

/**
 * Build legacy requirements token — mirrors build_legacy_requirements_token()
 * @param {string} userAgent
 * @param {string[]} scriptSources
 * @param {string} dataBuild
 * @returns {string}
 */
function buildLegacyRequirementsToken(userAgent, scriptSources, dataBuild) {
  const seed = String(Math.random());
  const config = buildPowConfig(userAgent, scriptSources, dataBuild);
  const { answer } = powGenerate(seed, "0fffff", config);
  return "gAAAAAC" + answer;
}

/**
 * Build proof token — mirrors build_proof_token()
 * @param {string} seed
 * @param {string} difficulty
 * @param {string} userAgent
 * @param {string[]} scriptSources
 * @param {string} dataBuild
 * @returns {string}
 */
function buildProofToken(seed, difficulty, userAgent, scriptSources, dataBuild) {
  const config = buildPowConfig(userAgent, scriptSources, dataBuild);
  const { answer, solved } = powGenerate(seed, difficulty, config);
  if (!solved) throw new Error(`Failed to solve PoW: difficulty=${difficulty}`);
  return "gAAAAAB" + answer;
}

/**
 * Parse PoW resources from chatgpt.com HTML — mirrors parse_pow_resources()
 * @param {string} html
 * @returns {{ scriptSources: string[], dataBuild: string }}
 */
function parsePowResources(html) {
  const scriptSources = [];
  let dataBuild = "";
  const scriptRe = /<script[^>]+src="([^"]+)"/g;
  let m;
  while ((m = scriptRe.exec(html)) !== null) {
    scriptSources.push(m[1]);
    const buildMatch = /c\/[^/]*\/_/.exec(m[1]);
    if (buildMatch) dataBuild = buildMatch[0];
  }
  if (!dataBuild) {
    const htmlBuild = /<html[^>]*data-build="([^"]*)"/.exec(html);
    if (htmlBuild) dataBuild = htmlBuild[1];
  }
  return { scriptSources, dataBuild };
}

/**
 * Get basic image dimensions without external library — reads PNG/JPEG/WebP header bytes.
 * @param {Buffer} buf
 * @returns {{ width: number, height: number, mimeType: string }}
 */
function getImageDimensions(buf) {
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
      mimeType: "image/png",
    };
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 8) {
      if (buf[i] !== 0xff) break;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker === 0xc0 || marker === 0xc2) {
        return {
          width: buf.readUInt16BE(i + 7),
          height: buf.readUInt16BE(i + 5),
          mimeType: "image/jpeg",
        };
      }
      i += 2 + len;
    }
  }
  // WebP
  if (buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") {
    if (buf.slice(12, 16).toString() === "VP8 ") {
      return {
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff,
        mimeType: "image/webp",
      };
    }
  }
  return { width: 512, height: 512, mimeType: "image/png" };
}

/**
 * Map user-facing model name to internal ChatGPT slug — mirrors _image_model_slug()
 * @param {string} model
 * @returns {string}
 */
function mapImageModelSlug(model) {
  const m = String(model || "").trim();
  if (!m) return "auto";
  if (["gpt-image-1", "gpt-image-2", "gpt-image"].includes(m)) return "gpt-5-3";
  return "auto";
}

/**
 * Build final prompt with aspect-ratio hint — mirrors _build_image_prompt()
 * @param {string} prompt
 * @param {string} size
 * @returns {string}
 */
function buildImagePrompt(prompt, size) {
  if (!size) return prompt;
  const hints = {
    "1:1": "输出为 1:1 正方形构图，主体居中，适合正方形画幅。",
    "16:9": "输出为 16:9 横屏构图，适合宽画幅展示。",
    "9:16": "输出为 9:16 竖屏构图，适合竖版画幅展示。",
  };
  const hint = hints[size];
  if (hint) return `${prompt.trim()}\n\n${hint}`;
  return `${prompt.trim()}\n\n输出图片，宽高比为 ${size}。`;
}

/**
 * Save image bytes to disk — mirrors _save_image_bytes()
 * @param {Buffer} bytes
 * @param {string} [saveDir]
 * @returns {string} absolute file path
 */
function saveImageBytes(bytes, saveDir) {
  const dir = saveDir || "./output";
  const now = new Date();
  const datePart = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("/");
  const fullDir = path.join(dir, datePart);
  fs.mkdirSync(fullDir, { recursive: true });
  const hash = crypto.createHash("md5").update(bytes).digest("hex").slice(0, 8);
  const fileName = `${Date.now()}_${hash}.png`;
  const filePath = path.join(fullDir, fileName);
  fs.writeFileSync(filePath, bytes);
  return path.resolve(filePath);
}

// ─── Main proxy class ─────────────────────────────────────────────────────────

class ChatGPTImageProxy {
  /**
   * @param {string} accessToken  ChatGPT access token (JWT)
   */
  constructor(accessToken) {
    if (!accessToken) throw new Error("access_token is required for image generation");
    this.accessToken = accessToken;
    this.baseUrl = BASE_URL;
    this.userAgent =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";
    this.deviceId = newUuid();
    this.sessionId = newUuid();
    this.powScriptSources = [DEFAULT_POW_SCRIPT];
    this.powDataBuild = "";
  }

  // ── Low-level headers ──────────────────────────────────────────────────────

  _baseHeaders() {
    return {
      "User-Agent": this.userAgent,
      "Origin": this.baseUrl,
      "Referer": this.baseUrl + "/",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "Sec-Ch-Ua": '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "OAI-Device-Id": this.deviceId,
      "OAI-Session-Id": this.sessionId,
      "OAI-Language": "zh-CN",
      "OAI-Client-Version": CLIENT_VERSION,
      "OAI-Client-Build-Number": CLIENT_BUILD,
      "Authorization": `Bearer ${this.accessToken}`,
    };
  }

  _headers(targetPath, extra) {
    return Object.assign({}, this._baseHeaders(), {
      "X-OpenAI-Target-Path": targetPath,
      "X-OpenAI-Target-Route": targetPath,
    }, extra || {});
  }

  _imageHeaders(targetPath, requirements, conduitToken, accept) {
    accept = accept || "*/*";
    const h = {
      "Content-Type": "application/json",
      "Accept": accept,
      "OpenAI-Sentinel-Chat-Requirements-Token": requirements.token,
    };
    if (requirements.proofToken) h["OpenAI-Sentinel-Proof-Token"] = requirements.proofToken;
    if (conduitToken) h["X-Conduit-Token"] = conduitToken;
    if (accept === "text/event-stream") h["X-Oai-Turn-Trace-Id"] = newUuid();
    return this._headers(targetPath, h);
  }

  // ── Step 1: Bootstrap (fetch chatgpt.com, get PoW scripts) ────────────────

  async bootstrap() {
    const res = await fetch(this.baseUrl + "/", {
      headers: {
        "User-Agent": this.userAgent,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Sec-Ch-Ua": '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Upgrade-Insecure-Requests": "1",
      },
    });
    if (!res.ok) throw new Error(`bootstrap failed: ${res.status}`);
    const html = await res.text();
    const { scriptSources, dataBuild } = parsePowResources(html);
    this.powScriptSources = scriptSources.length ? scriptSources : [DEFAULT_POW_SCRIPT];
    this.powDataBuild = dataBuild;
  }

  // ── Step 2: Get sentinel chat-requirements ─────────────────────────────────

  /**
   * @returns {Promise<{ token: string, proofToken: string, turnstileToken: string, soToken: string }>}
   */
  async getChatRequirements() {
    const p = buildLegacyRequirementsToken(this.userAgent, this.powScriptSources, this.powDataBuild);
    const reqPath = "/backend-api/sentinel/chat-requirements";
    const res = await fetch(this.baseUrl + reqPath, {
      method: "POST",
      headers: this._headers(reqPath, { "Content-Type": "application/json" }),
      body: JSON.stringify({ p }),
    });
    if (!res.ok) throw new Error(`chat-requirements failed: ${res.status} ${await res.text()}`);
    const data = await res.json();

    if (data.arkose && data.arkose.required) {
      throw new Error("arkose token required — not supported");
    }

    let proofToken = "";
    const proofInfo = data.proofofwork || {};
    if (proofInfo.required) {
      proofToken = buildProofToken(
        String(proofInfo.seed || ""),
        String(proofInfo.difficulty || ""),
        this.userAgent,
        this.powScriptSources,
        this.powDataBuild,
      );
    }

    const token = String(data.token || "");
    if (!token) throw new Error(`missing chat-requirements token: ${JSON.stringify(data)}`);

    return {
      token,
      proofToken,
      turnstileToken: "",
      soToken: String(data.so_token || ""),
    };
  }

  // ── Step 3: Prepare conversation (get conduit_token) ──────────────────────

  /**
   * @param {string} prompt
   * @param {{ token: string, proofToken: string }} requirements
   * @param {string} model
   * @returns {Promise<string>} conduit_token
   */
  async prepareImageConversation(prompt, requirements, model) {
    const convPath = "/backend-api/f/conversation/prepare";
    const payload = {
      action: "next",
      fork_from_shared_post: false,
      parent_message_id: newUuid(),
      model: mapImageModelSlug(model),
      client_prepare_state: "success",
      timezone_offset_min: -480,
      timezone: "Asia/Shanghai",
      conversation_mode: { kind: "primary_assistant" },
      system_hints: ["picture_v2"],
      partial_query: {
        id: newUuid(),
        author: { role: "user" },
        content: { content_type: "text", parts: [prompt] },
      },
      supports_buffering: true,
      supported_encodings: ["v1"],
      client_contextual_info: { app_name: "chatgpt.com" },
    };
    const res = await fetch(this.baseUrl + convPath, {
      method: "POST",
      headers: this._imageHeaders(convPath, requirements),
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`prepare conversation failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return String(data.conduit_token || "");
  }

  // ── Step 4: Upload reference image (for image edits) ──────────────────────

  /**
   * @param {Buffer} imageBytes
   * @param {string} [fileName]
   * @returns {Promise<{ fileId: string, fileName: string, fileSize: number, mimeType: string, width: number, height: number }>}
   */
  async uploadImage(imageBytes, fileName) {
    fileName = fileName || "image.png";
    const { width, height, mimeType } = getImageDimensions(imageBytes);

    const filesPath = "/backend-api/files";
    const createRes = await fetch(this.baseUrl + filesPath, {
      method: "POST",
      headers: this._headers(filesPath, { "Content-Type": "application/json", "Accept": "application/json" }),
      body: JSON.stringify({
        file_name: fileName,
        file_size: imageBytes.length,
        use_case: "multimodal",
        width,
        height,
      }),
    });
    if (!createRes.ok) throw new Error(`file create failed: ${createRes.status}`);
    const uploadMeta = await createRes.json();

    await new Promise((r) => setTimeout(r, 500));

    // PUT to Azure Blob Storage
    const blobRes = await fetch(String(uploadMeta.upload_url), {
      method: "PUT",
      headers: {
        "Content-Type": mimeType,
        "x-ms-blob-type": "BlockBlob",
        "x-ms-version": "2020-04-08",
        "Origin": this.baseUrl,
        "Referer": this.baseUrl + "/",
        "User-Agent": this.userAgent,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.8",
      },
      body: imageBytes,
    });
    if (!blobRes.ok) throw new Error(`blob upload failed: ${blobRes.status}`);

    // Confirm uploaded
    const confirmPath = `/backend-api/files/${uploadMeta.file_id}/uploaded`;
    const confirmRes = await fetch(this.baseUrl + confirmPath, {
      method: "POST",
      headers: this._headers(confirmPath, { "Content-Type": "application/json", "Accept": "application/json" }),
      body: "{}",
    });
    if (!confirmRes.ok) throw new Error(`file confirm failed: ${confirmRes.status}`);

    return {
      fileId: String(uploadMeta.file_id),
      fileName,
      fileSize: imageBytes.length,
      mimeType,
      width,
      height,
    };
  }

  // ── Step 5: Start image generation SSE ────────────────────────────────────

  /**
   * @param {string} prompt
   * @param {{ token: string, proofToken: string }} requirements
   * @param {string} conduitToken
   * @param {string} model
   * @param {Array<{ fileId: string, fileName: string, fileSize: number, mimeType: string, width: number, height: number }>} references
   * @returns {Promise<Response>}
   */
  async startImageGeneration(prompt, requirements, conduitToken, model, references) {
    references = references || [];

    const parts = references.map((ref) => ({
      content_type: "image_asset_pointer",
      asset_pointer: `file-service://${ref.fileId}`,
      width: ref.width,
      height: ref.height,
      size_bytes: ref.fileSize,
    }));
    parts.push(prompt);

    const content = references.length
      ? { content_type: "multimodal_text", parts }
      : { content_type: "text", parts: [prompt] };

    const metadata = {
      developer_mode_connector_ids: [],
      selected_github_repos: [],
      selected_all_github_repos: false,
      system_hints: ["picture_v2"],
      serialization_metadata: { custom_symbol_offsets: [] },
    };
    if (references.length) {
      metadata.attachments = references.map((ref) => ({
        id: ref.fileId,
        mimeType: ref.mimeType,
        name: ref.fileName,
        size: ref.fileSize,
        width: ref.width,
        height: ref.height,
      }));
    }

    const payload = {
      action: "next",
      messages: [{
        id: newUuid(),
        author: { role: "user" },
        create_time: Date.now() / 1000,
        content,
        metadata,
      }],
      parent_message_id: newUuid(),
      model: mapImageModelSlug(model),
      client_prepare_state: "sent",
      timezone_offset_min: -480,
      timezone: "Asia/Shanghai",
      conversation_mode: { kind: "primary_assistant" },
      enable_message_followups: true,
      system_hints: ["picture_v2"],
      supports_buffering: true,
      supported_encodings: ["v1"],
      client_contextual_info: {
        is_dark_mode: false,
        time_since_loaded: 1200,
        page_height: 1072,
        page_width: 1724,
        pixel_ratio: 1.2,
        screen_height: 1440,
        screen_width: 2560,
        app_name: "chatgpt.com",
      },
      paragen_cot_summary_display_override: "allow",
      force_parallel_switch: "auto",
    };

    const convPath = "/backend-api/f/conversation";
    const res = await fetch(this.baseUrl + convPath, {
      method: "POST",
      headers: this._imageHeaders(convPath, requirements, conduitToken, "text/event-stream"),
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`conversation SSE failed: ${res.status} ${await res.text()}`);
    return res;
  }

  // ── Step 6: Parse SSE stream ───────────────────────────────────────────────

  /**
   * @param {Response} response
   * @returns {Promise<{ conversationId: string, fileIds: string[], sedimentIds: string[] }>}
   */
  async parseImageSSE(response) {
    const FILE_RE = /file[-_][A-Za-z0-9]+/g;
    const SEDIMENT_RE = /sediment:\/\/([A-Za-z0-9_-]+)/g;
    const CONV_RE = /"conversation_id"\s*:\s*"([^"]+)"/;

    let conversationId = "";
    const fileIds = [];
    const sedimentIds = [];

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          reader.cancel();
          return { conversationId, fileIds, sedimentIds };
        }
        if (!conversationId) {
          const m = CONV_RE.exec(payload);
          if (m) conversationId = m[1];
        }
        let m;
        const fileRe = new RegExp(FILE_RE.source, "g");
        while ((m = fileRe.exec(payload)) !== null) {
          if (!fileIds.includes(m[0])) fileIds.push(m[0]);
        }
        const sedRe = new RegExp(SEDIMENT_RE.source, "g");
        while ((m = sedRe.exec(payload)) !== null) {
          if (!sedimentIds.includes(m[1])) sedimentIds.push(m[1]);
        }
      }
    }
    return { conversationId, fileIds, sedimentIds };
  }

  // ── Step 7: Poll conversation until file_ids appear ───────────────────────

  /**
   * @param {string} conversationId
   * @param {number} [timeoutMs]
   * @returns {Promise<{ fileIds: string[], sedimentIds: string[] }>}
   */
  async pollImageResults(conversationId, timeoutMs) {
    timeoutMs = timeoutMs || 120_000;
    const FILE_RE = /file-service:\/\/([A-Za-z0-9_-]+)/g;
    const SEDIMENT_RE = /sediment:\/\/([A-Za-z0-9_-]+)/g;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const convPath = `/backend-api/conversation/${conversationId}`;
      const res = await fetch(this.baseUrl + convPath, {
        headers: this._headers(convPath, { "Accept": "application/json" }),
      });
      if (!res.ok) throw new Error(`get conversation failed: ${res.status}`);
      const conv = await res.json();
      const mapping = conv.mapping || {};
      const fileIds = [];
      const sedimentIds = [];

      for (const node of Object.values(mapping)) {
        const msg = (node && node.message) || {};
        const author = msg.author || {};
        const meta = msg.metadata || {};
        const content = msg.content || {};
        if (author.role !== "tool") continue;
        if (meta.async_task_type !== "image_gen") continue;
        if (content.content_type !== "multimodal_text") continue;

        for (const part of content.parts || []) {
          const text =
            typeof part === "string"
              ? part
              : (part && part.asset_pointer) || "";
          let m;
          const fRe = new RegExp(FILE_RE.source, "g");
          while ((m = fRe.exec(text)) !== null) {
            if (!fileIds.includes(m[1])) fileIds.push(m[1]);
          }
          const sRe = new RegExp(SEDIMENT_RE.source, "g");
          while ((m = sRe.exec(text)) !== null) {
            if (!sedimentIds.includes(m[1])) sedimentIds.push(m[1]);
          }
        }
      }

      if (fileIds.length) return { fileIds, sedimentIds };
      if (sedimentIds.length) return { fileIds: [], sedimentIds };
      await new Promise((r) => setTimeout(r, 4000));
    }
    return { fileIds: [], sedimentIds: [] };
  }

  // ── Step 8: Resolve download URLs ─────────────────────────────────────────

  /**
   * @param {string} fileId
   * @returns {Promise<string>}
   */
  async getFileDownloadUrl(fileId) {
    const p = `/backend-api/files/${fileId}/download`;
    const res = await fetch(this.baseUrl + p, {
      headers: this._headers(p, { "Accept": "application/json" }),
    });
    if (!res.ok) return "";
    const data = await res.json();
    return String(data.download_url || data.url || "");
  }

  /**
   * @param {string} conversationId
   * @param {string} attachmentId
   * @returns {Promise<string>}
   */
  async getAttachmentDownloadUrl(conversationId, attachmentId) {
    const p = `/backend-api/conversation/${conversationId}/attachment/${attachmentId}/download`;
    const res = await fetch(this.baseUrl + p, {
      headers: this._headers(p, { "Accept": "application/json" }),
    });
    if (!res.ok) return "";
    const data = await res.json();
    return String(data.download_url || data.url || "");
  }

  /**
   * @param {string} conversationId
   * @param {string[]} fileIds
   * @param {string[]} sedimentIds
   * @returns {Promise<string[]>}
   */
  async resolveImageUrls(conversationId, fileIds, sedimentIds) {
    const urls = [];
    for (const fid of fileIds) {
      const url = await this.getFileDownloadUrl(fid);
      if (url) urls.push(url);
    }
    if (urls.length || !conversationId) return urls;
    for (const sid of sedimentIds) {
      const url = await this.getAttachmentDownloadUrl(conversationId, sid);
      if (url) urls.push(url);
    }
    return urls;
  }

  // ── Step 9: Download & format response ────────────────────────────────────

  /**
   * @param {string[]} urls
   * @param {"b64_json"|"url"} responseFormat
   * @param {string} [saveDir]
   * @returns {Promise<{ created: number, data: Array<{ b64_json?: string, url?: string }> }>}
   */
  async downloadAndFormat(urls, responseFormat, saveDir) {
    responseFormat = responseFormat || "b64_json";
    const data = [];
    for (const url of urls) {
      const res = await fetch(url);
      if (!res.ok) continue;
      const bytes = Buffer.from(await res.arrayBuffer());
      if (responseFormat === "b64_json") {
        data.push({ b64_json: bytes.toString("base64") });
      } else {
        data.push({ url: saveImageBytes(bytes, saveDir) });
      }
    }
    return { created: Math.floor(Date.now() / 1000), data };
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Tạo ảnh thông qua ChatGPT Web proxy — mirrors _run_image_task() in Python.
   *
   * @param {object} options
   * @param {string}   options.prompt           Prompt tạo ảnh
   * @param {string}   [options.model]          Model slug, mặc định "gpt-image-2"
   * @param {string}   [options.size]           Tỉ lệ ảnh: "1:1" | "16:9" | "9:16", mặc định "1:1"
   * @param {"b64_json"|"url"} [options.responseFormat]  Định dạng trả về
   * @param {Buffer[]} [options.referenceImages] Ảnh tham chiếu (dùng khi chỉnh sửa ảnh)
   * @param {string}   [options.saveDir]         Thư mục lưu ảnh khi responseFormat="url"
   * @returns {Promise<{ created: number, data: Array<{ b64_json?: string, url?: string }> }>}
   */
  async generateImage(options) {
    const {
      prompt,
      model = "gpt-image-2",
      size = "1:1",
      responseFormat = "b64_json",
      referenceImages = [],
      saveDir,
    } = options;

    console.log("▶ [1/9] Bootstrap chatgpt.com...");
    await this.bootstrap();

    console.log("▶ [2/9] Upload reference images (if any)...");
    const references = [];
    for (let i = 0; i < referenceImages.length; i++) {
      references.push(await this.uploadImage(referenceImages[i], `image_${i + 1}.png`));
    }

    console.log("▶ [3/9] Get chat requirements (sentinel token + PoW)...");
    const requirements = await this.getChatRequirements();

    const finalPrompt = buildImagePrompt(prompt, size);
    console.log("▶ [4/9] Prepare conversation (conduit_token)...");
    const conduitToken = await this.prepareImageConversation(finalPrompt, requirements, model);

    console.log("▶ [5/9] Start image generation SSE...");
    const sseResponse = await this.startImageGeneration(finalPrompt, requirements, conduitToken, model, references);

    console.log("▶ [6/9] Parse SSE stream...");
    let { conversationId, fileIds, sedimentIds } = await this.parseImageSSE(sseResponse);
    console.log("        SSE result:", { conversationId, fileIds, sedimentIds });

    if (conversationId && !fileIds.length && !sedimentIds.length) {
      console.log("▶ [7/9] Polling conversation for file IDs...");
      const polled = await this.pollImageResults(conversationId);
      fileIds = [...new Set([...fileIds, ...polled.fileIds])];
      sedimentIds = [...new Set([...sedimentIds, ...polled.sedimentIds])];
    } else {
      console.log("▶ [7/9] Skip poll — file IDs already in SSE stream.");
    }

    if (!fileIds.length && !sedimentIds.length) {
      throw new Error(`No image found. conversationId=${conversationId}`);
    }

    console.log("▶ [8/9] Resolve download URLs...");
    const urls = await this.resolveImageUrls(conversationId, fileIds, sedimentIds);
    if (!urls.length) throw new Error("Could not resolve download URLs");

    console.log("▶ [9/9] Download images...");
    return this.downloadAndFormat(urls, responseFormat, saveDir);
  }
}

// ─── Demo / CLI entry point ───────────────────────────────────────────────────

async function main() {
  const accessToken = process.env.CHATGPT_ACCESS_TOKEN;
  if (!accessToken) {
    console.error("❌  Thiếu access token!");
    console.error("    Cách lấy: mở chatgpt.com → F12 → Network → bắt request bất kỳ → header Authorization");
    console.error("    Sau đó: CHATGPT_ACCESS_TOKEN=eyJhb... node chatgpt-image-proxy.js");
    process.exit(1);
  }

  const proxy = new ChatGPTImageProxy(accessToken);

  try {
    const result = await proxy.generateImage({
      prompt: "A cyberpunk city at night, neon reflections on wet streets, ultra detailed",
      model: "gpt-image-2",
      size: "16:9",
      responseFormat: "b64_json",
    });

    console.log(`\n✅ Created at: ${new Date(result.created * 1000).toISOString()}`);
    console.log(`   Images: ${result.data.length}`);

    result.data.forEach((img, i) => {
      if (img.b64_json) {
        const fileName = `output_${i + 1}.png`;
        fs.writeFileSync(fileName, Buffer.from(img.b64_json, "base64"));
        console.log(`   💾 Saved: ${path.resolve(fileName)}`);
      } else if (img.url) {
        console.log(`   🔗 File: ${img.url}`);
      }
    });
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
}

main();

// ─── Export (dùng như module trong dự án khác) ────────────────────────────────
module.exports = { ChatGPTImageProxy, buildImagePrompt, mapImageModelSlug, saveImageBytes };
