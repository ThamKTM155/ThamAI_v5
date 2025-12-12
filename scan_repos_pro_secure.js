// scan_repos_pro_secure.js
// ThamAI Security Scanner PRO - Secure Edition
// Yêu cầu: Node.js v18+ (fetch global)
// Outputs: security_report.html, security_report.csv, security_report.json

const fs = require("fs");
const path = require("path");

const TOKEN_FILE = "scan_token.txt";
const USERNAME = "ThamKTM155"; // <-- sửa nếu cần
const MAX_BLOB_FETCH_KB = 200;  // chỉ tải blob < 200 KB nội dung để kiểm tra
const MAX_FILE_SIZE_MB = 10;    // cảnh báo file > 10 MB
const GITHUB_API = "https://api.github.com";

if (!fs.existsSync(TOKEN_FILE)) {
  console.error(`❌ Không tìm thấy ${TOKEN_FILE}. Tạo file và dán PAT vào (chỉ 1 dòng).`);
  process.exit(1);
}

const TOKEN = fs.readFileSync(TOKEN_FILE, "utf8").trim();
if (!TOKEN) {
  console.error("❌ Token rỗng trong scan_token.txt. Dán token hợp lệ.");
  process.exit(1);
}

const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  "User-Agent": "ThamAI-Security-Scanner",
  Accept: "application/vnd.github+json",
};

