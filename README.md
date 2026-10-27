# 📞 Call Me

A tiny web app that calls **your own phone number**. Type a message, press **Call my phone**, and your phone rings and reads the message aloud. You can watch the call status live (ringing → connected → finished).

![Screenshot](docs/screenshot.png)

It has no dependencies: it uses Node's built-in HTTP server and the [Twilio](https://www.twilio.com) Voice API to place the call.

## Setup

1. **Create a Twilio account** at https://www.twilio.com/try-twilio. The free trial includes credit.
2. **Get a Twilio phone number:** Console → *Phone Numbers → Manage → Buy a number* (trial accounts get one free).
3. **Trial accounts only:** verify your own phone under *Phone Numbers → Manage → Verified Caller IDs*. Trial accounts can only call verified numbers, and calls start with a short Twilio trial message.
4. **Configure the app:**
   ```bash
   cp .env.example .env
   ```
   Fill in `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` (shown on the Console home page), `TWILIO_FROM_NUMBER` (your Twilio number) and `MY_PHONE_NUMBER` (your phone). Write both numbers in E.164 format, for example `+15551234567`.
5. **Run it** (Node 22.9 or newer):
   ```bash
   npm start
   ```
   Open http://localhost:3000.

## Options

| Setting | What it does |
|---|---|
| Message | Up to 500 characters, read aloud using text-to-speech. If left empty, a default greeting is used. |
| Voice | Alice, Woman or Man. |
| Repeat | Read the message 1–3 times. |
| `APP_PASSWORD` | When set, the page asks for this password before placing a call. Set it if you host the app anywhere public. |

## Safety

The app only ever dials `MY_PHONE_NUMBER` from your `.env` file. The browser can't choose the number to call, so the app can't be used to call other people. Your `.env` is git-ignored, so your credentials stay out of the repo.

## API

- `GET /api/config`: shows whether the app is configured, with the target number masked.
- `POST /api/call`: places the call. Body: `{ "message": "...", "voice": "alice", "repeat": 1 }`.
- `GET /api/call/:sid`: returns the live call status.

If `APP_PASSWORD` is set, send it in the `X-App-Password` header.
