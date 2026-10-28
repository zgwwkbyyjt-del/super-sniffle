// Call Me — a tiny web app that rings your own phone via Twilio.
// Zero dependencies: uses Node's built-in http server and fetch.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  MY_PHONE_NUMBER,
  APP_PASSWORD = "",
  PORT = "3000",
  TWILIO_API_BASE = "https://api.twilio.com",
} = process.env;

const E164 = /^\+[1-9]\d{6,14}$/;
const MAX_MESSAGE_LENGTH = 500;
const VOICES = ["alice", "man", "woman"];

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

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10_000) reject(Object.assign(new Error("Body too large"), { status: 413 }));
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
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = await readFile(new URL("./public/index.html", import.meta.url));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
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
  console.log(`Call Me running at http://localhost:${PORT}`);
  if (missing.length) console.warn(`⚠  Missing config: ${missing.join(", ")} — copy .env.example to .env and fill it in.`);
});
