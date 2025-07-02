# jira-discord-bot

## 🛠️ Jira Discord Bot

This is a natural language-powered Discord bot that integrates with Jira. It allows users to interact with Jira using simple text prompts (e.g., "create a ticket for fixing the login bug") and supports ticket creation, updates, assignment, and more.

---

### 🚀 Features

* ✅ Natural language to Jira actions (read, create, assign, update)
* 🤖 Powered by OpenAI (or Claude via OpenRouter)
* 📁 Secure `.env`-based config
* 🎯 Built with Node.js and Discord.js

---

### 📦 Requirements

* Node.js v18+
* A Discord Bot Token
* A Jira account with API access
* OpenAI or Claude API key (via OpenRouter)

---

### 🧰 Setup Instructions

#### 1. **Clone the repository**

```bash
git clone https://github.com/Codenatives-MCP/jira-discord-bot.git
cd jira-discord-bot
```

#### 2. **Install dependencies**

```bash
npm install
```

#### 3. **Configure environment variables**

Copy the `.env.example` file and fill in your own secrets:

```bash
cp .env.example .env
```

Then open `.env` and fill in:

```env
DISCORD_TOKEN=your_discord_bot_token
JIRA_API_TOKEN=your_jira_api_token
JIRA_EMAIL=your_email@domain.com
JIRA_PROJECT_KEY=ABC
OPENAI_API_KEY=your_openai_or_openrouter_key
```

---

#### 4. **Run the bot**

```bash
node index.js
```

---

### 🧪 Development Notes

* Do **not** upload `.env` to GitHub. It’s in `.gitignore` for security.
* If you update the structure of `.env`, also update `.env.example`.
* For multiple users, each person can run the bot in their own server.

---

### 📌 Useful Commands (In Discord)

You can interact with the bot using natural language, such as:

* `@bot create a ticket to fix onboarding bug`
* `@bot assign "Fix onboarding bug" to Alice`
* `@bot what tickets are in review`
* `@bot update "Fix login" to in progress`

---

### 🧠 Tech Stack

* **Node.js**
* **discord.js**
* **Axios**
* **OpenAI/OpenRouter**
* **Jira REST API**
* **fuzzball.js** (for fuzzy matching)

