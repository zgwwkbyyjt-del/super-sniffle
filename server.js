// Call Me — a tiny web app that rings your own phone via Twilio,
// plus a personal assistant (Claude) you can install on your phone at /assistant.
// Uses Node's built-in http server and fetch; the only dependency is the Anthropic SDK.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { createAssistant, Anthropic } from "./assistant.js";
import { createCalendar, createNotes } from "./personal.js";

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  MY_PHONE_NUMBER,
  APP_PASSWORD = "",
  PORT = "3000",
  TWILIO_API_BASE = "https://api.twilio.com",
  ANTHROPIC_API_KEY,
  CALENDAR_ICS_URL = "",
  TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone,
  AGENT_TOKEN = "",
  RAILWAY_VOLUME_MOUNT_PATH,
  // On Railway, keep notes on the attached volume so they survive redeploys.
  NOTES_FILE = RAILWAY_VOLUME_MOUNT_PATH ? `${RAILWAY_VOLUME_MOUNT_PATH}/notes.json` : "data/notes.json",
  NTFY_TOPIC = "",
  NTFY_SERVER = "https://ntfy.sh",
  JARVIS_WEBHOOK_URL = "",
} = process.env;

const E164 = /^\+[1-9]\d{6,14}$/;
const MAX_MESSAGE_LENGTH = 500;
const VOICES = ["alice", "man", "woman"];

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/assistant": ["assistant.html", "text/html; charset=utf-8"],
  "/listen": ["listen.html", "text/html; charset=utf-8"],
  "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"],
  "/sw.js": ["sw.js", "text/javascript; charset=utf-8"],
  "/icon.svg": ["icon.svg", "image/svg+xml"],
  "/icon-192.png": ["icon-192.png", "image/png"],
  "/icon-512.png": ["icon-512.png", "image/png"],
};

const notes = createNotes(new URL(NOTES_FILE, new URL(".", import.meta.url)));
const calendar = createCalendar(CALENDAR_ICS_URL, TIME_ZONE);
const assistant = createAssistant({
  notes,
  calendar,
  placeCall: (opts) => placeCall(opts),
  canCall: () => missingConfig().length === 0,
  timeZone: TIME_ZONE,
});

function missingConfig() {
  return ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "MY_PHONE_NUMBER"].filter(
    (key) => !process.env[key],
  );
}

function maskNumber(number) {
  return number ? number.slice(0, -4).replace(/\d/g, "•") + number.slice(-4) : null;
}

function escapeXml(text) {
  return text.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);
}

const digits = (number) => String(number || "").replace(/\D/g, "");

// Requests from the Bland phone agent: a shared bearer token, and the caller must be you.
function agentOk(req) {
  if (!AGENT_TOKEN) return false;
  const given = Buffer.from(req.headers.authorization || "");
  const expected = Buffer.from(`Bearer ${AGENT_TOKEN}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  return !MY_PHONE_NUMBER || digits(req.headers["x-caller"]) === digits(MY_PHONE_NUMBER);
}

function passwordOk(req) {
  if (!APP_PASSWORD) return true;
  const given = Buffer.from(req.headers["x-app-password"] || "");
  const expected = Buffer.from(APP_PASSWORD);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function twilio(method, path, form) {
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const res = await fetch(`${TWILIO_API_BASE}/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      ...(form && { "Content-Type": "application/x-www-form-urlencoded" }),
    },
    body: form && new URLSearchParams(form),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || `Twilio error ${res.status}`), { status: 502 });
  return data;
}

async function placeCall({ message, voice, repeat }) {
  const text = escapeXml(message);
  const say = `<Say voice="${voice}">${text}</Say><Pause length="1"/>`;
  const twiml = `<Response>${say.repeat(repeat)}</Response>`;
  const call = await twilio("POST", "/Calls.json", { To: MY_PHONE_NUMBER, From: TWILIO_FROM_NUMBER, Twiml: twiml });
  return { sid: call.sid, status: call.status };
}

function readJson(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) reject(Object.assign(new Error("Body too large"), { status: 413 }));
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(Object.assign(new Error("Invalid JSON"), { status: 400 }));
      }
    });
  });
}

