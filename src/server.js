require("dotenv").config();

const express = require("express");
const http = require("http");
const httpProxy = require("http-proxy");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT || "8080", 10);
const GATEWAY_PORT = 18789;
const SETUP_PASSWORD = process.env.SETUP_PASSWORD || "";
const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR ||
  path.join(process.env.HOME || "/home/openclaw", ".openclaw");
const CONFIG_PATH = path.join(STATE_DIR, "openclaw.json");

let gatewayProcess = null;
let gatewayReady = false;

// --- Config ---

function buildConfig() {
  const apiKey = process.env.FIREWORKS_API_KEY;
  if (!apiKey) return null;

  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const gatewayToken = process.env.GATEWAY_AUTH_TOKEN;

  return {
    agents: {
      defaults: {
        model: {
          primary: "custom-api-fireworks-ai/accounts/fireworks/models/glm-5",
        },
        models: {
          "custom-api-fireworks-ai/accounts/fireworks/models/glm-5": {}
        },
        workspace: "/data/workspace",
        compaction: { mode: "safeguard" },
        maxConcurrent: 4,
        subagents: { maxConcurrent: 8 }
      },
    },
    models: {
      mode: "merge",
      providers: {
        "custom-api-fireworks-ai": {
          baseUrl: "https://api.fireworks.ai/inference/v1",
          apiKey: apiKey,
          api: "openai-completions",
          models: [
            {
              id: "accounts/fireworks/models/glm-5",
              name: "accounts/fireworks/models/glm-5 (Custom Provider)",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200000,
              maxTokens: 8192,
            },
          ],
        },
      },
    },
    messages: {
      ackReactionScope: "group-mentions"
    },
    commands: {
      native: "auto",
      nativeSkills: "auto",
      restart: true,
      ownerDisplay: "raw"
    },
    session: {
      dmScope: "per-channel-peer"
    },
    ...(telegramToken ? {
      
      channels: {
        telegram: {
          enabled: true,
          dmPolicy: "allowlist",
          allowFrom: ["8737921782"],
          botToken: telegramToken,
          groupPolicy: "allowlist",
        }
      },
      plugins: {
        entries: {
          telegram: { enabled: true }
        }
      }
    } : {}),
    gateway: {
      port: GATEWAY_PORT,
      mode: "local",
      bind: "loopback",
      ...(gatewayToken ? {
        auth: {
          mode: "token",
          token: gatewayToken
        }
      } : {}),
      trustedProxies: ["0.0.0.0/0"],
      tailscale: {
        mode: "off",
        resetOnExit: false
      }
    },
  };
}

function ensureConfig() {
  fs.mkdirSync(STATE_DIR, { recursive: true });

  // Try to build config from env vars
  const config = buildConfig();
  if (config) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log("[hey-jarvis] Generated config from FIREWORKS_API_KEY.");
    return;
  }

  // Fallback: copy template if no env var
  if (!fs.existsSync(CONFIG_PATH)) {
    const tpl = path.join(__dirname, "..", "openclaw.json");
    if (fs.existsSync(tpl)) {
      fs.copyFileSync(tpl, CONFIG_PATH);
      console.log("[hey-jarvis] Copied default config template.");
    }
  }
}

// --- Gateway Process Management ---

function startGateway() {
  console.log("[hey-jarvis] Starting OpenClaw gateway...");

  gatewayProcess = spawn(
    "openclaw",
    [
      "gateway",
      "run",
      "--port",
      String(GATEWAY_PORT),
      "--bind",
      "loopback",
      "--allow-unconfigured",
    ],
    {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_CONFIG_PATH: CONFIG_PATH,
        OPENCLAW_WORKSPACE_DIR:
          process.env.OPENCLAW_WORKSPACE_DIR || "/data/workspace",
      },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );

  gatewayProcess.stdout.on("data", (data) => {
    const msg = data.toString().trim();
    console.log(`[gateway] ${msg}`);
    if (
      msg.includes("listening") ||
      msg.includes("ready") ||
      msg.includes("Gateway")
    ) {
      gatewayReady = true;
      console.log("[hey-jarvis] Gateway is ready.");
    }
  });

  gatewayProcess.stderr.on("data", (data) => {
    const msg = data.toString().trim();
    if (msg) console.error(`[gateway:err] ${msg}`);
    if (msg.includes("listening") || msg.includes("ready")) {
      gatewayReady = true;
    }
  });

  gatewayProcess.on("exit", (code) => {
    console.log(`[hey-jarvis] Gateway exited with code ${code}`);
    gatewayReady = false;
    setTimeout(() => {
      console.log("[hey-jarvis] Restarting gateway...");
      startGateway();
    }, 3000);
  });

  setTimeout(() => {
    if (!gatewayReady) {
      gatewayReady = true;
      console.log("[hey-jarvis] Gateway assumed ready (timeout).");
    }
  }, 15000);
}

// --- Express App ---

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/healthz", (_req, res) => {
  res.json({
    status: "ok",
    gateway: gatewayReady ? "running" : "starting",
    timestamp: new Date().toISOString(),
  });
});

app.get("/setup/healthz", (_req, res) => res.json({ status: "ok" }));

// --- WebSocket Proxy to Gateway ---

const proxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${GATEWAY_PORT}`,
  ws: true,
});

proxy.on("error", (err, _req, res) => {
  console.error("[proxy]", err.message);
  if (res && res.writeHead) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Gateway not ready" }));
  }
});

app.use((req, res) => {
  if (!gatewayReady) {
    return res.status(503).json({ error: "Gateway starting" });
  }
  proxy.web(req, res);
});

// --- Start ---

const server = http.createServer(app);

server.on("upgrade", (req, socket, head) => {
  if (gatewayReady) {
    proxy.ws(req, socket, head);
  } else {
    socket.destroy();
  }
});

ensureConfig();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[hey-jarvis] Listening on :${PORT}`);
  startGateway();
});

process.on("SIGTERM", () => {
  console.log("[hey-jarvis] Shutting down...");
  if (gatewayProcess) gatewayProcess.kill("SIGTERM");
  server.close(() => process.exit(0));
});
