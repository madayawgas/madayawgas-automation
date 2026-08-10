const { google } = require("googleapis");
const { execFileSync } = require("child_process");

const ORGANIZATION = "madayawgas";
const PROJECT_NUMBER = 4;
const SHEET_NAME = "Sprint Backlog";

// Sprint Backlog columns, zero-based.
const COLUMNS = {
  pbId: 2, // C
  githubIssue: 3, // D
  githubRepo: 4, // E
  module: 5, // F
  functionality: 6, // G
  userStory: 7, // H
};

/*
 * Google Sheets error values that should be treated
 * as missing/empty values.
 */
const SPREADSHEET_ERRORS = new Set([
  "#N/A",
  "#REF!",
  "#VALUE!",
  "#DIV/0!",
  "#NAME?",
  "#NUM!",
  "#NULL!",
]);

/*
 * Clean a value read from Google Sheets.
 *
 * Converts:
 *   blank       → ""
 *   "#N/A"      → ""
 *   "#REF!"     → ""
 *   etc.
 *
 * Everything else is returned as a trimmed string.
 */
function cleanCellValue(value) {
  if (value === undefined || value === null) {
    return "";
  }

  const normalized = String(value).trim();

  if (!normalized) {
    return "";
  }

  if (SPREADSHEET_ERRORS.has(normalized.toUpperCase())) {
    return "";
  }

  return normalized;
}

function runGitHub(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
  }).trim();
}

function getGoogleAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function getSheetData(sheets, spreadsheetId) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SHEET_NAME}'!A:L`,
  });

  return response.data.values || [];
}

/*
 * Get Project #4 information.
 *
 * We need:
 *   - Project ID
 *   - Status field
 *   - Product Backlog status option
 *   - Module field
 */
function getProjectInfo() {
  const query = `
    query($organization: String!, $projectNumber: Int!) {
      organization(login: $organization) {
        projectV2(number: $projectNumber) {
          id

          fields(first: 100) {
            nodes {
              __typename

              ... on ProjectV2SingleSelectField {
                id
                name

                options {
                  id
                  name
                }
              }

              ... on ProjectV2Field {
                id
                name
              }
            }
          }
        }
      }
    }
  `;

  const output = runGitHub([
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    `organization=${ORGANIZATION}`,
    "-F",
    `projectNumber=${PROJECT_NUMBER}`,
  ]);

  const response = JSON.parse(output);

  if (response.errors) {
    throw new Error(
      `GitHub GraphQL error:\n${JSON.stringify(response.errors, null, 2)}`,
    );
  }

  const project = response.data.organization.projectV2;

  if (!project) {
    throw new Error(
      `Project #${PROJECT_NUMBER} was not found in ${ORGANIZATION}.`,
    );
  }

  /*
   * Find Status field.
   */
  const statusField = project.fields.nodes.find(
    (field) =>
      field.__typename === "ProjectV2SingleSelectField" &&
      field.name === "Status",
  );

  if (!statusField) {
    throw new Error(
      `Could not find the Status field in Project #${PROJECT_NUMBER}.`,
    );
  }

  /*
   * Find Product Backlog status option.
   */
  const productBacklogOption = statusField.options.find(
    (option) => option.name === "Product Backlog",
  );

  if (!productBacklogOption) {
    throw new Error(`Could not find "Product Backlog" in the Status field.`);
  }

  /*
   * Find Module field.
   */
  const moduleField = project.fields.nodes.find(
    (field) =>
      field.name === "Module" &&
      (field.__typename === "ProjectV2Field" ||
        field.__typename === "ProjectV2SingleSelectField"),
  );

  if (!moduleField) {
    throw new Error(
      `Could not find the "Module" field in Project #${PROJECT_NUMBER}.`,
    );
  }

  return {
    projectId: project.id,

    statusFieldId: statusField.id,
    productBacklogOptionId: productBacklogOption.id,

    moduleFieldId: moduleField.id,
  };
}

/*
 * Create a GitHub Issue.
 *
 * Functionality → Issue title
 * User Story    → Issue body/description
 *
 * Returns:
 * {
 *   number,
 *   url
 * }
 */
function createGitHubIssue(repo, title, userStory) {
  console.log(`Creating issue in ${repo}: "${title}"`);

  /*
   * Use the User Story as the GitHub Issue
   * description.
   *
   * If User Story is empty, use a simple
   * fallback description.
   */
  const body = userStory || "Created from the Sprint Backlog.";

  const output = runGitHub([
    "issue",
    "create",
    "--repo",
    repo,
    "--title",
    title,
    "--body",
    body,
  ]);

  const match = output.match(
    /https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)\s*$/,
  );

  if (!match) {
    throw new Error(
      `Could not determine issue number from GitHub output:\n${output}`,
    );
  }

  return {
    number: match[1],
    url: output,
  };
}