function send(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

const routes = {
  "GET /api/config": async () => {
    const missing = missingConfig();
    return {
      ready: missing.length === 0,
      missing,
      to: maskNumber(MY_PHONE_NUMBER),
      passwordRequired: Boolean(APP_PASSWORD),
      assistant: { ready: Boolean(ANTHROPIC_API_KEY), calendar: calendar.configured, timeZone: TIME_ZONE },
    };
  },

  "POST /api/call": async (req) => {
    const missing = missingConfig();
    if (missing.length) throw Object.assign(new Error(`Missing config: ${missing.join(", ")}`), { status: 500 });
    if (!E164.test(MY_PHONE_NUMBER) || !E164.test(TWILIO_FROM_NUMBER)) {
      throw Object.assign(new Error("Phone numbers must be in E.164 format, e.g. +15551234567"), { status: 500 });
    }

    const body = await readJson(req);
    const message = String(body.message || "").trim() || "Hello! This is your test call. Have a great day.";
    if (message.length > MAX_MESSAGE_LENGTH) {
      throw Object.assign(new Error(`Message must be ${MAX_MESSAGE_LENGTH} characters or fewer`), { status: 400 });
    }
    const voice = VOICES.includes(body.voice) ? body.voice : "alice";
    const repeat = Math.min(Math.max(parseInt(body.repeat, 10) || 1, 1), 3);

    return placeCall({ message, voice, repeat });
  },

  "POST /api/assistant": async (req) => {
    if (!ANTHROPIC_API_KEY) throw Object.assign(new Error("Missing config: ANTHROPIC_API_KEY"), { status: 500 });
    const { messages } = await readJson(req, 400_000);
    if (!assistant.validTurns(messages)) {
      throw Object.assign(new Error("Send messages as alternating user/assistant turns, ending with the user"), { status: 400 });
    }
    try {
      return { reply: await assistant.reply(messages) };
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw Object.assign(new Error("Anthropic API key was rejected"), { status: 500 });
      if (err instanceof Anthropic.RateLimitError) throw Object.assign(new Error("The assistant is busy. Try again in a moment."), { status: 429 });
      if (err instanceof Anthropic.APIError) throw Object.assign(new Error(`Assistant error: ${err.message}`), { status: 502 });
      throw err;
    }
  },
};

// Noise alerts from the /listen page: forwarded to ntfy (desktop/phone notifications) and an optional Jarvis webhook.
const NOISE_MIN_GAP_MS = 15_000;
const noiseEvents = [];

async function deliverNoise(event) {
  const when = new Date(event.at).toLocaleTimeString("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" });
  const jobs = {};
  if (NTFY_TOPIC) {
    jobs.ntfy = fetch(`${NTFY_SERVER.replace(/\/$/, "")}/${encodeURIComponent(NTFY_TOPIC)}`, {
      method: "POST",
      headers: { Title: "Noise detected", Priority: "high", Tags: "loud_sound" },
      body: `Your phone heard a sound ${event.over} dB above the room's normal level at ${when}.`,
    });
  }
  if (JARVIS_WEBHOOK_URL) {
    jobs.jarvis = fetch(JARVIS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "noise", ...event }),
    });
  }
  const results = await Promise.allSettled(Object.values(jobs));
  return Object.fromEntries(
    Object.keys(jobs).map((name, i) => {
      const r = results[i];
      return [name, r.status === "fulfilled" && r.value.ok ? "sent" : `failed (${r.status === "fulfilled" ? r.value.status : r.reason.message})`];
    }),
  );
}

routes["GET /api/noise"] = async (req) => {
  if (!passwordOk(req)) throw Object.assign(new Error("Wrong password"), { status: 401 });
  return { events: noiseEvents.slice(-20).reverse(), targets: { ntfy: Boolean(NTFY_TOPIC), jarvis: Boolean(JARVIS_WEBHOOK_URL) } };
};

routes["POST /api/noise"] = async (req) => {
  if (!NTFY_TOPIC && !JARVIS_WEBHOOK_URL) {
    throw Object.assign(new Error("Missing config: set NTFY_TOPIC (or JARVIS_WEBHOOK_URL)"), { status: 500 });
  }
  const body = await readJson(req);
  const level = Number(body.level), over = Number(body.over);
  if (!Number.isFinite(level) || !Number.isFinite(over)) throw Object.assign(new Error("level and over must be numbers"), { status: 400 });
  const last = noiseEvents.at(-1);
  if (last && Date.now() - last.at < NOISE_MIN_GAP_MS) return { sent: false, reason: "Too soon after the last alert" };
  const event = { at: Date.now(), level: Math.round(level), over: Math.round(over) };
  event.delivered = await deliverNoise(event);
  noiseEvents.push(event);
  if (noiseEvents.length > 50) noiseEvents.shift();
  return { sent: true, ...event };
};

// Endpoints for the Bland phone agent (Norma). See README → "Phone agent".
const agentRoutes = {
  "GET /api/agent/calendar": async (req, url) => ({ events: await calendar.upcoming(url.searchParams.get("days") || 7) }),
  "POST /api/agent/notes/search": async (req) => ({ notes: await notes.search((await readJson(req)).query || "", 10) }),
  "POST /api/agent/notes": async (req) => ({ saved: await notes.add((await readJson(req)).text) }),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  try {
    const file = req.method === "GET" && STATIC[url.pathname];
    if (file) {
      const body = await readFile(new URL(`./public/${file[0]}`, import.meta.url));
      res.writeHead(200, { "Content-Type": file[1] });
      return res.end(body);
    }

    const agentHandler = agentRoutes[`${req.method} ${url.pathname}`];
    if (agentHandler) {
      if (!agentOk(req)) return send(res, 403, { error: "Not allowed" });
      return send(res, 200, await agentHandler(req, url));
    }

    const callStatus = url.pathname.match(/^\/api\/call\/(CA[0-9a-f]{32})$/i);
    if (req.method === "GET" && callStatus) {
      if (!passwordOk(req)) return send(res, 401, { error: "Wrong password" });
      const call = await twilio("GET", `/Calls/${callStatus[1]}.json`);
      return send(res, 200, { sid: call.sid, status: call.status, duration: call.duration });
    }

    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return send(res, 404, { error: "Not found" });
    if (req.method !== "GET" && !passwordOk(req)) return send(res, 401, { error: "Wrong password" });

    send(res, 200, await handler(req));
  } catch (err) {
    send(res, err.status || 500, { error: err.message });
  }
});

server.listen(Number(PORT), () => {
  const missing = missingConfig();
  console.log(`Call Me running at http://localhost:${PORT} (assistant: http://localhost:${PORT}/assistant)`);
  if (missing.length) console.warn(`⚠  Missing config: ${missing.join(", ")} — copy .env.example to .env and fill it in.`);
});
