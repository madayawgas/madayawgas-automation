const { execFileSync } = require("child_process");
const { google } = require("googleapis");

const ORGANIZATION = "madayawgas";
const PROJECT_NUMBER = 4;
const SHEET_NAME = "Sprint Backlog";

// A-L
const COLUMNS = {
  sprint: 1,        // B
  githubIssue: 3,   // D
  githubRepo: 4,    // E
  module: 5,        // F
  dateStart: 8,     // I
  dateEnd: 9,       // J
  assigned: 10,     // K
  status: 11,       // L
};

const GITHUB_QUERY = `
query($organization: String!, $projectNumber: Int!, $cursor: String) {
  organization(login: $organization) {
    projectV2(number: $projectNumber) {
      items(first: 100, after: $cursor) {
        nodes {
          content {
            __typename

            ... on Issue {
              number
              repository {
                nameWithOwner
              }

              assignees(first: 20) {
                nodes {
                  login
                }
              }
            }
          }

          status: fieldValueByName(name: "Status") {
            __typename

            ... on ProjectV2ItemFieldSingleSelectValue {
              name
            }
          }

          sprint: fieldValueByName(name: "Sprint") {
            __typename

            ... on ProjectV2ItemFieldIterationValue {
              title
            }
          }

          module: fieldValueByName(name: "Module") {
            __typename

            ... on ProjectV2ItemFieldTextValue {
              text
            }

            ... on ProjectV2ItemFieldSingleSelectValue {
              name
            }
          }
        }

        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}
`;

function runGitHubGraphQL(cursor = "") {
  const args = [
    "api",
    "graphql",
    "-f",
    `query=${GITHUB_QUERY}`,
    "-f",
    `organization=${ORGANIZATION}`,
    "-F",
    `projectNumber=${PROJECT_NUMBER}`,
    "-f",
    `cursor=${cursor}`,
  ];

  const output = execFileSync("gh", args, {
    encoding: "utf8",
  });

  return JSON.parse(output);
}

function getFieldValue(field) {
  if (!field) return "";

  if (field.__typename === "ProjectV2ItemFieldTextValue") {
    return field.text ?? "";
  }

  if (field.__typename === "ProjectV2ItemFieldSingleSelectValue") {
    return field.name ?? "";
  }

  if (field.__typename === "ProjectV2ItemFieldIterationValue") {
    return field.title ?? "";
  }

  return "";
}

