import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import { Chunk, File } from "parse-diff";
import parseDiff = require("parse-diff");
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");
const MAX_TOKENS: number = Number(core.getInput("max_tokens"));

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response?.data;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue;
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  return `You are an AI tasked with reviewing GitHub pull requests. Follow these guidelines for your review:
- Respond in JSON format: {"reviews": [{"lineNumber": <line_number>, "reviewComment": "<review_comment>"}]}
- Only provide critique; do not include compliments or positive feedback.
- Comment only when improvement is necessary. If no issues are found, return an empty "reviews" array.
- Use GitHub Markdown format for comments.
- Base your review on the code and the context provided by the pull request details. Do not suggest adding code comments.

Review the following code changes in the file "${file.to}" considering the pull request title and description.

Pull request title: ${prDetails.title}
Pull request description:
---
${prDetails.description}
---

Code diff to review:
\`\`\`diff
${chunk.content}
${chunk.changes
  .map((c: any) => `${c.ln || c.ln2} ${c.content}`)
  .join("\n")}
\`\`\`

Please ensure your review comments are specific, actionable, and relevant to the changes made.`;
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: MAX_TOKENS,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    const response = await openai.chat.completions.create({
      ...queryConfig,
      // return JSON if the model supports it:
      ...(OPENAI_API_MODEL === "gpt-4-turbo-preview" || OPENAI_API_MODEL === "gpt-4-turbo" || OPENAI_API_MODEL === "gpt-3.5-turbo" || OPENAI_API_MODEL === "gpt-4-0125-preview" || OPENAI_API_MODEL === "gpt-4-1106-preview" || OPENAI_API_MODEL === "gpt-3.5-turbo-0125" || OPENAI_API_MODEL === "gpt-3.5-turbo-1106"
        ? { response_format: { type: "json_object" } }
        : {}),
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    const res = response.choices[0].message?.content?.trim() || "{}";
    console.log("AI Response:", res);

    const parsed = JSON.parse(res);
    const reviews = parsed?.reviews;

    console.log("AI Reviews:", reviews);
    
    return reviews;
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
}

function createComment(file: File, chunk: Chunk, aiResponses: Array<{
  lineNumber: string,
  reviewComment: string
}>): Array<{ body: string; path: string; line: number; diff_hunk: string }> {
  return aiResponses.flatMap((aiResponse) => {
      if (!file.to) {
          return [];
      }
      const diffHunk = chunk.content;  // You might need to adjust this to match GitHub's expected format
      return {
          body: aiResponse.reviewComment,
          path: file.to,
          line: Number(aiResponse.lineNumber),
          diff_hunk: diffHunk  // Adding diff hunk here
      };
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

async function fetchAndResolveExistingComments(owner: string, repo: string, pull_number: number) {
  const { data: existingComments } = await octokit.pulls.listReviewComments({
    owner,
    repo,
    pull_number,
  });
  
  for (const comment of existingComments) {
    await octokit.pulls.updateReviewComment({
      owner,
      repo,
      comment_id: comment.id,
      body: comment.body + "\n\n> **Resolved automatically by system.**",
    });
  }
}

async function main() {
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  if (eventData.action === "opened" || eventData.action === "synchronize") {
    // Resolve existing comments before processing new diff
    await fetchAndResolveExistingComments(prDetails.owner, prDetails.repo, prDetails.pull_number);

    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );

    if (!diff) {
      console.log("No diff found");
      return;
    }

    const parsedDiff = parseDiff(diff);
    const excludePatterns = core.getInput("exclude").split(",").map((s) => s.trim());
    const filteredDiff = parsedDiff.filter((file) => {
      return !excludePatterns.some((pattern) => minimatch(file.to ?? "", pattern));
    });

    const comments = await analyzeCode(filteredDiff, prDetails);
    if (comments.length > 0) {
      await createReviewComment(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number,
        comments
      );
    }
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
