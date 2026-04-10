const graph = document.getElementById("commit-graph");
const visitorMap = document.getElementById("visitor-map");

if (graph) {
  initCommitGraph(graph);
}

if (visitorMap) {
  initVisitorMap(visitorMap);
}

async function initCommitGraph(graphElement) {
  const nodeLayer = document.getElementById("commit-nodes");
  const tooltip = document.getElementById("commit-tooltip");
  const tooltipAuthor = document.getElementById("tooltip-author");
  const tooltipTime = document.getElementById("tooltip-time");
  const path = document.getElementById("commit-path");

  const inspectorMessage = document.getElementById("inspector-message");
  const inspectorAuthor = document.getElementById("inspector-author");
  const inspectorTime = document.getElementById("inspector-time");
  const inspectorSha = document.getElementById("inspector-sha");

  const owner = graphElement.dataset.owner;
  const repo = graphElement.dataset.repo;
  const preferredBranch = graphElement.dataset.branch || "";
  const limit = Number.parseInt(graphElement.dataset.commitLimit || "18", 10);

  if (!owner || !repo) {
    showGraphError(
      "Repository metadata is missing.",
      "Add data-owner and data-repo attributes so the graph knows what to load.",
      inspectorMessage,
      inspectorAuthor,
      inspectorTime,
      inspectorSha
    );
    return;
  }

  try {
    const branch = await fetchBranchName(owner, repo, preferredBranch);
    const [commits, tags] = await Promise.all([
      fetchCommits(owner, repo, branch, limit),
      fetchTags(owner, repo)
    ]);

    const branchHeadSha = commits[0]?.sha || "";
    const commitData = decorateCommits(commits, tags, branch, branchHeadSha);
    renderCommitGraph(
      commitData,
      graphElement,
      nodeLayer,
      tooltip,
      tooltipAuthor,
      tooltipTime,
      path,
      inspectorMessage,
      inspectorAuthor,
      inspectorTime,
      inspectorSha
    );
  } catch (error) {
    showGraphError(
      "Commit history could not be loaded.",
      error instanceof Error ? error.message : "The GitHub API request failed.",
      inspectorMessage,
      inspectorAuthor,
      inspectorTime,
      inspectorSha
    );
  }
}

async function fetchBranchName(owner, repo, preferredBranch) {
  if (preferredBranch) {
    return preferredBranch;
  }

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      Accept: "application/vnd.github+json"
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub repository API returned ${response.status}.`);
  }

  const payload = await response.json();
  return payload.default_branch || "main";
}

async function fetchCommits(owner, repo, branch, limit) {
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/commits`);
  url.searchParams.set("sha", branch);
  url.searchParams.set("per_page", String(limit));

  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json"
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub commits API returned ${response.status}.`);
  }

  const payload = await response.json();

  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error("No commits were returned for this repository.");
  }

  return payload;
}

async function fetchTags(owner, repo) {
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/git/matching-refs/tags`);

  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json"
    }
  });

  if (!response.ok) {
    return [];
  }

  const payload = await response.json();

  if (!Array.isArray(payload)) {
    return [];
  }

  const resolvedTags = await Promise.all(
    payload.map(async (tagRef) => {
      const name = tagRef.ref?.replace("refs/tags/", "");
      const objectSha = tagRef.object?.sha;
      const objectType = tagRef.object?.type;

      if (!name || !objectSha || !objectType) {
        return null;
      }

      if (objectType === "commit") {
        return { name, sha: objectSha };
      }

      if (objectType === "tag") {
        const annotatedTargetSha = await fetchAnnotatedTagTarget(owner, repo, objectSha);

        if (annotatedTargetSha) {
          return { name, sha: annotatedTargetSha };
        }
      }

      return null;
    })
  );

  return resolvedTags.filter(Boolean);
}

