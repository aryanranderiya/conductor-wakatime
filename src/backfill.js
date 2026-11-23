const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const BUCKET_SECONDS = 120;
const ENDPOINT = "https://api.wakatime.com/api/v1/users/current/heartbeats.bulk";

const LANGUAGE_BY_EXTENSION = new Map([
  [".js", "JavaScript"], [".jsx", "JavaScript"], [".ts", "TypeScript"], [".tsx", "TypeScript"],
  [".py", "Python"], [".rb", "Ruby"], [".go", "Go"], [".rs", "Rust"], [".swift", "Swift"],
  [".java", "Java"], [".kt", "Kotlin"], [".c", "C"], [".h", "C"], [".cpp", "C++"], [".hpp", "C++"],
  [".cs", "C#"], [".php", "PHP"], [".sh", "Bash"], [".bash", "Bash"], [".zsh", "Bash"],
  [".sql", "SQL"], [".html", "HTML"], [".css", "CSS"], [".scss", "SCSS"], [".json", "JSON"],
  [".yaml", "YAML"], [".yml", "YAML"], [".md", "Markdown"], [".mdx", "Markdown"], [".toml", "TOML"],
]);

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "NotebookRead", "ReadFile", "WriteFile"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "WriteFile"]);

function option(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index !== -1 && argv[index + 1] && !argv[index + 1].startsWith("--")) {
    return argv[index + 1];
  }
  const inline = argv.find((entry) => entry.startsWith(`--${name}=`));
  return inline ? inline.split("=")[1] : fallback;
}

function apiKey(configPath) {
  const text = fs.readFileSync(configPath, "utf8");
  const match = text.match(/^\s*api_key\s*=\s*(\S+)/m);
  if (!match) throw new Error("api_key missing from ~/.wakatime.cfg");
  return match[1];
}

