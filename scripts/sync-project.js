const { execFileSync } = require("child_process");

const ORGANIZATION = "madayawgas";
const PROJECT_NUMBER = 4;

const query = `
query($organization: String!, $projectNumber: Int!, $cursor: String) {
  organization(login: $organization) {
    projectV2(number: $projectNumber) {
      id
      number
      title

      items(first: 100, after: $cursor) {
        nodes {
          id

          content {
            __typename

            ... on Issue {
              number
              title
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
              startDate
              duration
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

function runGraphQL(variables) {
  const args = [
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    `organization=${variables.organization}`,
    "-F",
    `projectNumber=${variables.projectNumber}`,
  ];

  if (variables.cursor) {
    args.push("-f", `cursor=${variables.cursor}`);
  } else {
    args.push("-f", "cursor=");
  }

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

function main() {
  const items = [];
  let cursor = null;

  while (true) {
    const response = runGraphQL({
      organization: ORGANIZATION,
      projectNumber: PROJECT_NUMBER,
      cursor,
    });

    const project = response.data.organization.projectV2;

    if (!project) {
      throw new Error(
        `Project #${PROJECT_NUMBER} was not found in organization ${ORGANIZATION}`
      );
    }

    for (const item of project.items.nodes) {
      // Ignore draft issues and pull requests.
      if (!item.content || item.content.__typename !== "Issue") {
        continue;
      }

      const issue = item.content;

      items.push({
        githubRepo: issue.repository.nameWithOwner,
        githubIssue: issue.number,
        title: issue.title,

        module: getFieldValue(item.module),
        sprint: getFieldValue(item.sprint),
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

  console.log(
    JSON.stringify(
      {
        project: {
          organization: ORGANIZATION,
          number: PROJECT_NUMBER,
        },
        items,
      },
      null,
      2
    )
  );
}

main();
