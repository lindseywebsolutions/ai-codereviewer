import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import { Chunk, File } from "parse-diff";
import parseDiff = require("parse-diff");
import minimatch from "minimatch";
import { ChatCompletionCreateParamsNonStreaming } from "openai/resources";
import { RequestOptions } from "openai/core";

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
};

async function getPRDetails(): Promise<PRDetails> {
  try {
    const { repository, number } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8"));
    console.log("Repository:", repository);
    console.log("Number:", number);
    const prResponse = await octokit.pulls.get({
      owner: repository.owner.login,
      repo: repository.name,
      pull_number: number,
    });
    return {
      owner: repository.owner.login,
      repo: repository.name,
      pull_number: number,
      title: prResponse.data.title ?? "No Title",
      description: prResponse.data.body ?? "No Description",
    };
  } catch (error) {
    core.error(`Failed to get PR details: ${error}`);
    throw new Error(`Error retrieving PR details: ${error.message}`);
  }
}

function calculatePRScore(diffStats) {
  const { linesAdded, linesDeleted, linesChanged, filesChanged } = diffStats;
  // Weights can be adjusted as per team's code review guidelines
  const score = (0.5 * linesAdded) + (0.3 * linesDeleted) + (0.2 * linesChanged) - (5 * filesChanged);
  return score;
}

function extractDiffStats(parsedDiff) {
  let linesAdded = 0;
  let linesDeleted = 0;
  let linesChanged = 0;
  let filesChanged = parsedDiff.length;

  parsedDiff.forEach(file => {
      file.chunks.forEach(chunk => {
          chunk.changes.forEach(change => {
              if (change.add) linesAdded++;
              else if (change.del) linesDeleted++;
              else linesChanged++;
          });
      });
  });

  return { linesAdded, linesDeleted, linesChanged, filesChanged };
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

async function analyzeCode(parsedDiff: File[], prDetails: PRDetails): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments = [];

  for (const file of parsedDiff) {
      if (file.to === "/dev/null") continue; // Skip deleted files
      for (const chunk of file.chunks) {
          const prompt = createPrompt(file, chunk, prDetails);
          const aiResponses = await getAIResponse(prompt);

          if (aiResponses) {
              for (const response of aiResponses) {
                  const fix = await suggestCodeFix(file, chunk, response);
                  const fullComment = `${response.reviewComment}\n\nSuggested Fix:\n\`\`\`typescript\n${fix}\n\`\`\``;
                  comments.push({
                      body: fullComment,
                      path: file.to,
                      line: Number(response.lineNumber),
                      diff_hunk: chunk.content // Include diff hunk if necessary for context
                  });
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
  try {
    const params: ChatCompletionCreateParamsNonStreaming = {
      model: OPENAI_API_MODEL,
      temperature: 0.2,
      max_tokens: MAX_TOKENS,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
      messages: [{ role: "system", content: prompt }],
      response_format: {
        type: "json_object"
      },
      user: "github-actions",
    };

    const options: RequestOptions = {
      timeout: 60000,
    };

    const response = await openai.chat.completions.create(params, options);
    console.log("API Raw Response:", response); // Log the complete response object for inspection
    const rawResponse = response.choices[0].message?.content || "";
    console.log("Raw AI Response:", rawResponse); // Log the raw response string

    try {
      const parsed = JSON.parse(rawResponse);
      console.log("Parsed Reviews:", parsed?.reviews);
      return parsed?.reviews;
    } catch (parseError) {
      console.error("Parsing Error:", parseError);
      console.error("Faulty JSON:", rawResponse); // More detailed error logging
      return null;
    }
  } catch (error) {
    console.error("Error in getAIResponse:", error);
    return null;
  }
}

function createComment(file: File, chunk: Chunk, aiResponses: Array<{
  lineNumber: string,
  reviewComment: string
}>): Array<{ body: string; path: string; line: number; diff_hunk: string }> {
  return aiResponses.map((response) => {
    const line = Number(response.lineNumber);
    const hunk = chunk.content;

    return {
      body: response.reviewComment,
      path: file.to,
      line: line,
      diff_hunk: hunk
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
  let eventData: any;

  try {
    eventData = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
    );
    console.log("Event Data:", eventData);
  } catch (error) {
    console.error("Error parsing event data:", error);
    return;
  }

  if (eventData.action === "opened" || eventData.action === "synchronize") {
    // Resolve existing comments before processing new diff
    await fetchAndResolveExistingComments(prDetails.owner, prDetails.repo, prDetails.pull_number);

    const diff = await getDiff(prDetails.owner, prDetails.repo, prDetails.pull_number);
    if (!diff) {
        console.log("No diff found");
        return;
    }
    
    const parsedDiff = parseDiff(diff);
    const diffStats = extractDiffStats(parsedDiff);
    const score = calculatePRScore(diffStats);
    
    // Visualization of the score using a markdown progress bar
    const scoreComment = 
      `### Pull Request Score: ${score}\n` +
      `![Progress](https://progress-bar.dev/${Math.min(Math.max(score, 0), 100)}?scale=100&width=400&color=brightgreen&suffix=%)`;

    const comments = await analyzeCode(parsedDiff, prDetails);
    comments.push({ body: scoreComment, path: '', line: 0 });
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

async function suggestCodeFix(file: File, chunk: Chunk, aiResponse: {
  lineNumber: string,
  reviewComment: string
}): Promise<string> {
  const prompt = `
      Given the following code snippet and a critique, suggest a fix:
      Code Snippet:
      \`\`\`typescript
      ${chunk.content}
      \`\`\`
      Critique: ${aiResponse.reviewComment}
      Please provide a TypeScript code suggestion that addresses this critique.
  `;

  try {
      const params = {
          model: OPENAI_API_MODEL,
          prompt: prompt,
          max_tokens: 150,
          temperature: 0.5,
      };

      const response = await openai.completions.create(params);
      return response.choices[0].text.trim();
  } catch (error) {
      console.error("Error in suggestCodeFix:", error);
      return "Unable to generate a fix.";
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