function getGitHubItems() {
  const items = [];
  let cursor = "";

  while (true) {
    const response = runGitHubGraphQL(cursor);

    if (response.errors) {
      throw new Error(
        `GitHub GraphQL error:\n${JSON.stringify(response.errors, null, 2)}`
      );
    }

    const project = response.data.organization.projectV2;

    if (!project) {
      throw new Error(
        `Project #${PROJECT_NUMBER} was not found in ${ORGANIZATION}.`
      );
    }

    for (const item of project.items.nodes) {
      // Only process GitHub Issues.
      if (!item.content || item.content.__typename !== "Issue") {
        continue;
      }

      const issue = item.content;

      items.push({
        githubRepo: issue.repository.nameWithOwner,
        githubIssue: String(issue.number),

        sprint: getFieldValue(item.sprint),
        module: getFieldValue(item.module),
        status: getFieldValue(item.status),

        assignees: issue.assignees.nodes.map(
          (assignee) => assignee.login
        ),
      });
    }

    if (!project.items.pageInfo.hasNextPage) {
      break;
    }

    cursor = project.items.pageInfo.endCursor;
  }

  return items;
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

function getToday() {
  return new Date().toISOString().slice(0, 10);
}

function getAssignees(assignees) {
  return assignees.join(", ");
}

async function updateRow(
  sheets,
  spreadsheetId,
  rowNumber,
  row,
  githubItem
) {
  const updates = [];

  /*
   * Only update a field if GitHub actually has a value.
   *
   * This prevents:
   *
   * GitHub Module = ""
   *       ↓
   * Sheet Module gets erased
   *
   * Instead, the existing Sheet value is preserved.
   */

  if (githubItem.sprint) {
    updates.push({
      range: `'${SHEET_NAME}'!B${rowNumber}`,
      value: githubItem.sprint,
    });
  }

  if (githubItem.module) {
    updates.push({
      range: `'${SHEET_NAME}'!F${rowNumber}`,
      value: githubItem.module,
    });
  }

  if (githubItem.assignees.length > 0) {
    updates.push({
      range: `'${SHEET_NAME}'!K${rowNumber}`,
      value: getAssignees(githubItem.assignees),
    });
  }

  if (githubItem.status) {
    updates.push({
      range: `'${SHEET_NAME}'!L${rowNumber}`,
      value: githubItem.status,
    });
  }

  /*
   * Date Start:
   *
   * Only set when the GitHub status is In progress
   * AND the Sheet does not already have a start date.
   */
  const currentDateStart = row[COLUMNS.dateStart] || "";

  if (githubItem.status === "In progress" && !currentDateStart) {
    updates.push({
      range: `'${SHEET_NAME}'!I${rowNumber}`,
      value: getToday(),
    });
  }

  /*
   * Date End:
   *
   * Only set when the GitHub status is Done
   * AND the Sheet does not already have an end date.
   */
  const currentDateEnd = row[COLUMNS.dateEnd] || "";

  if (githubItem.status === "Done" && !currentDateEnd) {
    updates.push({
      range: `'${SHEET_NAME}'!J${rowNumber}`,
      value: getToday(),
    });
  }

  if (updates.length === 0) {
    return;
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",

      data: updates.map((update) => ({
        range: update.range,
        values: [[update.value]],
      })),
    },
  });

  console.log(
    `Updated row ${rowNumber}: ${githubItem.githubRepo} #${githubItem.githubIssue}`
  );
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
  console.log("GitHub → Google Sheets Synchronization");
  console.log("========================================");

  console.log("\nReading GitHub Project...");

  const githubItems = getGitHubItems();

  console.log(`Found ${githubItems.length} GitHub issues.`);

  console.log("\nConnecting to Google Sheets...");

  const auth = getGoogleAuth();

  const sheets = google.sheets({
    version: "v4",
    auth,
  });

  const rows = await getSheetData(sheets, spreadsheetId);

  if (rows.length === 0) {
    throw new Error(`The "${SHEET_NAME}" sheet is empty.`);
  }

  console.log(`Found ${rows.length - 1} spreadsheet rows.`);

  let linkedRows = 0;
  let updatedRows = 0;
  let skippedRows = 0;

  /*
   * Start at row 2.
   * Row 1 contains the headers.
   */
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];

    const githubIssue = row[COLUMNS.githubIssue]?.trim();
    const githubRepo = row[COLUMNS.githubRepo]?.trim();

    /*
     * No GitHub Issue or Repo means this PBI
     * has not been linked to GitHub yet.
     *
     * This is intentional:
     *
     * Sheets-only planning row → IGNORE
     */
    if (!githubIssue || !githubRepo) {
      skippedRows++;
      continue;
    }

    linkedRows++;

    /*
     * Match using BOTH repository and issue number.
     */
    const githubItem = githubItems.find(
      (item) =>
        item.githubIssue === githubIssue &&
        item.githubRepo === githubRepo
    );

    /*
     * The Sheet says this PBI is linked to GitHub,
     * but GitHub Project doesn't currently contain it.
     *
     * Don't modify anything.
     */
    if (!githubItem) {
      console.log(
        `No GitHub Project match: ${githubRepo} #${githubIssue}`
      );

      continue;
    }

    const beforeUpdates = JSON.stringify(row);

    await updateRow(
      sheets,
      spreadsheetId,
      i + 1,
      row,
      githubItem
    );

    const afterUpdates = JSON.stringify(row);

    if (beforeUpdates !== afterUpdates) {
      updatedRows++;
    }
  }

  console.log("\n========================================");
  console.log("Synchronization complete");
  console.log("========================================");

  console.log(`Linked Sheet rows: ${linkedRows}`);
  console.log(`Planning-only rows skipped: ${skippedRows}`);
  console.log(`Rows processed: ${updatedRows}`);
}

main().catch((error) => {
  console.error("\nSynchronization failed:");
  console.error(error);
  process.exit(1);
});