async function fetchAnnotatedTagTarget(owner, repo, tagSha) {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/tags/${tagSha}`, {
    headers: {
      Accept: "application/vnd.github+json"
    }
  });

  if (!response.ok) {
    return null;
  }

  const payload = await response.json();
  return payload?.object?.type === "commit" ? payload.object.sha : null;
}

function decorateCommits(commits, tags, branch, branchHeadSha) {
  const tagsBySha = new Map();

  tags.forEach((tag) => {
    const sha = tag?.sha;

    if (!sha) {
      return;
    }

    const current = tagsBySha.get(sha) || [];
    current.push(tag.name);
    tagsBySha.set(sha, current);
  });

  const chronologicalCommits = [...commits].reverse();

  return chronologicalCommits.map((entry) => {
    const author =
      entry.author?.login ||
      entry.commit?.author?.name ||
      "Unknown author";

    const time =
      entry.commit?.author?.date ||
      entry.commit?.committer?.date ||
      new Date().toISOString();

    const message = entry.commit?.message?.split("\n")[0] || "Untitled commit";
    const sha = entry.sha.slice(0, 7);
    const labels = [];

    if (entry.sha === branchHeadSha) {
      labels.push("HEAD", branch);
    }

    const tagNames = tagsBySha.get(entry.sha) || [];
    labels.push(...tagNames.slice(0, 2));

    return {
      sha,
      fullSha: entry.sha,
      author,
      time,
      message,
      labels
    };
  });
}

function renderCommitGraph(
  commits,
  graphElement,
  nodeLayer,
  tooltip,
  tooltipAuthor,
  tooltipTime,
  path,
  inspectorMessage,
  inspectorAuthor,
  inspectorTime,
  inspectorSha
) {
  nodeLayer.replaceChildren();

  const viewport = { width: 1000, height: 420, padding: 72 };
  const span = viewport.width - viewport.padding * 2;

  const points = commits.map((commit, index) => {
    const progress = commits.length === 1 ? 0.5 : index / (commits.length - 1);
    const x = viewport.padding + span * progress;
    const y =
      210 +
      Math.sin(index * 0.85) * 76 +
      Math.cos(index * 0.46) * 28;

    return {
      ...commit,
      x,
      y
    };
  });

  path.setAttribute("d", buildPath(points));

  let activeNode = null;

  points.forEach((commit, index) => {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "commit-node";
    node.style.left = `${(commit.x / viewport.width) * 100}%`;
    node.style.top = `${(commit.y / viewport.height) * 100}%`;
    node.dataset.author = commit.author;
    node.setAttribute(
      "aria-label",
      `${commit.message} by ${commit.author} on ${formatLongDate(commit.time)}`
    );

    if (commit.labels.length > 0) {
      const badges = document.createElement("span");
      badges.className = "commit-node-badges";

      commit.labels.forEach((label) => {
        const pill = document.createElement("span");
        pill.className = "commit-node-label";
        pill.textContent = label;
        badges.appendChild(pill);
      });

      node.appendChild(badges);
    }

    node.addEventListener("mouseenter", () => activateCommit(node, commit));
    node.addEventListener("focus", () => activateCommit(node, commit));
    node.addEventListener("click", () => activateCommit(node, commit));

    nodeLayer.appendChild(node);

    if (index === points.length - 1) {
      activateCommit(node, commit, false);
    }
  });

  graphElement.addEventListener("pointermove", (event) => {
    const bounds = graphElement.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    graphElement.style.setProperty("--glow-x", `${x}px`);
    graphElement.style.setProperty("--glow-y", `${y}px`);
  });

  graphElement.addEventListener("pointerleave", () => {
    tooltip.classList.remove("is-visible");
    graphElement.style.setProperty("--glow-x", "50%");
    graphElement.style.setProperty("--glow-y", "50%");
  });

  function activateCommit(node, commit, showTooltip = true) {
    if (activeNode) {
      activeNode.classList.remove("is-active");
    }

    activeNode = node;
    activeNode.classList.add("is-active");

    inspectorMessage.textContent = commit.message;
    inspectorAuthor.textContent = commit.author;
    inspectorTime.textContent = formatLongDate(commit.time);
    inspectorSha.textContent = commit.sha;

    tooltipAuthor.textContent = commit.author;
    tooltipTime.textContent = formatShortDate(commit.time);

    const left = clamp((commit.x / viewport.width) * 100, 14, 86);
    const top = clamp((commit.y / viewport.height) * 100 - 5, 18, 86);

    tooltip.style.left = `${left}%`;
    tooltip.style.top = `${top}%`;

    if (showTooltip) {
      tooltip.classList.add("is-visible");
    }
  }
}

function showGraphError(message, detail, inspectorMessage, inspectorAuthor, inspectorTime, inspectorSha) {
  inspectorMessage.textContent = message;
  inspectorAuthor.textContent = "Unavailable";
  inspectorTime.textContent = detail;
  inspectorSha.textContent = "-";
}

async function initVisitorMap(visitorElement) {
  const nodeLayer = document.getElementById("visitor-nodes");
  const tooltip = document.getElementById("visitor-tooltip");
  const tooltipName = document.getElementById("visitor-tooltip-name");
  const tooltipStatus = document.getElementById("visitor-tooltip-status");

  const title = document.getElementById("visitor-title");
  const summary = document.getElementById("visitor-summary");
  const count = document.getElementById("visitor-count");
  const verifiedCount = document.getElementById("visitor-verified-count");
  const neutralCount = document.getElementById("visitor-neutral-count");

  const owner = visitorElement.dataset.owner;
  const repo = visitorElement.dataset.repo;
  const visitorPath = visitorElement.dataset.visitorPath || "Visitors";

  if (!owner || !repo) {
    title.textContent = "Visitor source is missing.";
    summary.textContent = "Add data-owner and data-repo so the roster can load.";
    count.textContent = "-";
    verifiedCount.textContent = "-";
    neutralCount.textContent = "-";
    return;
  }

  try {
    const branch = await fetchBranchName(owner, repo, "");
    const [visitorNames, identityNames] = await Promise.all([
      fetchVisitorNames(owner, repo, visitorPath, branch),
      fetchPublicIdentityNames(owner, repo, branch)
    ]);

    const visitors = visitorNames.map((name) => ({
      name,
      verified: identityNames.has(normalizeIdentity(name))
    }));

    renderVisitorMap(
      visitors,
      visitorElement,
      nodeLayer,
      tooltip,
      tooltipName,
      tooltipStatus,
      title,
      summary,
      count,
      verifiedCount,
      neutralCount
    );
  } catch (error) {
    title.textContent = "Visitors could not be loaded.";
    summary.textContent = error instanceof Error ? error.message : "The GitHub API request failed.";
    count.textContent = "-";
    verifiedCount.textContent = "-";
    neutralCount.textContent = "-";
  }
}

async function fetchVisitorNames(owner, repo, visitorPath, branch) {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(visitorPath)}?ref=${encodeURIComponent(branch)}`,
    {
      headers: {
        Accept: "application/vnd.github+json"
      }
    }
  );

  if (!response.ok) {
    throw new Error(`GitHub contents API returned ${response.status}.`);
  }

  const payload = await response.json();

  if (!Array.isArray(payload)) {
    throw new Error("Visitors folder could not be read.");
  }

  return payload
    .filter((entry) => entry.type === "file")
    .map((entry) => entry.name)
    .filter((name) => !name.toUpperCase().startsWith("CREATE A FILE"))
    .sort((left, right) => left.localeCompare(right));
}

