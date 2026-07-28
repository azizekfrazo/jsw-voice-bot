# JSW Steel – AI Voice Bot

Real-time voice + chat customer support bot for JSW Steel, built with **OpenAI Realtime API** (speech-to-speech). Includes a sales lead dashboard with intent qualification.

---

## Features

- **Speech-to-speech** conversation using OpenAI Realtime API
- **JSW Steel themed** UI (navy blue + orange)
- **Multilingual** — detects and responds in Hindi or English automatically
- **Domain restricted** — politely refuses off-topic queries
- **Lead capture** — naturally collects name, company, product interest, quantity, timeline
- **Intent qualification** — automatically scores leads as High / Medium / Low
- **Sales dashboard** — real-time view of all leads with full conversation transcript

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Set up environment

```bash
cp .env.example .env
# Edit .env and add your OpenAI API key
```

Your `.env` should look like:
```
OPENAI_API_KEY=sk-proj-xxxxxxxxxxxx
PORT=3000
```

### 3. Run the server

```bash
npm start
```

Or with auto-reload during development:
```bash
npm run dev
```

### 4. Open in browser

- **Bot interface:** http://localhost:3000
- **Sales dashboard:** http://localhost:3000/dashboard.html

---

## Project Structure

```
jsw-voice-bot/
├── server.js          # Express + WebSocket relay + Lead DB + REST API
├── knowledge.js       # JSW Steel product knowledge base
├── package.json
├── .env               # Your API keys (not committed to git)
├── leads.db           # SQLite database (auto-created on first run)
└── public/
    ├── index.html     # Bot interface (JSW themed)
    ├── app.js         # Frontend: WebSocket, audio capture/playback
    ├── dashboard.html # Sales team dashboard
    └── dashboard.js   # Dashboard: API calls, table, modal
```

---

## How It Works

### Architecture

```
Browser (mic/speaker)
    ↕  WebSocket (/realtime)
Node.js Server (server.js)
    ↕  WebSocket (wss://api.openai.com/v1/realtime)
OpenAI Realtime API (gpt-4o-realtime-preview)
```

The Node.js server acts as a **secure relay** — your OpenAI API key never touches the browser. All audio is streamed in real-time via WebSocket.

### Lead Capture

The bot uses **OpenAI function calling** (`capture_lead_info`) to extract lead information during conversation. The function is called multiple times as new information emerges. All data is stored in a local SQLite database.

### Intent Scoring

The AI assesses intent automatically during conversation:
- **High** — Specific quantity, clear timeline (<6 months), decision maker, asks about pricing
- **Medium** — Has a project, exploring options, timeline unclear
- **Low** — General inquiry, students, browsing

---

## Deployment on DigitalOcean

### 1. SSH into your droplet

```bash
ssh user@your-droplet-ip
```

### 2. Clone / upload the project

```bash
git clone your-repo
# or scp -r ./jsw-voice-bot user@ip:~/
```

### 3. Install Node.js (if not installed)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 4. Install dependencies and start

```bash
cd jsw-voice-bot
npm install
cp .env.example .env
nano .env  # add your OPENAI_API_KEY
npm start
```

### 5. Set up Nginx reverse proxy

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### 6. SSL with Let's Encrypt

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

### 7. Keep it running with PM2

```bash
npm install -g pm2
pm2 start server.js --name jsw-bot
pm2 save
pm2 startup
```

---

## Customisation

### Update the Knowledge Base
Edit `knowledge.js` — add product specs, pricing, FAQs, dealer info. The more detailed, the better the bot answers.

### Change the Voice
In `server.js`, change `voice: 'alloy'` to any OpenAI TTS voice:
- `alloy` — neutral
- `nova` — clear and bright (good for Hindi)
- `shimmer` — warm and friendly
- `echo` — deeper

### Adjust Lead Qualification
In the `SYSTEM_PROMPT` inside `server.js`, modify the **INTENT LEVEL ASSESSMENT** section to match your sales qualification criteria.

### Add More Languages
The bot auto-detects Hindi and English. To add more languages, update the language detection regex in server.js and add the language to the system prompt.

---

## Notes

- The SQLite database (`leads.db`) is created automatically on first run
- Each browser session creates a new lead record
- Leads with no interaction (session immediately closed) are still recorded but show minimal data
- The dashboard auto-refreshes every 30 seconds
- For production, consider replacing SQLite with PostgreSQL

---

## Estimated Monthly Costs (Demo Scale)

| Service | Cost |
|---|---|
| OpenAI Realtime API | ~$0.06/min audio = ~$30-60/month (500 mins) |
| DigitalOcean Droplet (4GB) | $24/month |
| Domain | ~$1/month |
| **Total** | **~$55-85/month** |
