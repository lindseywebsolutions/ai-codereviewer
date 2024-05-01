import { readFileSync } from 'fs';
import * as core from '@actions/core';
import OpenAI from 'openai';
import { Octokit } from '@octokit/rest';
import parseDiff = require('parse-diff');
import { ChatCompletionCreateParamsNonStreaming } from 'openai/resources';
import { RequestError } from '@octokit/request-error';

const GITHUB_TOKEN = core.getInput('GITHUB_TOKEN');
const OPENAI_API_KEY = core.getInput('OPENAI_API_KEY');
const OPENAI_API_MODEL = core.getInput('OPENAI_API_MODEL');
const MAX_TOKENS = Number(core.getInput('max_tokens'));

const octokit = new Octokit({ auth: GITHUB_TOKEN });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const getEventPayload = () => {
  const eventPath = process.env.GITHUB_EVENT_PATH || '';
  try {
    return JSON.parse(readFileSync(eventPath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read or parse event data: ${error}`);
  }
};

const getPRDetails = async () => {
  try {
    const eventPath = process.env.GITHUB_EVENT_PATH || '';
    const eventData = JSON.parse(readFileSync(eventPath, 'utf8'));
    const { pull_request } = eventData;
    const { owner, repo } = pull_request.base.repo;

    return {
      owner: owner.login,
      repo: repo.name,
      pull_number: pull_request.number,
      title: pull_request.title,
      description: pull_request.body,
      action: eventData.action
    };
  } catch (error) {
    console.error(`Error retrieving PR details: ${error}`);
    throw new Error(`Failed to get PR details: ${error.message}`);
  }
};

const calculatePRScore = ({ linesAdded, linesDeleted, linesChanged, filesChanged }) =>
  0.5 * linesAdded + 0.3 * linesDeleted + 0.2 * linesChanged - 5 * filesChanged;

const extractDiffStats = (parsedDiff) => {
  let stats = { linesAdded: 0, linesDeleted: 0, linesChanged: 0, filesChanged: parsedDiff.length };
  parsedDiff.forEach(file => file.chunks.forEach(chunk => chunk.changes.forEach(change => {
    if (change.add) stats.linesAdded++;
    else if (change.del) stats.linesDeleted++;
    else stats.linesChanged++;
  })));
  return stats;
};

const getDiff = async (owner: string, repo: string, pull_number: number): Promise<string> => {
  try {
    const response = await octokit.pulls.get({
      owner, 
      repo, 
      pull_number,
      mediaType: { format: 'diff' }
    });
    return (response.data as unknown) as string;
  } catch (error) {
    core.error(`Failed to fetch diff: ${error}`);
    if (error instanceof RequestError) {
      throw new Error(`Error fetching diff: ${error.message}, Status: ${error.status}`);
    } else {
      throw new Error(`Unexpected error when fetching diff: ${error}`);
    }
  }
};

const analyzeCode = async (parsedDiff, prDetails) => {
  const comments = [];

  for (const file of parsedDiff) {
    if (file.to === '/dev/null') continue;
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponses = await getAIResponse(prompt);

      if (aiResponses) {
        for (const response of aiResponses) {
          const fix = await suggestCodeFix(file, chunk, response);
          const fullComment = `${response.reviewComment}\n\nSuggested Fix:\n\`\`\`typescript\n${fix}\n\`\`\``;
          comments.push({ body: fullComment, path: file.to, line: Number(response.lineNumber), diff_hunk: chunk.content });
        }
      }
    }
  }
  return comments;
};

const createPrompt = (file, chunk, prDetails) => `
You are an AI tasked with reviewing GitHub pull requests. Follow these guidelines for your review:
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
${chunk.changes.map(c => `${c.ln || c.ln2} ${c.content}`).join('\n')}
\`\`\`

Please ensure your review comments are specific, actionable, and relevant to the changes made.`;

const getAIResponse = async (prompt) => {
  try {
    const params: ChatCompletionCreateParamsNonStreaming = {
      model: OPENAI_API_MODEL,
      temperature: 0.2,
      max_tokens: MAX_TOKENS,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
      messages: [{ role: 'system', content: prompt }],
      response_format: { type: 'json_object' },
    };
    const response = await openai.chat.completions.create(params);
    const rawResponse = response.choices[0].message?.content || '';
    console.log('Raw AI Response:', rawResponse);

    if (rawResponse) {
        return JSON.parse(rawResponse).reviews || [];
    } else {
        console.warn('Received an empty or invalid response from AI.');
        return [];
    }
  } catch (error) {
    console.error('Error in getAIResponse:', error);
    if (error instanceof SyntaxError) {
        console.error('JSON Parsing Error:', error.message);
    }
    return [];
  }
};

