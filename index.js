import { Octokit } from "@octokit/core";
import dayjs from "dayjs";
import semver from "semver";
import OpenAI from "openai";
import process from "node:process";
import fs from "node:fs";

const OWNER = process.env.GITHUB_REPOSITORY_OWNER;
const REPO = process.env.GITHUB_REPOSITORY.split("/")[1];
const OPENAI_API_KEY = process.env.INPUT_OPENAI_API_KEY;
const GH_TOKEN = process.env.INPUT_GITHUB_TOKEN;
const BASE_BRANCH = process.env.INPUT_BASE_BRANCH || "main";
const TARGET_BRANCH = process.env.INPUT_TARGET_BRANCH || "production";
const N8N_URL = process.env.INPUT_N8N_URL;

const octo = new Octokit({ auth: GH_TOKEN });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const WORKSPACE_MAPPING = {
  kr: "coloso-kr",
  jp: "coloso-jp",
  intl: "coloso-intl",
  bo: "coloso-backoffice",
};

const WORKFLOW_PATTERNS = {
  "coloso-kr": ["deploy-production-kr.yml"],
  "coloso-jp": ["deploy-production-jp.yml"],
  "coloso-intl": [
    "deploy-production-intl-asia.yml",
    "deploy-production-intl-us.yml",
    "deploy-production-intl-us-east.yml",
  ],
  "coloso-backoffice": ["deploy-production-backoffice.yml"],
};

async function getLastTag() {
  try {
    const { data: releases } = await octo.request(
      "GET /repos/{owner}/{repo}/releases",
      {
        owner: OWNER,
        repo: REPO,
        per_page: 1,
      }
    );

    if (releases.length > 0 && releases[0].tag_name) {
      return releases[0].tag_name;
    }

    throw new Error("No release notes found to get last tag");
  } catch (error) {
    console.error("❌ Error getting last tag:", error.message);
    return "0.0.0";
  }
}

async function getCommitsSince(tag) {
  const { data } = await octo.request(
    "GET /repos/{owner}/{repo}/compare/{basehead}",
    {
      owner: OWNER,
      repo: REPO,
      basehead: `${tag}...${BASE_BRANCH}`,
    }
  );
  return {
    commits: data.commits.map((c) => c.commit.message.split("\n")[0]), // subject line only
    files: data.files || [], // 변경된 파일들
  };
}

async function generateReleaseNotes(commits, changedWorkspaces) {
  const messages = [
    {
      role: "system",
      content: `You are a professional release-note writer. Group commits by type and produce concise, human‑friendly Korean release notes in Markdown bullet lists. The output should be in Korean.
        카테고리는 변경된 워크스페이스에 따라 노트를 작성해줘.
        변경된 워크스페이스는 ${changedWorkspaces.join(", ")} 이다.
        카테고리는 다음과 같다.
        [Backoffice, Service: KR, Service: JP, Service: INTL(ASIA, US, US-EAST), Chore]
        변경된 워크스페이스와 카테고리를 매칭해서, 카테고리를 정해주고, 커밋들을 참고해서 카테고리 별로 커밋 내용에 있는 기능, 버그 수정, 코드 개선 등을 그룹화해줘.
        변경된 워크스페이스가 없으면, 카테고리는 chore 카테고리로 넣어주면 돼.
        `,
    },
    { role: "user", content: JSON.stringify(commits) },
  ];

  const chat = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    max_tokens: 1000,
  });

  return chat.choices[0].message.content.trim();
}

function bumpVersion(prev, commits) {
  if (/BREAKING|major/i.test(commits)) return semver.inc(prev, "major");
  if (/feat|feature/i.test(commits)) return semver.inc(prev, "minor");
  return semver.inc(prev, "patch");
}

async function getWorkflows() {
  try {
    const { data } = await octo.request(
      "GET /repos/{owner}/{repo}/actions/workflows",
      {
        owner: OWNER,
        repo: REPO,
      }
    );
    return data.workflows;
  } catch (error) {
    console.warn("Could not fetch workflows:", error.message);
    return [];
  }
}

async function triggerWorkflows(changedWorkspaces, workflows) {
  const triggeredWorkflows = [];

  for (const workspace of changedWorkspaces) {
    const workflowPatterns = WORKFLOW_PATTERNS[workspace] || [];

    for (const pattern of workflowPatterns) {
      const workflow = workflows.find(
        (wf) =>
          wf.name
            .toLowerCase()
            .includes(pattern.replace(".yml", "").toLowerCase()) ||
          wf.path.toLowerCase().includes(pattern.toLowerCase())
      );

      if (workflow) {
        try {
          await octo.request(
            "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
            {
              owner: OWNER,
              repo: REPO,
              workflow_id: workflow.id,
              ref: TARGET_BRANCH,
            }
          );

          const { data: runs } = await octo.request(
            "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs",
            {
              owner: OWNER,
              repo: REPO,
              workflow_id: workflow.id,
              per_page: 1,
            }
          );

          const runUrl = runs.workflow_runs[0]
            ? runs.workflow_runs[0].html_url
            : `https://github.com/${OWNER}/${REPO}/actions/workflows/${workflow.path}`;

          triggeredWorkflows.push({
            workspace,
            workflowName: workflow.name,
            workflowId: workflow.id,
            url: runUrl,
          });
        } catch (error) {
          console.error(
            `❌ Failed to trigger workflow ${workflow.name}:`,
            error.message
          );
        }
      } else {
        console.warn(
          `⚠️  No workflow found for ${workspace} with patterns: ${workflowPatterns.join(
            ", "
          )}`
        );
      }
    }
  }

  return triggeredWorkflows;
}