// Patterns để phát hiện tokens/keys in-file
const SECRET_REGEXES = [
  /ghp_[A-Za-z0-9_]{36,}/g,            // old personal tokens
  /github_pat_[A-Za-z0-9_]{20,}/g,     // new PAT
  /sk-[A-Za-z0-9\-_]{20,}/gi,          // OpenAI-like keys
  /api[_-]?key['"\s:=]{1,}/i,
  /access[_-]?token['"\s:=]{1,}/i,
  /authorization['"\s:=]{1,}/i,
  /aws[_-]?access[_-]?key/i,
  /secret['"\s:=]{1,}/i,
  /password['"\s:=]{1,}/i,
  /-----BEGIN PRIVATE KEY-----/i,
];

// Dangerous filenames / path fragments
const DANGEROUS_FILENAMES = [
  ".env", ".env.local", ".env.production", "config.json", "credentials", ".pem", ".p12", ".key", ".pfx", ".crt"
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function ghFetch(pathURL) {
  const res = await fetch(`${GITHUB_API}${pathURL}`, { headers: HEADERS });
  if (res.status === 401) {
    const t = await res.text();
    throw new Error(`GitHub API 401 Bad credentials: ${t}`);
  }
  if (![200, 201, 202, 204].includes(res.status)) {
    const body = await res.text();
    // Not throwing for some endpoints to let caller handle (e.g., empty repo 409)
    return { ok: false, status: res.status, text: body };
  }
  const json = await res.json();
  return { ok: true, json };
}

async function getAllRepos() {
  // lấy tối đa 200 repo (page size)
  const out = await ghFetch(`/users/${USERNAME}/repos?per_page=200&sort=updated`);
  if (!out.ok) throw new Error(`Failed to list repos: ${out.status}`);
  return out.json;
}

function makeIssue(repo, type, message, location) {
  return { repo, type, message, location };
}

function isTextMime(mime) {
  if (!mime) return true;
  return /text|json|javascript|xml|html|css|markdown|yaml|plaintext/.test(mime);
}

async function fetchBlobContent(repoFullName, sha, size) {
  // Nếu quá lớn thì bỏ
  if (size > MAX_BLOB_FETCH_KB * 1024) return { skipped: true, reason: `Too large (${(size/1024).toFixed(1)} KB)` };

  const out = await ghFetch(`/repos/${repoFullName}/git/blobs/${sha}`);
  if (!out.ok) return { error: true, reason: out.text };
  // Git blob.content là base64
  const content = Buffer.from(out.json.content, out.json.encoding || "base64").toString("utf8");
  return { skipped: false, content };
}

async function scanRepo(repo) {
  const repoFull = `${repo.owner.login}/${repo.name}`;
  const issues = [];

  // 1) Lấy tree (HEAD)
  const treeResp = await ghFetch(`/repos/${repoFull}/git/trees/HEAD?recursive=1`);
  if (!treeResp.ok) {
    // empty repo or other - report and return
    issues.push(makeIssue(repoFull, "RepoTreeError", `Tree fetch failed: ${treeResp.status}`, ""));
    return issues;
  }
  const tree = treeResp.json.tree || [];

  // 2) scan file paths & sizes and collect blobs to inspect
  const blobsToInspect = [];
  for (const item of tree) {
    if (item.type !== "blob") continue;

    const ln = item.path.toLowerCase();
    // filename checks
    for (const fn of DANGEROUS_FILENAMES) {
      if (ln.endsWith(fn) || ln.includes(`/${fn}`)) {
        issues.push(makeIssue(repoFull, "DangerFilename", `Dangerous filename/path detected: ${item.path}`, item.path));
      }
    }

    // large files
    if (item.size && item.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      issues.push(makeIssue(repoFull, "LargeFile", `Large file: ${item.path} (${(item.size/1024/1024).toFixed(2)} MB)`, item.path));
      continue; // skip fetching very large files
    }

    // choose certain extensions or small files to inspect content
    const ext = path.extname(item.path).toLowerCase();
    const inspectExts = [".js", ".jsx", ".ts", ".tsx", ".html", ".css", ".env", ".json", ".md", ".txt", ".py", ".sh"];
    if (inspectExts.includes(ext) || DANGEROUS_FILENAMES.some(fn => ln.endsWith(fn))) {
      blobsToInspect.push({ path: item.path, sha: item.sha, size: item.size || 0 });
    }
  }

  // 3) fetch blob contents for selected files (throttle to avoid rate limit)
  for (const b of blobsToInspect) {
    await sleep(50); // small delay to be polite
    const blob = await fetchBlobContent(repoFull, b.sha, b.size);
    if (blob.error) {
      issues.push(makeIssue(repoFull, "BlobFetchError", `Cannot fetch blob: ${b.path}`, b.path));
      continue;
    }
    if (blob.skipped) {
      // skipped due to size
      continue;
    }
    const content = blob.content;

    // 4) scan content for secrets
    for (const re of SECRET_REGEXES) {
      const m = content.match(re);
      if (m && m.length) {
        issues.push(makeIssue(repoFull, "SecretInFile", `Potential secret pattern (${re}) found in ${b.path}`, b.path));
      }
    }

    // 5) scan for cleartext keywords like password=, API_KEY etc
    const kw = /(api_key|api-key|authorization|bearer|password|secret|access_token|private_key|aws_access_key_id|aws_secret_access_key)/i;
    if (kw.test(content)) {
      issues.push(makeIssue(repoFull, "KeywordInFile", `Keyword-like strings found in ${b.path}`, b.path));
    }
  }

  // 6) scan recent commits messages (last 100)
  const commitsResp = await ghFetch(`/repos/${repoFull}/commits?per_page=100`);
  if (!commitsResp.ok) {
    issues.push(makeIssue(repoFull, "CommitFetchError", `Commits fetch failed: ${commitsResp.status}`, ""));
    return issues;
  }
  const commits = commitsResp.json;
  const commitLeakRegex = /(ghp_|github_pat_|sk-|api_key|secret|password|bearer)/i;
  for (const c of commits) {
    const msg = (c.commit && c.commit.message) || "";
    if (commitLeakRegex.test(msg)) {
      issues.push(makeIssue(repoFull, "SecretInCommitMessage", `Possible secret in commit message: ${msg}`, c.sha));
    }
  }

  return issues;
}

function toCSV(rows) {
  const header = ["repo","type","message","location"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(`"${r.repo.replace(/"/g,"'")}","${r.type}","${r.message.replace(/"/g,"'")}","${(r.location||"").replace(/"/g,"'")}"`);
  }
  return lines.join("\n");
}

function generateHTMLReport(mapIssues) {
  let html = `<!doctype html><html><head><meta charset="utf-8"><title>ThamAI Security Report</title><style>
  body{font-family:Arial;margin:20px} .ok{color:green} .bad{color:red;font-weight:bold} .repo{border:1px solid #ccc;padding:10px;margin:10px 0;border-radius:6px}
  .summary{display:flex;gap:20px}
  </style></head><body><h1>🔐 ThamAI Security Report</h1>`;
  const repos = Object.keys(mapIssues).sort();
  html += `<div class="summary"><div>Total repos scanned: ${repos.length}</div></div>`;
  for (const repo of repos) {
    const issues = mapIssues[repo];
    html += `<div class="repo"><h2>${repo}</h2>`;
    if (!issues || issues.length===0) {
      html += `<p class="ok">No issues detected.</p>`;
    } else {
      html += `<p class="bad">${issues.length} issue(s):</p><ul>`;
      for (const it of issues) {
        html += `<li><strong>${it.type}</strong> — ${escapeHtml(it.message)} <em>(${escapeHtml(it.location||"")})</em></li>`;
      }
      html += `</ul>`;
    }
    html += `</div>`;
  }
  html += `</body></html>`;
  fs.writeFileSync("security_report.html", html, "utf8");
  fs.writeFileSync("security_report.csv", toCSV([].concat(...Object.values(mapIssues))), "utf8");
  fs.writeFileSync("security_report.json", JSON.stringify(mapIssues, null, 2), "utf8");
  console.log("📄 Reports generated: security_report.html, security_report.csv, security_report.json");
}

function escapeHtml(s) {
  return String(s||"").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c]));
}

(async () => {
  console.log("Starting ThamAI Security Scanner PRO - Secure");
  const reposResp = await getAllRepos().catch(e => { console.error("List repo failed:", e.message); process.exit(1); });
  const repos = reposResp;
  const all = {};

  for (const r of repos) {
    try {
      const issues = await scanRepo(r);
      all[`${r.owner.login}/${r.name}`] = issues;
      // small delay between repos
      await sleep(150);
    } catch (e) {
      console.error("Error scanning repo", r.name, e.message);
      all[`${r.owner.login}/${r.name}`] = [{repo: `${r.owner.login}/${r.name}`, type:"ScanError", message: e.message}];
    }
  }

  generateHTMLReport(all);
  console.log("Scan complete.");
})();