const createReviewComment = async (owner, repo, pull_number, comments) => {
  try {
    await octokit.pulls.createReview({
      owner, repo, pull_number, comments, event: 'COMMENT',
    });
  } catch (error) {
    console.error('Error creating review comment:', error);
  }
};

const fetchExistingComments = async (owner, repo, pull_number) => {
  try {
    const { data: existingComments } = await octokit.pulls.listReviewComments({ owner, repo, pull_number });
    return existingComments;
  } catch (error) {
    console.error('Error fetching existing comments:', error);
    return [];
  }
};

const fetchAndResolveExistingComments = async (owner, repo, pull_number) => {
  try {
    const existingComments = await fetchExistingComments(owner, repo, pull_number);
    await resolveExistingComments(owner, repo, pull_number, existingComments);
  } catch (error) {
    console.error('Error resolving comments:', error);
  }
};

const resolveExistingComments = async (owner, repo, pull_number, existingComments) => {
  try {
    for (const comment of existingComments) {
      await octokit.pulls.updateReviewComment({
        owner, repo, comment_id: comment.id, body: `${comment.body}\n\n> **Resolved automatically by system.**`,
      });
    }
  } catch (error) {
    console.error('Error resolving comments:', error);
  }
}

const postReviewComments = async (owner, repo, pull_number, comments) => {
  try {
    await octokit.pulls.createReview({
      owner, repo, pull_number, comments, event: 'COMMENT',
    });
    console.log('Review comments posted successfully.');
  } catch (error) {
    console.error('Error posting review comments:', error);
  }
};

const suggestCodeFix = async (file, chunk, aiResponse) => {
  const prompt = `
Given the following code snippet and a critique, suggest a fix:
Code Snippet:
\`\`\`typescript
${chunk.content}
\`\`\`
Critique: ${aiResponse.reviewComment}
Please provide a TypeScript code suggestion that addresses this critique.`;

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
    console.error('Error in suggestCodeFix:', error);
    return 'Unable to generate a fix.';
  }
};

const fetchDiff = async (owner, repo, pull_number) => {
  try {
    const response = await octokit.pulls.get({
      owner, 
      repo, 
      pull_number,
      mediaType: { format: 'diff' }
    });
    // Ensure the response.data is treated as a string
    if (typeof response.data !== 'string') {
      throw new Error('Expected diff to be a string, but received a different type.');
    }
    return response.data;
  } catch (error) {
    core.error(`Failed to fetch diff: ${error}`);
    if (error instanceof RequestError) {
      throw new Error(`Error fetching diff: ${error.message}, Status: ${error.status}`);
    } else {
      throw new Error(`Unexpected error when fetching diff: ${error}`);
    }
  }
};

const handlePullRequest = async (prDetails) => {
  await fetchAndResolveExistingComments(prDetails.owner, prDetails.repo, prDetails.pull_number);

  const diff = await fetchDiff(prDetails.owner, prDetails.repo, prDetails.pull_number);
  if (!diff) {
    console.log('No diff found');
    return;
  }

  const parsedDiff = parseDiff(diff);
  const comments = await analyzeCode(parsedDiff, prDetails);
  const score = calculatePRScore(extractDiffStats(parsedDiff));
  console.log('PR Score:', score);

  const scoreComment = createScoreComment(score);
  comments.push({ body: scoreComment, path: '', line: 0 });

  if (comments.length > 0) {
    await postReviewComments(prDetails.owner, prDetails.repo, prDetails.pull_number, comments);
  }
};

const createScoreComment = (score) => {
  return `### Pull Request Score: ${score}
![Progress](https://progress-bar.dev/${Math.min(Math.max(score, 0), 100)}?scale=100&width=400&color=brightgreen&suffix=%)`;
};

const main = async () => {
  try {
    const prDetails = await getPRDetails();
    if (!['opened', 'synchronize'].includes(prDetails.action)) {
      console.log('Unsupported event:', prDetails.action);
      return;
    }

    await handlePullRequest(prDetails);
  } catch (error) {
    console.error('Unhandled error in main:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