function generateJiraTemplate(prUrl, triggeredWorkflows, nextVersion) {
  const workspaceGroups = {
    "coloso-kr": [],
    "coloso-jp": [],
    "coloso-intl": [],
    "coloso-backoffice": [],
  };

  triggeredWorkflows.forEach((wf) => {
    if (workspaceGroups[wf.workspace]) {
      workspaceGroups[wf.workspace].push(wf);
    }
  });

  let template = `h2. Release v${nextVersion}\n\n`;

  // 각 서비스별로 섹션 생성
  const services = [
    { key: "coloso-kr", name: "Korea Service" },
    { key: "coloso-jp", name: "Japan Service" },
    { key: "coloso-intl", name: "International Service" },
    { key: "coloso-backoffice", name: "Backoffice" },
  ];

  services.forEach((service) => {
    const workflows = workspaceGroups[service.key];
    console.log("🔍 Workflows for service:", service.name, workflows);
    if (workflows && workflows.length > 0) {
      template += `h2. ${service.name}\n\n`;
      template += `*Pull Request:* [${prUrl}|${prUrl}|smart-link]\n`;
      template += `*Branch:* {{${TARGET_BRANCH}}}\n`;
      template += `*Actions:* `;

      workflows.forEach((wf, index) => {
        if (index > 0) template += ", ";
        template += `[${wf.workflowName}|${wf.url}]`;
      });

      template += `\n\n`;
    }
  });

  console.log("🔍 JIRA template:", template);

  return template;
}

async function sendToN8n(jiraTemplate, changedWorkspaces) {
  try {
    const payload = {
      jiraTemplate,
      changedWorkspaces,
      timestamp: new Date().toISOString(),
    };

    const response = await fetch(
      `${N8N_URL}/webhook-test/fee0af68-be28-4fa5-96e2-8afe603a2835`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    console.log("✅ Successfully sent to n8n webhook");
    return true;
  } catch (error) {
    console.error("❌ Failed to send to n8n webhook:", error.message);
    return false;
  }
}

async function getChangedWorkspaces(files) {
  const changedWorkspaces = files.map((file) => {
    if (file.filename.includes("coloso-")) {
      return file.filename.split("/")[0];
    }
    return null;
  });
  return changedWorkspaces.filter((ws) => ws !== null);
}

async function run() {
  const lastTag = await getLastTag();
  const { commits, files } = await getCommitsSince(lastTag);

  const nextVersion = bumpVersion(
    lastTag.replace(/^v?/, ""),
    commits.join("\n")
  );

  const changedWorkspaces = await getChangedWorkspaces(files);
  const noteMd = await generateReleaseNotes(commits, changedWorkspaces);

  await octo.request("POST /repos/{owner}/{repo}/releases", {
    owner: OWNER,
    repo: REPO,
    tag_name: nextVersion,
    name: nextVersion,
    generate_release_notes: true,
  });

  const branch = `release/${dayjs().format(
    "YYYY-MM-DD-HHmmss"
  )}-v${nextVersion}`;

  const { data: mainRef } = await octo.request(
    "GET /repos/{owner}/{repo}/git/ref/{ref}",
    {
      owner: OWNER,
      repo: REPO,
      ref: `heads/${BASE_BRANCH}`,
    }
  );

  await octo.request("POST /repos/{owner}/{repo}/git/refs", {
    owner: OWNER,
    repo: REPO,
    ref: `refs/heads/${branch}`,
    sha: mainRef.object.sha,
    headers: {
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  const { data: pr } = await octo.request("POST /repos/{owner}/{repo}/pulls", {
    owner: OWNER,
    repo: REPO,
    title: `Release v${nextVersion}`,
    head: branch,
    base: TARGET_BRANCH,
    body: `## v${nextVersion}\n\n${noteMd}\n\n### Changed Workspaces\n${changedWorkspaces
      .map((ws) => `- ${WORKSPACE_MAPPING[ws] || ws}`)
      .join("\n")}`,
  });

  console.log(`✅ Release PR opened for v${nextVersion}: ${pr.html_url}`);

  if (changedWorkspaces.length > 0) {
    const workflows = await getWorkflows();
    const triggeredWorkflows = await triggerWorkflows(
      changedWorkspaces,
      workflows
    );

    const jiraTemplate = generateJiraTemplate(
      pr.html_url,
      triggeredWorkflows,
      nextVersion
    );

    await sendToN8n(jiraTemplate, changedWorkspaces);
  }

  if (process.env["GITHUB_OUTPUT"]) {
    fs.appendFileSync(
      process.env["GITHUB_OUTPUT"],
      `pr_url=${pr.html_url}\ndeployed_workspaces=${changedWorkspaces.join(
        ","
      )}\n`
    );
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