async function fetchPublicIdentityNames(owner, repo, branch) {
  const [contributors, authors] = await Promise.all([
    fetchContributorLogins(owner, repo),
    fetchCommitAuthorNames(owner, repo, branch, 3)
  ]);

  const identities = new Set();
  contributors.forEach((name) => identities.add(normalizeIdentity(name)));
  authors.forEach((name) => identities.add(normalizeIdentity(name)));
  return identities;
}

async function fetchContributorLogins(owner, repo) {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/contributors?per_page=100`, {
    headers: {
      Accept: "application/vnd.github+json"
    }
  });

  if (!response.ok) {
    return [];
  }

  const payload = await response.json();

  if (!Array.isArray(payload)) {
    return [];
  }

  return payload.map((entry) => entry.login).filter(Boolean);
}

async function fetchCommitAuthorNames(owner, repo, branch, maxPages) {
  const names = new Set();

  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(`https://api.github.com/repos/${owner}/${repo}/commits`);
    url.searchParams.set("sha", branch);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));

    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json"
      }
    });

    if (!response.ok) {
      break;
    }

    const payload = await response.json();

    if (!Array.isArray(payload) || payload.length === 0) {
      break;
    }

    payload.forEach((entry) => {
      if (entry.author?.login) {
        names.add(entry.author.login);
      }

      if (entry.commit?.author?.name) {
        names.add(entry.commit.author.name);
      }
    });

    if (payload.length < 100) {
      break;
    }
  }

  return [...names];
}

