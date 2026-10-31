// The personal assistant behind /assistant: Claude with tools for your notes, calendar,
// the web, and ringing your own phone.

import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";

const MODEL = "claude-opus-5-5";
const MAX_TURNS = 40;
const MAX_TURN_LENGTH = 8000;

const SYSTEM = `You are a personal assistant that lives on its owner's phone. You talk with one person: the owner.

Answer directly. Lead with the answer in the first sentence, then add only what helps. Keep most replies to one to three short sentences. Replies may be read aloud, so prefer plain sentences over tables, headings, or long lists; a short list is fine when the owner asks for several items.

You have tools for the owner's own information:
- Notes: things the owner asked you to remember. When they say "remember", "note", or "don't let me forget", save a note. When a question could depend on something they told you before (a code, a preference, a person, a plan), search the notes before answering, and say so plainly if nothing is saved.
- Calendar: their upcoming events, read-only. Use it for anything about their schedule, free time, or what is next. You cannot add or change events; offer to save a note instead.
- Web search: for current facts, news, weather, hours, or anything you are not sure is still true.
- Call my phone: rings the owner's phone and reads a short message aloud. Use it only when the owner asks to be called.

Never invent notes, events, or search results. If a tool fails or is not set up, say what is missing in one sentence.`;

function validTurns(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_TURNS) return false;
  return messages.every(
    (m, i) =>
      m && typeof m.content === "string" && m.content.trim() && m.content.length <= MAX_TURN_LENGTH &&
      m.role === (i % 2 === 0 ? "user" : "assistant"),
  ) && messages.at(-1).role === "user";
}

export function createAssistant({ notes, calendar, placeCall, canCall, timeZone }) {
  const client = new Anthropic();

  const tools = [
    betaTool({
      name: "search_notes",
      description: "Search the owner's saved notes. Pass words to look for, or an empty query to list the most recent notes. Returns notes with their id and when they were saved.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Words to look for; empty lists recent notes" } },
        required: ["query"],
        additionalProperties: false,
      },
      run: async ({ query }) => JSON.stringify(await notes.search(query)),
    }),
    betaTool({
      name: "save_note",
      description: "Save something the owner wants remembered. Write it as a complete, self-contained sentence so it makes sense later, e.g. \"Sam's birthday is March 4.\"",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "The note, as one self-contained sentence or short paragraph" } },
        required: ["text"],
        additionalProperties: false,
      },
      run: async ({ text }) => JSON.stringify(await notes.add(text)),
    }),
    betaTool({
      name: "delete_note",
      description: "Delete a saved note by id. Only use this when the owner asks to forget or remove something; search first to find the id.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "The note id from search_notes" } },
        required: ["id"],
        additionalProperties: false,
      },
      run: async ({ id }) => ((await notes.remove(id)) ? "Deleted." : "No note with that id."),
    }),
    betaTool({
      name: "get_calendar_events",
      description: "List the owner's calendar events from now through the next N days (1 to 31). Each event has a title, a human-readable time in the owner's time zone, ISO start/end, and location if any.",
      inputSchema: {
        type: "object",
        properties: { days_ahead: { type: "integer", minimum: 1, maximum: 31, description: "How many days ahead to look" } },
        required: ["days_ahead"],
        additionalProperties: false,
      },
      run: async ({ days_ahead }) => {
        if (!calendar.configured) return "No calendar is connected. The owner can add a private iCal link as CALENDAR_ICS_URL.";
        const events = await calendar.upcoming(days_ahead);
        return events.length ? JSON.stringify(events) : `No events in the next ${days_ahead} days.`;
      },
    }),
    betaTool({
      name: "call_my_phone",
      description: "Ring the owner's own phone and read a short message aloud. Only use when the owner explicitly asks to be called. It can only ever call the owner.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string", maxLength: 500, description: "What the call should say, under 500 characters" } },
        required: ["message"],
        additionalProperties: false,
      },
      run: async ({ message }) => {
        if (!canCall()) return "Calling isn't set up: the Twilio settings are missing.";
        const call = await placeCall({ message: message.slice(0, 500), voice: "alice", repeat: 1 });
        return `Calling now (status: ${call.status}).`;
      },
    }),
    { type: "web_search_20260209", name: "web_search", max_uses: 3 },
  ];

  return {
    validTurns,

    async reply(turns) {
      const now = new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "full", timeStyle: "short" }).format(new Date());
      const message = await client.beta.messages.toolRunner({
        model: MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low" },
        cache_control: { type: "ephemeral" },
        max_iterations: 8,
        system: SYSTEM,
        tools,
        messages: [
          ...turns.map(({ role, content }) => ({ role, content })),
          // Volatile context goes after the history so the cached prefix stays stable.
          { role: "system", content: `Current time for the owner: ${now} (${timeZone}).` },
        ],
      });

      if (message.stop_reason === "refusal") return "Sorry, I can't help with that one.";
      const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      return text || "Sorry, I didn't get an answer together. Could you ask again?";
    },
  };
}

export { Anthropic };
