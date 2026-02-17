const express = require('express');
const { execFile, spawn } = require('child_process');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const SERVICE = process.env.SERVICE
const PROJECT_DIR = process.env.PROJECT_DIR;

if (!AUTH_TOKEN || !SERVICE || !PROJECT_DIR) {
  console.error("You done goofed (ENVVARS are fucked)");
  process.exit(1);
}
// ------------------------
// AUTH MIDDLEWARE
// ------------------------
app.use((req, res, next) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${AUTH_TOKEN}`) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  next();
});

// ------------------------
// SAFE SYSTEMCTL WRAPPER
// ------------------------
function runSystemctl(args, res) {
  execFile("sudo", ["systemctl", ...args], (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({ error: stderr });
    }
    res.json({ output: stdout });
  });
}

// ------------------------
// STATUS
// ------------------------
app.get("/status", (req, res) => {
  runSystemctl(
    ["show", SERVICE, "-p", "ActiveState", "-p", "SubState"],
    res
  );
});

// ------------------------
// START / STOP / RESTART
// ------------------------
app.post("/start", (req, res) => {
  runSystemctl(["start", SERVICE], res);
});

app.post("/stop", (req, res) => {
  runSystemctl(["stop", SERVICE], res);
});

app.post("/restart", (req, res) => {
  runSystemctl(["restart", SERVICE], res);
});

// ------------------------
// LOGS (last 100 lines)
// ------------------------
app.get("/logs", (req, res) => {
  execFile(
    "sudo",
    ["journalctl", "-u", SERVICE, "-n", "100", "--no-pager"],
    (err, stdout, stderr) => {
      if (err) {
        return res.status(500).json({ error: stderr });
      }
      res.type("text/plain").send(stdout);
    }
  );
});

app.get("/logs/stream", (req, res) => {
  if (req.query.token !== AUTH_TOKEN) {
    return res.status(403).end();
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");

  const journal = spawn("sudo", [
    "journalctl",
    "-u",
    SERVICE,
    "-f",
    "--no-pager"
  ]);

  journal.stdout.on("data", (data) => {
    res.write(`data: ${data.toString()}\n\n`);
  });

  req.on("close", () => journal.kill());
});

// ------------------------
// DEPLOY SCRIPT
// git pull → npm install → restart
// ------------------------
app.post("/deploy", async (req, res) => {
  try {
    await runCommand("git", ["pull"], PROJECT_DIR);
    await runCommand("npm", ["install", "--production"], PROJECT_DIR);
    await runCommand("sudo", ["systemctl", "restart", SERVICE]);

    res.json({ status: "Deployment complete" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// helper promise wrapper
function runCommand(cmd, args, cwd = undefined) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd });

    let output = "";
    let error = "";

    child.stdout.on("data", (data) => output += data.toString());
    child.stderr.on("data", (data) => error += data.toString());

    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(error || `Exit code ${code}`));
      }
      resolve(output);
    });
  });
}

// ------------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});