function repoColumn(db) {
  const result = spawnSync("sqlite3", ["-json", db, "PRAGMA table_info(workspaces)"], { encoding: "utf8" });
  const names = JSON.parse(result.stdout || "[]").map((entry) => entry.name);
  return names.includes("repository_id") ? "repository_id" : "project_id";
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function languageFor(filePath) {
  if (!filePath) return null;
  return LANGUAGE_BY_EXTENSION.get(path.extname(filePath).toLowerCase()) || null;
}

function toolFilePath(input) {
  if (!input || typeof input !== "object") return null;
  return input.file_path || input.path || input.filePath || input.target_file || null;
}

function itemsOf(content) {
  if (!content || typeof content !== "object") return [];
  if (content.message && Array.isArray(content.message.content)) return content.message.content;
  if (Array.isArray(content.content)) return content.content;
  return [];
}

async function runBackfill(argv, paths) {
  const days = Number(option(argv, "days", 30));
  const endDays = Number(option(argv, "end-days", 0));
  const batchSize = Math.max(1, Math.min(Number(option(argv, "batch", 25)), 25));
  const delay = Math.max(0, Number(option(argv, "delay", 600)));
  const dryRun = argv.includes("--dry-run");

  const start = new Date(Date.now() - days * 86400 * 1000).toISOString();
  const end = new Date(Date.now() - endDays * 86400 * 1000).toISOString();
  const column = repoColumn(paths.conductorDb);
  const key = apiKey(paths.wakatimeConfig);
  const buckets = new Map();

  let lastCreatedAt = null;
  let lastId = null;
  let scanned = 0;
  let fileEvents = 0;

  function addBucket(time, project, branch, filePath, isWrite, toolName) {
    const bucket = Math.floor(time / BUCKET_SECONDS) * BUCKET_SECONDS + BUCKET_SECONDS / 2;
    const bucketKey = `${project}|${bucket}`;
    const existing = buckets.get(bucketKey);
    const isFile = Boolean(filePath);

    if (existing && existing.type === "file" && !isFile) return;
    if (existing && existing.type === "file" && isFile && existing.is_write && !isWrite) return;

    buckets.set(bucketKey, {
      entity: isFile ? filePath : "Conductor",
      type: isFile ? "file" : "app",
      time: bucket,
      project,
      branch: branch || undefined,
      language: isFile ? languageFor(filePath) || undefined : undefined,
      category: "ai coding",
      is_write: isFile ? Boolean(isWrite) : false,
      tool: toolName || undefined,
    });
  }

  function processRow(row) {
    const content = (() => {
      try { return JSON.parse(row.content); } catch { return null; }
    })();
    if (!content) return;

    const time = Date.parse(row.created_at) / 1000;
    if (!Number.isFinite(time)) return;

    const project = row.repo_name || row.directory_name || "Conductor";
    const items = itemsOf(content);
    let foundFile = false;

    for (const item of items) {
      if (!item || item.type !== "tool_use" || !FILE_TOOLS.has(item.name)) continue;
      const filePath = toolFilePath(item.input);
      if (!filePath) continue;
      foundFile = true;
      fileEvents += 1;
      addBucket(time, project, row.branch, filePath, WRITE_TOOLS.has(item.name), item.name);
    }

    if (!foundFile) {
      const tool = items.find((item) => item && item.type === "tool_use")?.name || "activity";
      addBucket(time, project, row.branch, null, false, tool);
    }
  }

  function scanPage(limit = 2000) {
    const where = lastCreatedAt
      ? `and (sm.created_at > ${sqlLiteral(lastCreatedAt)} or (sm.created_at = ${sqlLiteral(lastCreatedAt)} and sm.id > ${sqlLiteral(lastId)}))`
      : "";
    const sql = `
      select sm.id, sm.created_at, sm.content, s.agent_type, s.model, w.directory_name, w.branch,
             r.name as repo_name, r.root_path
      from session_messages sm
      join sessions s on s.id = sm.session_id
      left join workspaces w on w.id = s.workspace_id
      left join repos r on r.id = w.${column}
      where sm.created_at >= ${sqlLiteral(start)} and sm.created_at < ${sqlLiteral(end)} and json_valid(sm.content) ${where}
      order by sm.created_at asc, sm.id asc
      limit ${limit};
    `;
    const result = spawnSync("sqlite3", ["-json", paths.conductorDb, sql], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (result.status !== 0) throw new Error((result.stderr || "").trim() || "sqlite3 failed");
    const rows = JSON.parse(result.stdout || "[]");
    for (const row of rows) processRow(row);
    scanned += rows.length;
    if (rows.length) {
      lastCreatedAt = rows[rows.length - 1].created_at;
      lastId = rows[rows.length - 1].id;
    }
    return rows.length;
  }

  console.log(JSON.stringify({ days, start, end, dryRun, column, scanned: 0 }));
  while (scanPage() === 2000) {
    process.stdout.write(`scanned ${scanned}\r`);
  }
  console.log(`\nscanned ${scanned} messages, ${fileEvents} file events, ${buckets.size} heartbeats`);

  const heartbeats = [...buckets.values()].sort((a, b) => a.time - b.time);
  if (dryRun) {
    const byType = heartbeats.reduce((acc, heartbeat) => {
      acc[heartbeat.type] = (acc[heartbeat.type] || 0) + 1;
      return acc;
    }, {});
    console.log(JSON.stringify({ dryRun: true, heartbeats: heartbeats.length, byType, first: heartbeats[0], last: heartbeats[heartbeats.length - 1] }, null, 2));
    return;
  }

  async function sendBatch(batch, attempt = 1) {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`,
        "User-Agent": "wakatime/v1.0 (darwin) conductor-wakatime-backfill/0.1.0",
      },
      body: JSON.stringify(batch),
    });

    if (response.status === 429 && attempt <= 5) {
      const wait = 2000 * attempt;
      console.log(`429, waiting ${wait}ms`);
      await new Promise((resolve) => setTimeout(resolve, wait));
      return sendBatch(batch, attempt + 1);
    }

    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 300)}`);
    return text;
  }

  let sent = 0;
  let failed = 0;
  for (let index = 0; index < heartbeats.length; index += batchSize) {
    const batch = heartbeats.slice(index, index + batchSize);
    try {
      await sendBatch(batch);
      sent += batch.length;
    } catch (error) {
      failed += batch.length;
      console.error(`batch ${index / batchSize + 1} failed: ${error.message}`);
    }
    if (index % (batchSize * 20) === 0) {
      console.log(`sent ${sent}/${heartbeats.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  console.log(JSON.stringify({ sent, failed, total: heartbeats.length }));
}

module.exports = { runBackfill };
