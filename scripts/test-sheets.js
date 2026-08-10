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

  console.log("Spreadsheet ID:", spreadsheetId);

  try {
    const response = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "spreadsheetId,properties.title,sheets.properties",
    });

    console.log("Spreadsheet found!");
    console.log(JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error("Failed to find spreadsheet:");
    console.error("Status:", error.response?.status);
    console.error("Message:", error.response?.data?.error?.message);
    console.error(
      "Details:",
      JSON.stringify(error.response?.data?.error, null, 2)
    );

    process.exit(1);
  }
}

main();
