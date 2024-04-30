"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const core = require("@actions/core");
const openai_1 = require("openai");
const rest_1 = require("@octokit/rest");
const parseDiff = require("parse-diff");
const minimatch_1 = require("minimatch");
const GITHUB_TOKEN = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL = core.getInput("OPENAI_API_MODEL");
const MAX_TOKENS = Number(core.getInput("max_tokens"));
const octokit = new rest_1.Octokit({ auth: GITHUB_TOKEN });
const openai = new openai_1.default({
    apiKey: OPENAI_API_KEY,
});
async function getPRDetails() {
    var _a, _b;
    const { repository, number } = JSON.parse((0, fs_1.readFileSync)(process.env.GITHUB_EVENT_PATH || "", "utf8"));
    const prResponse = await octokit.pulls.get({
        owner: repository.owner.login,
        repo: repository.name,
        pull_number: number,
    });
    return {
        owner: repository.owner.login,
        repo: repository.name,
        pull_number: number,
        title: (_a = prResponse.data.title) !== null && _a !== void 0 ? _a : "",
        description: (_b = prResponse.data.body) !== null && _b !== void 0 ? _b : "",
    };
}
async function getDiff(owner, repo, pull_number) {
    const response = await octokit.pulls.get({
        owner,
        repo,
        pull_number,
        mediaType: { format: "diff" },
    });
    // @ts-expect-error - response.data is a string
    return response === null || response === void 0 ? void 0 : response.data;
}
async function analyzeCode(parsedDiff, prDetails) {
    const comments = [];
    for (const file of parsedDiff) {
        if (file.to === "/dev/null")
            continue;
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
function createPrompt(file, chunk, prDetails) {
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
        .map((c) => `${c.ln || c.ln2} ${c.content}`)
        .join("\n")}
\`\`\`

Please ensure your review comments are specific, actionable, and relevant to the changes made.`;
}
async function getAIResponse(prompt) {
    var _a, _b;
    let rawResponse = "";
    try {
        const params = {
            model: OPENAI_API_MODEL,
            temperature: 0.2,
            max_tokens: MAX_TOKENS,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0,
            messages: [{ role: "system", content: prompt }],
            response_format: {
                type: "json_object"
            }
        };
        const options = {
            timeout: 60000,
        };
        const response = await openai.chat.completions.create(params, options);
        rawResponse = (_b = (_a = response.choices[0].message) === null || _a === void 0 ? void 0 : _a.content) === null || _b === void 0 ? void 0 : _b.trim();
        console.log("Raw AI Response:", rawResponse);
    }
    catch (error) {
        console.error("Error in getAIResponse:", error);
        return null;
    }
    try {
        const parsed = JSON.parse(rawResponse);
        console.log("Parsed Reviews:", parsed === null || parsed === void 0 ? void 0 : parsed.reviews);
        return parsed === null || parsed === void 0 ? void 0 : parsed.reviews;
    }
    catch (parseError) {
        console.error("Parsing Error:", parseError);
        console.error("Faulty JSON:", rawResponse);
        return null;
    }
}
function createComment(file, chunk, aiResponses) {
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
async function createReviewComment(owner, repo, pull_number, comments) {
    await octokit.pulls.createReview({
        owner,
        repo,
        pull_number,
        comments,
        event: "COMMENT",
    });
}
async function fetchAndResolveExistingComments(owner, repo, pull_number) {
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
    var _a;
    const prDetails = await getPRDetails();
    let diff;
    const eventData = JSON.parse((0, fs_1.readFileSync)((_a = process.env.GITHUB_EVENT_PATH) !== null && _a !== void 0 ? _a : "", "utf8"));
    if (eventData.action === "opened" || eventData.action === "synchronize") {
        // Resolve existing comments before processing new diff
        await fetchAndResolveExistingComments(prDetails.owner, prDetails.repo, prDetails.pull_number);
        diff = await getDiff(prDetails.owner, prDetails.repo, prDetails.pull_number);
        if (!diff) {
            console.log("No diff found");
            return;
        }
        const parsedDiff = parseDiff(diff);
        const excludePatterns = core.getInput("exclude").split(",").map((s) => s.trim());
        const filteredDiff = parsedDiff.filter((file) => {
            return !excludePatterns.some((pattern) => { var _a; return (0, minimatch_1.default)((_a = file.to) !== null && _a !== void 0 ? _a : "", pattern); });
        });
        const comments = await analyzeCode(filteredDiff, prDetails);
        if (comments.length > 0) {
            await createReviewComment(prDetails.owner, prDetails.repo, prDetails.pull_number, comments);
        }
    }
    else {
        console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
        return;
    }
}
main().catch((error) => {
    console.error("Error:", error);
    process.exit(1);
});
//# sourceMappingURL=main.js.map