function renderVisitorMap(
  visitors,
  visitorElement,
  nodeLayer,
  tooltip,
  tooltipName,
  tooltipStatus,
  title,
  summary,
  count,
  verifiedCount,
  neutralCount
) {
  nodeLayer.replaceChildren();

  const verifiedVisitors = visitors.filter((visitor) => visitor.verified).length;
  const neutralVisitors = visitors.length - verifiedVisitors;

  count.textContent = String(visitors.length);
  verifiedCount.textContent = String(verifiedVisitors);
  neutralCount.textContent = String(neutralVisitors);

  if (visitors.length === 0) {
    title.textContent = "No visitors yet.";
    summary.textContent = "Once the class starts adding files to the Visitors folder, stars will appear here.";
    return;
  }

  title.textContent = `${visitors.length} visitors in orbit`;
  summary.textContent = "Each file in the Visitors folder becomes a star in the constellation.";

  const points = createVisitorLayout(visitors.length);
  let activeNode = null;

  visitors.forEach((visitor, index) => {
    const point = points[index];
    const node = document.createElement("button");
    node.type = "button";
    node.className = `visitor-node${visitor.verified ? " is-verified" : ""}`;
    node.style.left = `${point.x}%`;
    node.style.top = `${point.y}%`;
    node.setAttribute(
      "aria-label",
      `${visitor.name}. Visitor star.`
    );

    const label = document.createElement("span");
    label.className = "visitor-node-label";
    label.textContent = visitor.name;
    node.appendChild(label);

    node.addEventListener("mouseenter", () => activateVisitor(node, visitor, point));
    node.addEventListener("focus", () => activateVisitor(node, visitor, point));
    node.addEventListener("click", () => activateVisitor(node, visitor, point));

    nodeLayer.appendChild(node);

    if (index === 0) {
      activateVisitor(node, visitor, point, false);
    }
  });

  visitorElement.addEventListener("pointermove", (event) => {
    const bounds = visitorElement.getBoundingClientRect();
    visitorElement.style.setProperty("--visitor-glow-x", `${event.clientX - bounds.left}px`);
    visitorElement.style.setProperty("--visitor-glow-y", `${event.clientY - bounds.top}px`);
  });

  visitorElement.addEventListener("pointerleave", () => {
    tooltip.classList.remove("is-visible");
    visitorElement.style.setProperty("--visitor-glow-x", "50%");
    visitorElement.style.setProperty("--visitor-glow-y", "50%");
  });

  function activateVisitor(node, visitor, point, showTooltip = true) {
    if (activeNode) {
      activeNode.classList.remove("is-active");
    }

    activeNode = node;
    activeNode.classList.add("is-active");

    title.textContent = visitor.name;
    summary.textContent = visitor.verified
      ? "A bright star in the constellation."
      : "A quiet star in the constellation.";

    tooltipName.textContent = visitor.name;
    tooltipStatus.textContent = visitor.verified
      ? "Bright star"
      : "Quiet star";
    tooltip.style.left = `${clamp(point.x, 14, 86)}%`;
    tooltip.style.top = `${clamp(point.y - 4, 18, 84)}%`;

    if (showTooltip) {
      tooltip.classList.add("is-visible");
    }
  }
}

function buildPath(points) {
  if (points.length === 0) {
    return "";
  }

  let d = `M ${points[0].x} ${points[0].y}`;

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const delta = current.x - previous.x;
    const controlOneX = previous.x + delta * 0.42;
    const controlTwoX = previous.x + delta * 0.58;

    d += ` C ${controlOneX} ${previous.y}, ${controlTwoX} ${current.y}, ${current.x} ${current.y}`;
  }

  return d;
}

function formatLongDate(value) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "long",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatShortDate(value) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function createVisitorLayout(count) {
  const points = [];
  const centerX = 50;
  const centerY = 58;
  const maxRadius = 33;
  const goldenAngle = 2.399963229728653;

  for (let index = 0; index < count; index += 1) {
    const ratio = count === 1 ? 0.25 : (index + 1) / (count + 1);
    const radius = 8 + maxRadius * Math.sqrt(ratio);
    const angle = index * goldenAngle - Math.PI / 2;

    points.push({
      x: clamp(centerX + Math.cos(angle) * radius, 10, 90),
      y: clamp(centerY + Math.sin(angle) * radius * 0.88, 18, 88)
    });
  }

  return points;
}

function normalizeIdentity(value) {
  return value.trim().toLowerCase();
}