/*
 * Get the GitHub Issue node ID.
 *
 * GitHub's Project API needs the internal node ID,
 * not just the issue number.
 */
function getIssueId(repo, issueNumber) {
  const [owner, name] = repo.split("/");

  if (!owner || !name) {
    throw new Error(
      `Invalid GitHub repository: "${repo}". Expected owner/repository.`,
    );
  }

  const query = `
    query(
      $owner: String!,
      $name: String!,
      $number: Int!
    ) {
      repository(owner: $owner, name: $name) {
        issue(number: $number) {
          id
        }
      }
    }
  `;

  const output = runGitHub([
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `number=${issueNumber}`,
  ]);

  const response = JSON.parse(output);

  if (response.errors) {
    throw new Error(
      `Failed to retrieve issue ID:\n${JSON.stringify(
        response.errors,
        null,
        2,
      )}`,
    );
  }

  const issue = response.data.repository.issue;

  if (!issue) {
    throw new Error(`Could not find ${repo} #${issueNumber}.`);
  }

  return issue.id;
}

/*
 * Add the Issue to Project #4.
 */
function addIssueToProject(projectId, issueId) {
  const mutation = `
    mutation(
      $projectId: ID!,
      $contentId: ID!
    ) {
      addProjectV2ItemById(
        input: {
          projectId: $projectId
          contentId: $contentId
        }
      ) {
        item {
          id
        }
      }
    }
  `;

  const output = runGitHub([
    "api",
    "graphql",
    "-f",
    `query=${mutation}`,
    "-f",
    `projectId=${projectId}`,
    "-f",
    `contentId=${issueId}`,
  ]);

  const response = JSON.parse(output);

  if (response.errors) {
    throw new Error(
      `Failed to add issue to Project #${PROJECT_NUMBER}:\n${JSON.stringify(
        response.errors,
        null,
        2,
      )}`,
    );
  }

  return response.data.addProjectV2ItemById.item.id;
}

/*
 * Set Status = Product Backlog.
 */
function setProjectStatus(projectId, itemId, fieldId, optionId) {
  const mutation = `
    mutation(
      $projectId: ID!,
      $itemId: ID!,
      $fieldId: ID!,
      $optionId: String!
    ) {
      updateProjectV2ItemFieldValue(
        input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: {
            singleSelectOptionId: $optionId
          }
        }
      ) {
        projectV2Item {
          id
        }
      }
    }
  `;

  const output = runGitHub([
    "api",
    "graphql",
    "-f",
    `query=${mutation}`,
    "-f",
    `projectId=${projectId}`,
    "-f",
    `itemId=${itemId}`,
    "-f",
    `fieldId=${fieldId}`,
    "-f",
    `optionId=${optionId}`,
  ]);

  const response = JSON.parse(output);

  if (response.errors) {
    throw new Error(
      `Failed to set Status:\n${JSON.stringify(response.errors, null, 2)}`,
    );
  }
}

/*
 * Set Module.
 *
 * Module is a Project text field.
 */
function setModule(projectId, itemId, fieldId, module) {
  /*
   * Empty Module is allowed.
   *
   * There is no reason to make a GitHub API
   * call when there is no Module value.
   */
  if (!module) {
    return;
  }

  const mutation = `
    mutation(
      $projectId: ID!,
      $itemId: ID!,
      $fieldId: ID!,
      $text: String!
    ) {
      updateProjectV2ItemFieldValue(
        input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: {
            text: $text
          }
        }
      ) {
        projectV2Item {
          id
        }
      }
    }
  `;

  const output = runGitHub([
    "api",
    "graphql",
    "-f",
    `query=${mutation}`,
    "-f",
    `projectId=${projectId}`,
    "-f",
    `itemId=${itemId}`,
    "-f",
    `fieldId=${fieldId}`,
    "-f",
    `text=${module}`,
  ]);

  const response = JSON.parse(output);

  if (response.errors) {
    throw new Error(
      `Failed to set Module:\n${JSON.stringify(response.errors, null, 2)}`,
    );
  }
}

/*
 * Write the created issue number into:
 *
 * Sprint Backlog → Github Issue
 * Column D.
 */
async function writeIssueNumber(sheets, spreadsheetId, rowNumber, issueNumber) {
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${SHEET_NAME}'!D${rowNumber}`,
    valueInputOption: "USER_ENTERED",

    requestBody: {
      values: [[issueNumber]],
    },
  });
}

