const { google } = require("googleapis");
const { execFileSync } = require("child_process");

const ORGANIZATION = "madayawgas";
const PROJECT_NUMBER = 4;
const SHEET_NAME = "Sprint Backlog";

// Sprint Backlog columns, zero-based.
//
// A = #
// B = Sprint
// C = PB ID
// D = Github Issue
// E = Github Repo
// F = Module
// G = Functionality
// H = User Story
// I = Date Start
// J = Date End
// K = Assigned
// L = Status
const COLUMNS = {
  pbId: 2,          // C
  githubIssue: 3,   // D
  githubRepo: 4,    // E
  module: 5,        // F
  functionality: 6, // G
  userStory: 7,     // H
};

function runGitHub(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
  }).trim();
}

function getGoogleAuth() {
  const credentials = JSON.parse(
    process.env.GOOGLE_SERVICE_ACCOUNT
  );

  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
    ],
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
 *
 * - Project ID
 * - Status field
 * - Product Backlog status option
 * - Module text field
 * - User Story text field
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
      `GitHub GraphQL error:\n${JSON.stringify(
        response.errors,
        null,
        2
      )}`
    );
  }

  const project = response.data.organization.projectV2;

  if (!project) {
    throw new Error(
      `Project #${PROJECT_NUMBER} was not found in ${ORGANIZATION}.`
    );
  }

  /*
   * Find Status field.
   */
  const statusField = project.fields.nodes.find(
    (field) =>
      field.__typename === "ProjectV2SingleSelectField" &&
      field.name === "Status"
  );

  if (!statusField) {
    throw new Error(
      `Could not find the Status field in Project #${PROJECT_NUMBER}.`
    );
  }

  /*
   * Find Product Backlog status option.
   */
  const productBacklogOption = statusField.options.find(
    (option) => option.name === "Product Backlog"
  );

  if (!productBacklogOption) {
    throw new Error(
      `Could not find "Product Backlog" in the Status field.`
    );
  }

  /*
   * Find Module text field.
   */
  const moduleField = project.fields.nodes.find(
    (field) =>
      field.__typename === "ProjectV2Field" &&
      field.name === "Module"
  );

  if (!moduleField) {
    throw new Error(
      `Could not find the "Module" text field in Project #${PROJECT_NUMBER}.`
    );
  }

  /*
   * Find User Story text field.
   */
  const userStoryField = project.fields.nodes.find(
    (field) =>
      field.__typename === "ProjectV2Field" &&
      field.name === "User Story"
  );

  if (!userStoryField) {
    throw new Error(
      `Could not find the "User Story" text field in Project #${PROJECT_NUMBER}.`
    );
  }

  return {
    projectId: project.id,

    statusFieldId: statusField.id,
    productBacklogOptionId: productBacklogOption.id,

    moduleFieldId: moduleField.id,
    userStoryFieldId: userStoryField.id,
  };
}

/*
 * Create a GitHub Issue.
 *
 * Returns:
 *
 * {
 *   number,
 *   url
 * }
 */
