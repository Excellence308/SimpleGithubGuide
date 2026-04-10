const graph = document.getElementById("commit-graph");

if (graph) {
  initCommitGraph(graph);
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
