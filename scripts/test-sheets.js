const { google } = require("googleapis");

async function main() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const sheets = google.sheets({
    version: "v4",
    auth,
  });

  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  const range = "Sprint Backlog!A1:M10";

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  console.log("Google Sheets connection successful.");
  console.log(response.data.values);
}

main().catch((error) => {
  console.error("Google Sheets connection failed:");
  console.error(error.message);
  process.exit(1);
});