function createGitHubIssue(repo, title) {
  console.log(
    `Creating issue in ${repo}: "${title}"`
  );

  const output = runGitHub([
    "issue",
    "create",
    "--repo",
    repo,
    "--title",
    title,
    "--body",
    "Created from the Sprint Backlog.",
  ]);

  const match = output.match(
    /https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)\s*$/
  );

  if (!match) {
    throw new Error(
      `Could not determine issue number from GitHub output:\n${output}`
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
      `Invalid GitHub repository: "${repo}". Expected owner/repository.`
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
        2
      )}`
    );
  }

  const issue = response.data.repository.issue;

  if (!issue) {
    throw new Error(
      `Could not find ${repo} #${issueNumber}.`
    );
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
        2
      )}`
    );
  }

  return response.data.addProjectV2ItemById.item.id;
}

/*
 * Set Status = Product Backlog.
 */
function setProjectStatus(
  projectId,
  itemId,
  fieldId,
  optionId
) {
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
      `Failed to set Status:\n${JSON.stringify(
        response.errors,
        null,
        2
      )}`
    );
  }
}

/*
 * Set a Project text field.
 *
 * This is used for:
 *
 * - Module
 * - User Story
 */
function setProjectTextField(
  projectId,
  itemId,
  fieldId,
  value,
  fieldName
) {
  /*
   * Empty text fields are valid, but there is no reason
   * to make a GitHub API call for an empty value.
   */
  if (!value) {
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
    `text=${value}`,
  ]);

  const response = JSON.parse(output);

  if (response.errors) {
    throw new Error(
      `Failed to set ${fieldName}:\n${JSON.stringify(
        response.errors,
        null,
        2
      )}`
    );
  }
}

/*
 * Write the created issue number into:
 *
 * Sprint Backlog → Github Issue
 *
 * Column D.
 */
async function writeIssueNumber(
  sheets,
  spreadsheetId,
  rowNumber,
  issueNumber
) {
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
  const spreadsheetId =
    process.env.GOOGLE_SPREADSHEET_ID;

  if (!spreadsheetId) {
    throw new Error(
      "GOOGLE_SPREADSHEET_ID is not set."
    );
  }

  if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT is not set."
    );
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

  const rows = await getSheetData(
    sheets,
    spreadsheetId
  );

  if (rows.length === 0) {
    throw new Error(
      `The "${SHEET_NAME}" sheet is empty.`
    );
  }

  console.log(
    `Found ${rows.length - 1} spreadsheet rows.`
  );

  /*
   * Get Project information once.
   */
  console.log(
    "\nReading GitHub Project configuration..."
  );

  const project = getProjectInfo();

  console.log(
    `Project #${PROJECT_NUMBER} found.`
  );

  console.log(
    `Status field: ${project.statusFieldId}`
  );

  console.log(
    `Module field: ${project.moduleFieldId}`
  );

  console.log(
    `User Story field: ${project.userStoryFieldId}`
  );

  let created = 0;
  let skipped = 0;

  /*
   * Start at row 2.
   *
   * Row 1 = headers.
   */
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];

    const pbId =
      row[COLUMNS.pbId]?.trim() || "";

    const githubIssue =
      row[COLUMNS.githubIssue]?.trim() || "";

    const githubRepo =
      row[COLUMNS.githubRepo]?.trim() || "";

    const module =
      row[COLUMNS.module]?.trim() || "";

    const functionality =
      row[COLUMNS.functionality]?.trim() || "";

    const userStory =
      row[COLUMNS.userStory]?.trim() || "";

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
     * This prevents duplicates when the issue
     * has already been successfully linked.
     */
    if (githubIssue) {
      console.log(
        `Skipping row ${i + 1}: PB ID ${pbId} already has GitHub Issue #${githubIssue}.`
      );

      skipped++;
      continue;
    }

    /*
     * 3. GitHub Repo must exist.
     */
    if (!githubRepo) {
      console.log(
        `Skipping row ${i + 1}: PB ID ${pbId} has no GitHub Repo.`
      );

      skipped++;
      continue;
    }

    /*
     * 4. Functionality must exist.
     *
     * This becomes the GitHub Issue title.
     */
    if (!functionality) {
      console.log(
        `Skipping row ${i + 1}: PB ID ${pbId} has no Functionality.`
      );

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
     */
    const issue = createGitHubIssue(
      githubRepo,
      functionality
    );

    console.log(
      `Created ${githubRepo} #${issue.number}`
    );

    /*
     * 2. Get internal GitHub Issue ID.
     */
    const issueId = getIssueId(
      githubRepo,
      Number(issue.number)
    );

    /*
     * 3. Add Issue to Project #4.
     */
    const projectItemId =
      addIssueToProject(
        project.projectId,
        issueId
      );

    console.log(
      `Added #${issue.number} to Project #${PROJECT_NUMBER}.`
    );

    /*
     * 4. Set Status = Product Backlog.
     */
    setProjectStatus(
      project.projectId,
      projectItemId,
      project.statusFieldId,
      project.productBacklogOptionId
    );

    console.log(
      `Set #${issue.number} status to Product Backlog.`
    );

    /*
     * 5. Set Module.
     *
     * Sprint Backlog column F
     * → GitHub Project Module field
     */
    setProjectTextField(
      project.projectId,
      projectItemId,
      project.moduleFieldId,
      module,
      "Module"
    );

    if (module) {
      console.log(
        `Set Module for #${issue.number}: ${module}`
      );
    }

    /*
     * 6. Set User Story.
     *
     * Sprint Backlog column H
     * → GitHub Project User Story field
     */
    setProjectTextField(
      project.projectId,
      projectItemId,
      project.userStoryFieldId,
      userStory,
      "User Story"
    );

    if (userStory) {
      console.log(
        `Set User Story for #${issue.number}.`
      );
    }

    /*
     * 7. Write issue number back to Sheets.
     *
     * Sprint Backlog column D.
     */
    await writeIssueNumber(
      sheets,
      spreadsheetId,
      i + 1,
      issue.number
    );

    console.log(
      `Wrote #${issue.number} to Sprint Backlog row ${i + 1}.`
    );

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