async function main() {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

  if (!spreadsheetId) {
    throw new Error("GOOGLE_SPREADSHEET_ID is not set.");
  }

  if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT is not set.");
  }

  console.log("========================================");
  console.log("Create GitHub Issues from Sprint Backlog");
  console.log("========================================");

  /*
   * Authenticate with Google Sheets.
   */
  const auth = getGoogleAuth();

  const sheets = google.sheets({
    version: "v4",
    auth,
  });

  /*
   * Read Sprint Backlog.
   */
  console.log("\nReading Sprint Backlog...");

  const rows = await getSheetData(sheets, spreadsheetId);

  if (rows.length === 0) {
    throw new Error(`The "${SHEET_NAME}" sheet is empty.`);
  }

  console.log(`Found ${rows.length - 1} spreadsheet rows.`);

  /*
   * Get Project information once.
   */
  console.log("\nReading GitHub Project configuration...");

  const project = getProjectInfo();

  console.log(`Project #${PROJECT_NUMBER} found.`);

  console.log(`Status field: ${project.statusFieldId}`);

  console.log(`Module field: ${project.moduleFieldId}`);

  let created = 0;
  let skipped = 0;

  /*
   * Start at row 2.
   *
   * Row 1 = headers.
   */
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];

    /*
     * Read and clean all relevant cells.
     *
     * This automatically converts #N/A and
     * other spreadsheet errors to "".
     */
    const pbId = cleanCellValue(row[COLUMNS.pbId]);

    const githubIssue = cleanCellValue(row[COLUMNS.githubIssue]);

    const githubRepo = cleanCellValue(row[COLUMNS.githubRepo]);

    const module = cleanCellValue(row[COLUMNS.module]);

    const functionality = cleanCellValue(row[COLUMNS.functionality]);

    const userStory = cleanCellValue(row[COLUMNS.userStory]);

    /*
     * ------------------------------------------
     * Eligibility checks
     * ------------------------------------------
     */

    /*
     * 1. PB ID must exist.
     */
    if (!pbId) {
      skipped++;
      continue;
    }

    /*
     * 2. GitHub Issue must be blank.
     *
     * This prevents duplicates.
     */
    if (githubIssue) {
      console.log(
        `Skipping row ${i + 1}: PB ID ${pbId} already has GitHub Issue #${githubIssue}.`,
      );

      skipped++;
      continue;
    }

    /*
     * 3. GitHub Repo must exist.
     *
     * #N/A is already converted to ""
     * by cleanCellValue().
     */
    if (!githubRepo) {
      console.log(`Skipping row ${i + 1}: PB ID ${pbId} has no GitHub Repo.`);

      skipped++;
      continue;
    }

    /*
     * 4. Functionality must exist.
     *
     * Functionality becomes the GitHub
     * Issue title.
     */
    if (!functionality) {
      console.log(`Skipping row ${i + 1}: PB ID ${pbId} has no Functionality.`);

      skipped++;
      continue;
    }

    /*
     * ------------------------------------------
     * Valid PB
     * ------------------------------------------
     */

    console.log("\n----------------------------------------");
    console.log(`Valid PB found on row ${i + 1}`);
    console.log(`PB ID: ${pbId}`);
    console.log(`Repository: ${githubRepo}`);
    console.log(`Title: ${functionality}`);
    console.log(`Module: ${module || "(empty)"}`);
    console.log(`User Story: ${userStory || "(empty)"}`);

    /*
     * 1. Create GitHub Issue.
     *
     * Functionality → title
     * User Story    → description
     */
    const issue = createGitHubIssue(githubRepo, functionality, userStory);

    console.log(`Created ${githubRepo} #${issue.number}`);

    /*
     * 2. Get internal GitHub Issue ID.
     */
    const issueId = getIssueId(githubRepo, Number(issue.number));

    /*
     * 3. Add Issue to Project #4.
     */
    const projectItemId = addIssueToProject(project.projectId, issueId);

    console.log(`Added #${issue.number} to Project #${PROJECT_NUMBER}.`);

    /*
     * 4. Set Status = Product Backlog.
     */
    setProjectStatus(
      project.projectId,
      projectItemId,
      project.statusFieldId,
      project.productBacklogOptionId,
    );

    console.log(`Set #${issue.number} status to Product Backlog.`);

    /*
     * 5. Set Module.
     */
    setModule(project.projectId, projectItemId, project.moduleFieldId, module);

    if (module) {
      console.log(`Set Module for #${issue.number}: ${module}`);
    }

    /*
     * 6. Write issue number back to Sheets.
     */
    await writeIssueNumber(sheets, spreadsheetId, i + 1, issue.number);

    console.log(`Wrote #${issue.number} to Sprint Backlog row ${i + 1}.`);

    created++;
  }

  console.log("\n========================================");
  console.log("Issue creation complete");
  console.log("========================================");

  console.log(`Issues created: ${created}`);
  console.log(`Rows skipped: ${skipped}`);
}

main().catch((error) => {
  console.error("\nIssue creation failed:");
  console.error(error);

  process.exit(1);
});
